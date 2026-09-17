use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use libp2p::{
    identify, identity,
    multiaddr::Protocol,
    noise, ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::Serialize;

const SOURCE_COMMIT: &str = env!("KONOFIX_SOURCE_COMMIT");
const EXPECTED_PROTOCOL_VERSION: &str = "/konofix/4.0";
const EXPECTED_AGENT_PREFIX: &str = "Konofix-Node/";
const DEFAULT_TIMEOUT_SECONDS: u64 = 20;
const MIN_TIMEOUT_SECONDS: u64 = 5;
const MAX_TIMEOUT_SECONDS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeTransport {
    Tcp,
    QuicV1,
}

impl ProbeTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::QuicV1 => "quic-v1",
        }
    }
}

#[derive(Debug, Clone)]
struct ProbeTarget {
    address: Multiaddr,
    peer_id: PeerId,
    transport: ProbeTransport,
}

#[derive(Debug, Clone)]
struct ProbeArgs {
    target: ProbeTarget,
    timeout: Duration,
}

#[derive(NetworkBehaviour)]
struct ProbeBehaviour {
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

#[derive(Debug, Serialize)]
struct ProbeEvidence {
    schema: u8,
    status: &'static str,
    tool: &'static str,
    version: &'static str,
    source_commit: &'static str,
    transport: &'static str,
    target: String,
    expected_peer_id: String,
    observed_peer_id: String,
    protocol_version: String,
    agent_version: String,
    rtt_micros: u64,
    elapsed_millis: u64,
    timestamp_unix: u64,
}

fn print_help() {
    println!("Konofix Netprobe {}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage:");
    println!("  konofix-netprobe [--timeout SEC] <NODE_MULTIADDR>");
    println!();
    println!("The target must be a direct TCP or QUIC-v1 address ending in /p2p/<PeerId>.");
    println!("A successful probe requires an authenticated connection to that Peer ID,");
    println!("Konofix Node Identify metadata, and a successful libp2p ping round trip.");
    println!();
    println!("Examples:");
    println!("  konofix-netprobe /ip4/127.0.0.1/tcp/45555/p2p/12D3KooW...");
    println!("  konofix-netprobe --timeout 30 <NODE_QUIC_MULTIADDR>");
}

fn parse_target(raw: &str) -> Result<ProbeTarget, String> {
    let address: Multiaddr = raw
        .trim()
        .parse()
        .map_err(|error| format!("Invalid target multiaddr: {error}"))?;

    let peer_id = match address.iter().last() {
        Some(Protocol::P2p(peer_id)) => peer_id,
        _ => return Err("Target multiaddr must end in /p2p/<PeerId>.".into()),
    };

    let mut tcp_count = 0usize;
    let mut udp_count = 0usize;
    let mut quic_v1_count = 0usize;
    let mut peer_count = 0usize;
    let mut has_circuit = false;

    for protocol in address.iter() {
        match protocol {
            Protocol::Tcp(_) => tcp_count += 1,
            Protocol::Udp(_) => udp_count += 1,
            Protocol::QuicV1 => quic_v1_count += 1,
            Protocol::P2p(_) => peer_count += 1,
            Protocol::P2pCircuit => has_circuit = true,
            _ => {}
        }
    }

    if peer_count != 1 {
        return Err("Target must contain exactly one /p2p/<PeerId> component.".into());
    }
    if has_circuit {
        return Err("Relay targets are not valid direct transport probes.".into());
    }

    let transport = match (tcp_count, udp_count, quic_v1_count) {
        (1, 0, 0) => ProbeTransport::Tcp,
        (0, 1, 1) => ProbeTransport::QuicV1,
        _ => return Err("Target must contain exactly one direct TCP or QUIC-v1 transport.".into()),
    };

    Ok(ProbeTarget {
        address,
        peer_id,
        transport,
    })
}

fn parse_args_from<I>(args: I) -> Result<Option<ProbeArgs>, String>
where
    I: IntoIterator<Item = String>,
{
    let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
    let mut target = None;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            "--timeout" => {
                let raw = args.next().ok_or("Missing value after --timeout")?;
                timeout_seconds = raw
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid timeout: {raw}"))?;
                if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&timeout_seconds) {
                    return Err(format!(
                        "Timeout must be between {MIN_TIMEOUT_SECONDS} and \
                         {MAX_TIMEOUT_SECONDS} seconds."
                    ));
                }
            }
            value if value.starts_with('-') => {
                return Err(format!("Unknown argument: {value}. Use --help."));
            }
            value => {
                if target.is_some() {
                    return Err("Exactly one Node multiaddr must be supplied.".into());
                }
                target = Some(parse_target(value)?);
            }
        }
    }

    let target = target.ok_or("Missing Node multiaddr. Use --help for usage.")?;
    Ok(Some(ProbeArgs {
        target,
        timeout: Duration::from_secs(timeout_seconds),
    }))
}

fn parse_args() -> Result<Option<ProbeArgs>, String> {
    parse_args_from(std::env::args().skip(1))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn run_probe(args: ProbeArgs) -> Result<ProbeEvidence, String> {
    let started = Instant::now();
    let target_text = args.target.address.to_string();
    let expected_peer = args.target.peer_id;
    let transport = args.target.transport;

    let mut swarm = SwarmBuilder::with_existing_identity(identity::Keypair::generate_ed25519())
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|error| format!("Failed to configure TCP transport: {error}"))?
        .with_quic()
        .with_dns()
        .map_err(|error| format!("Failed to configure DNS transport: {error}"))?
        .with_behaviour(|key| {
            let identify = identify::Behaviour::new(
                identify::Config::new("/konofix/netprobe/1.0.0".into(), key.public())
                    .with_agent_version(format!(
                        "Konofix-Netprobe/{}",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .with_interval(Duration::from_secs(5)),
            );
            let ping = ping::Behaviour::new(
                ping::Config::new()
                    .with_interval(Duration::from_secs(1))
                    .with_timeout(Duration::from_secs(5)),
            );
            Ok(ProbeBehaviour { identify, ping })
        })
        .map_err(|error| format!("Failed to configure probe behaviour: {error}"))?
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm
        .dial(args.target.address.clone())
        .map_err(|error| format!("Failed to dial {target_text}: {error}"))?;

    let mut connected = false;
    let mut observed_peer = None::<PeerId>;
    let mut protocol_version = None::<String>;
    let mut agent_version = None::<String>;
    let mut rtt = None::<Duration>;

    loop {
        let remaining = args.timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(format!(
                "Timed out after {} seconds while probing {}. \
                 connected={} identify={} ping={}",
                args.timeout.as_secs(),
                target_text,
                connected,
                protocol_version.is_some(),
                rtt.is_some()
            ));
        }

        let event = tokio::time::timeout(remaining, swarm.select_next_some())
            .await
            .map_err(|_| {
                format!(
                    "Timed out after {} seconds while probing {}.",
                    args.timeout.as_secs(),
                    target_text
                )
            })?;

        match event {
            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                if peer_id != expected_peer {
                    return Err(format!(
                        "Authenticated peer mismatch: expected {expected_peer}, \
                         connected to {peer_id}."
                    ));
                }
                connected = true;
                observed_peer = Some(peer_id);
            }
            SwarmEvent::Behaviour(ProbeBehaviourEvent::Identify(identify::Event::Received {
                peer_id,
                info,
                ..
            })) => {
                if peer_id != expected_peer {
                    return Err(format!(
                        "Identify peer mismatch: expected {expected_peer}, \
                         received metadata from {peer_id}."
                    ));
                }
                if info.protocol_version != EXPECTED_PROTOCOL_VERSION {
                    return Err(format!(
                        "Unexpected Konofix protocol version from {peer_id}: {}",
                        info.protocol_version
                    ));
                }
                if !info.agent_version.starts_with(EXPECTED_AGENT_PREFIX) {
                    return Err(format!(
                        "Unexpected peer agent from {peer_id}: {}",
                        info.agent_version
                    ));
                }
                protocol_version = Some(info.protocol_version);
                agent_version = Some(info.agent_version);
                observed_peer = Some(peer_id);
            }
            SwarmEvent::Behaviour(ProbeBehaviourEvent::Ping(event))
                if event.peer == expected_peer =>
            {
                match event.result {
                    Ok(duration) => rtt = Some(duration),
                    Err(error) => {
                        return Err(format!("libp2p ping to {expected_peer} failed: {error}"));
                    }
                }
            }
            _ => {}
        }

        if connected && protocol_version.is_some() && agent_version.is_some() && rtt.is_some() {
            let observed_peer = observed_peer
                .ok_or_else(|| "Probe completed without an observed Peer ID.".to_string())?;
            let rtt = rtt.ok_or_else(|| "Probe completed without ping RTT.".to_string())?;
            return Ok(ProbeEvidence {
                schema: 1,
                status: "pass",
                tool: "konofix-netprobe",
                version: env!("CARGO_PKG_VERSION"),
                source_commit: SOURCE_COMMIT,
                transport: transport.as_str(),
                target: target_text,
                expected_peer_id: expected_peer.to_string(),
                observed_peer_id: observed_peer.to_string(),
                protocol_version: protocol_version.unwrap_or_default(),
                agent_version: agent_version.unwrap_or_default(),
                rtt_micros: rtt.as_micros().try_into().unwrap_or(u64::MAX),
                elapsed_millis: started
                    .elapsed()
                    .as_millis()
                    .try_into()
                    .unwrap_or(u64::MAX),
                timestamp_unix: unix_timestamp(),
            });
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(args) = parse_args().map_err(std::io::Error::other)? else {
        return Ok(());
    };
    let evidence = run_probe(args).await.map_err(std::io::Error::other)?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_peer() -> PeerId {
        identity::Keypair::generate_ed25519().public().to_peer_id()
    }

    #[test]
    fn parses_direct_tcp_target() {
        let peer = test_peer();
        let target = parse_target(&format!("/ip4/127.0.0.1/tcp/45555/p2p/{peer}"))
            .expect("TCP target should parse");
        assert_eq!(target.peer_id, peer);
        assert_eq!(target.transport, ProbeTransport::Tcp);
    }

    #[test]
    fn parses_direct_quic_target() {
        let peer = test_peer();
        let target = parse_target(&format!(
            "/dns4/node.example.org/udp/45555/quic-v1/p2p/{peer}"
        ))
        .expect("QUIC target should parse");
        assert_eq!(target.peer_id, peer);
        assert_eq!(target.transport, ProbeTransport::QuicV1);
    }

    #[test]
    fn rejects_missing_peer_id() {
        let error = parse_target("/ip4/127.0.0.1/tcp/45555").expect_err("Peer ID is required");
        assert!(error.contains("must end in /p2p"));
    }

    #[test]
    fn rejects_relay_target() {
        let relay = test_peer();
        let target = test_peer();
        let error = parse_target(&format!(
            "/ip4/127.0.0.1/tcp/45555/p2p/{relay}/p2p-circuit/p2p/{target}"
        ))
        .expect_err("relay target should be rejected");
        assert!(error.contains("exactly one /p2p") || error.contains("Relay targets"));
    }

    #[test]
    fn rejects_non_tcp_non_quic_transport() {
        let peer = test_peer();
        let error = parse_target(&format!("/ip4/127.0.0.1/udp/45555/p2p/{peer}"))
            .expect_err("raw UDP should be rejected");
        assert!(error.contains("direct TCP or QUIC-v1"));
    }

    #[test]
    fn parses_timeout_and_rejects_extra_target() {
        let peer = test_peer();
        let target = format!("/ip4/127.0.0.1/tcp/45555/p2p/{peer}");
        let args = parse_args_from(vec!["--timeout".into(), "30".into(), target.clone()])
            .expect("args should parse")
            .expect("not help");
        assert_eq!(args.timeout, Duration::from_secs(30));

        let error = parse_args_from(vec![target.clone(), target])
            .expect_err("second target should be rejected");
        assert!(error.contains("Exactly one"));
    }

    #[test]
    fn rejects_timeout_outside_safety_bounds() {
        let peer = test_peer();
        let target = format!("/ip4/127.0.0.1/tcp/45555/p2p/{peer}");
        let low = vec!["--timeout".into(), "4".into(), target.clone()];
        let high = vec!["--timeout".into(), "121".into(), target];
        assert!(parse_args_from(low).is_err());
        assert!(parse_args_from(high).is_err());
    }
}
