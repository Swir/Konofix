//! Build-owned first-contact admission, exercised by Windows and Linux Node CI.
//! Syntax/topology checks do not establish ownership or network reachability.
use super::validate_public_host;
use libp2p::{multiaddr::Protocol, Multiaddr, PeerId};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pool {
    schema: u8,
    seeds: Vec<String>,
}

fn check_pool(json: &str) -> Result<usize, String> {
    let pool: Pool = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if pool.schema != 1 || pool.seeds.len() > 32 {
        return Err("Expected schema 1 and at most 32 seed addresses".into());
    }
    // Empty is an explicit infrastructure blocker, not a production-ready pool.
    if pool.seeds.is_empty() {
        return Ok(0);
    }
    let mut seen = HashSet::new();
    let mut peers = HashMap::<PeerId, HashSet<&str>>::new();
    let mut hosts = HashMap::<String, PeerId>::new();
    for raw in pool.seeds {
        let address: Multiaddr = raw.parse().map_err(|e| format!("Invalid seed: {e}"))?;
        if address.to_string() != raw || !seen.insert(raw) {
            return Err("Seeds must be canonical and unique".into());
        }
        let protocols: Vec<_> = address.iter().collect();
        let (host, port, peer, transport) = match protocols.as_slice() {
            [host, Protocol::Tcp(port), Protocol::P2p(peer)] => (host, port, peer, "tcp"),
            [host, Protocol::Udp(port), Protocol::QuicV1, Protocol::P2p(peer)] => {
                (host, port, peer, "quic-v1")
            }
            _ => return Err("Seed must be direct TCP or QUIC-v1 with one final PeerID".into()),
        };
        if *port == 0 {
            return Err("A public entry port cannot be zero".into());
        }
        let host = match host {
            Protocol::Ip4(ip) => ip.to_string(),
            Protocol::Ip6(ip) => ip.to_string(),
            Protocol::Dns(name) | Protocol::Dns4(name) | Protocol::Dns6(name) => {
                name.trim_end_matches('.').to_ascii_lowercase()
            }
            _ => return Err("Seed requires a literal public IP or DNS hostname".into()),
        };
        validate_public_host(&host, false)?;
        if hosts
            .insert(host, *peer)
            .is_some_and(|previous| previous != *peer)
        {
            return Err("Different entry identities must not share one configured host".into());
        }
        peers.entry(*peer).or_default().insert(transport);
    }
    if peers.len() < 3 || peers.values().any(|transports| transports.len() != 2) {
        return Err(
            "A populated pool requires three distinct peers, each with TCP and QUIC-v1".into(),
        );
    }
    Ok(peers.len())
}

#[test]
fn bundled_pool_is_explicitly_empty_or_has_three_dual_transport_contacts() {
    let peers = check_pool(include_str!("../bootstrap-pool.json"))
        .expect("build-owned pool violates deployment admission policy");
    if peers == 0 {
        eprintln!("Bundled pool EMPTY: automatic Internet first contact remains blocked");
    }
    // No DNS queries, probes, evidence or release-state mutations occur here.
}

#[test]
fn rejects_malformed_private_single_peer_and_incomplete_pool_inputs() {
    // Syntactic fixtures only. These addresses are NEVER dialed or shipped as seeds.
    let mut seeds = Vec::new();
    for host in ["8.8.8.8", "1.1.1.1", "9.9.9.9"] {
        let peer = PeerId::random();
        seeds.push(format!("/ip4/{host}/tcp/45555/p2p/{peer}"));
        seeds.push(format!("/ip4/{host}/udp/45555/quic-v1/p2p/{peer}"));
    }
    let encode = |seeds: &[String]| serde_json::json!({"schema": 1, "seeds": seeds}).to_string();
    assert_eq!(check_pool(&encode(&seeds)).unwrap(), 3);
    assert_eq!(check_pool(r#"{"schema":1,"seeds":[]}"#).unwrap(), 0);
    for invalid in [
        r#"{"schema":2,"seeds":[]}"#,
        r#"{"schema":true,"seeds":[]}"#,
        r#"{"schema":1,"seeds":[],"ready":true}"#,
        r#"{"schema":1,"schema":1,"seeds":[]}"#,
        r#"{"schema":1,"seeds":["/dns/fake.invalid/tcp/45555/p2p/PEER_ID"]}"#,
    ] {
        assert!(check_pool(invalid).is_err());
    }
    assert!(check_pool(&encode(&seeds[..2])).is_err());
    assert!(check_pool(&encode(&seeds[..5])).is_err());
    assert!(check_pool(&encode(&vec![seeds[0].clone(); 33])).is_err());
    for replacement in [
        "/ip4/127.0.0.1/tcp/45555",
        "/ip4/100.64.0.1/tcp/45555",
        "/ip4/203.0.113.1/tcp/45555",
        "/dns/example.com/tcp/45555",
        "/dns/fake.invalid/tcp/45555",
        "/ip4/8.8.8.8/tcp/0",
        "/ip4/1.1.1.1/tcp/45555",
    ] {
        let mut invalid = seeds.clone();
        invalid[0] = invalid[0].replace("/ip4/8.8.8.8/tcp/45555", replacement);
        assert!(
            check_pool(&encode(&invalid)).is_err(),
            "accepted {replacement}"
        );
    }
    for suffix in ["/p2p-circuit", "/tcp/1234"] {
        let mut invalid = seeds.clone();
        invalid[0].push_str(suffix);
        assert!(check_pool(&encode(&invalid)).is_err());
    }
    let mut duplicates = seeds.clone();
    duplicates.push(seeds[0].clone());
    assert!(check_pool(&encode(&duplicates)).is_err());
}
