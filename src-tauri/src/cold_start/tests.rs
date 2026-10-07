use super::*;

// Syntax-only public-IP fixtures. No test in this module opens a socket.
fn endpoint(peer: PeerId) -> String {
    format!("/ip4/8.8.8.8/tcp/45555/p2p/{peer}")
}
fn signed(
    key: &identity::Keypair,
    requester: PeerId,
    request: &Request,
    sequence: u64,
) -> Advertisement {
    Advertisement::sign(
        key,
        requester,
        request,
        1000,
        sequence,
        vec![endpoint(key.public().to_peer_id())],
        false,
    )
    .unwrap()
}
#[test]
fn namespace_and_request_are_separate_and_bounded() {
    assert_ne!(AD_PROTOCOL, "/konofix/experimental/cold-start/1");
    let key = provider_key(WORLD_NAMESPACE);
    assert_eq!(&key.as_ref()[..2], &[0x12, 0x20]);
    assert_eq!(key.as_ref().len(), 34);
    assert_ne!(key, provider_key("konofix/world/v3"));
    assert_ne!(Request::fresh(), Request::fresh());
    const { assert!(MAX_WIRE_BYTES < 8192) };
}
#[test]
fn rejects_identity_request_namespace_signature_and_endpoint_tampering() {
    let key = identity::Keypair::generate_ed25519();
    let peer = key.public().to_peer_id();
    let requester = PeerId::random();
    let request = Request::fresh();
    let ad = signed(&key, requester, &request, 1);
    assert!(ad.verify(peer, requester, &request, 1000).is_ok());
    assert_eq!(
        ad.verify(PeerId::random(), requester, &request, 1000),
        Err(Rejection::Identity)
    );
    assert_eq!(
        ad.verify(peer, PeerId::random(), &request, 1000),
        Err(Rejection::Request)
    );
    assert_eq!(
        ad.verify(peer, requester, &Request::fresh(), 1000),
        Err(Rejection::Request)
    );
    for mutation in 0..7 {
        let mut bad = ad.clone();
        match mutation {
            0 => bad.namespace = "other/world".into(),
            1 => bad.expires -= 1,
            2 => bad.sequence += 1,
            3 => bad.relay_opt_in = true,
            4 => bad.endpoints[0] = bad.endpoints[0].replace("8.8.8.8", "1.1.1.1"),
            5 => bad.public_key = vec![0; 65],
            _ => bad.signature.pop().map(|_| ()).unwrap(),
        }
        assert!(bad.verify(peer, requester, &request, 1000).is_err());
    }
    for now in [999, 1300, u64::MAX] {
        assert_eq!(
            ad.verify(peer, requester, &request, now),
            Err(Rejection::Freshness)
        );
    }
    assert!(Advertisement::sign(
        &key,
        requester,
        &request,
        u64::MAX,
        1,
        vec![endpoint(peer)],
        false
    )
    .is_err());
    assert!(Advertisement::sign(
        &key,
        requester,
        &request,
        1000,
        0,
        vec![endpoint(peer)],
        false
    )
    .is_err());
    assert!(Advertisement::sign(
        &key,
        requester,
        &request,
        1000,
        1,
        vec![endpoint(peer); MAX_ENDPOINTS + 1],
        false
    )
    .is_err());
    assert!(Advertisement::sign(
        &key,
        requester,
        &request,
        1000,
        1,
        vec![endpoint(peer); 2],
        false
    )
    .is_err());
}
#[test]
fn endpoints_reject_private_dns_mismatched_identity_extra_hops_and_zero_ports() {
    let peer = PeerId::random();
    let relay = PeerId::random();
    for prefix in [
        "/ip4/127.0.0.1/tcp/1",
        "/ip4/10.0.0.1/tcp/1",
        "/ip4/100.64.0.1/tcp/1",
        "/ip4/192.168.0.1/tcp/1",
        "/ip4/169.254.169.254/tcp/80",
        "/ip4/203.0.113.1/tcp/1",
        "/ip4/224.0.0.1/tcp/1",
        "/ip4/8.8.8.8/tcp/0",
        "/ip4/8.8.8.8/udp/1",
        "/ip6/::1/tcp/1",
        "/ip6/::ffff:8.8.8.8/tcp/1",
        "/ip6/2002:7f00:1::/tcp/1",
        "/ip6/2001:db8::1/tcp/1",
        "/dns/anything.org/tcp/1",
    ] {
        assert!(
            public_endpoint(&format!("{prefix}/p2p/{peer}"), peer).is_none(),
            "{prefix}"
        );
    }
    assert!(public_endpoint(&endpoint(peer), relay).is_none());
    for suffix in ["/tcp/22", "/p2p-circuit"] {
        assert!(public_endpoint(&(endpoint(peer) + suffix), peer).is_none());
    }
    let circuit = format!("{}/p2p-circuit/p2p/{peer}", endpoint(relay));
    assert!(is_circuit(&public_endpoint(&circuit, peer).unwrap()));
    assert!(public_endpoint(&format!("{}/p2p-circuit/p2p/{peer}", endpoint(peer)), peer).is_none());
    assert!(public_endpoint(
        &format!("/ip6/2606:4700:4700::1111/udp/443/quic-v1/p2p/{peer}"),
        peer
    )
    .is_some());
}
#[test]
fn replay_expiry_network_change_and_clock_rollback_fail_closed() {
    let key = identity::Keypair::generate_ed25519();
    let peer = key.public().to_peer_id();
    let requester = PeerId::random();
    let request = Request::fresh();
    let ad = signed(&key, requester, &request, 1);
    let mut cache = Cache::new();
    let start = Instant::now();
    assert_eq!(cache.generation(), 0);
    cache
        .admit(
            peer,
            requester,
            &request,
            0,
            &ad,
            AdmissionTime {
                unix_seconds: 1000,
                monotonic: start,
            },
        )
        .unwrap();
    let accepted = cache.get(&peer).unwrap();
    assert_eq!(accepted.endpoints.len(), 1);
    assert!(!accepted.relay_opt_in);
    assert_eq!(
        cache.admit(
            peer,
            requester,
            &request,
            0,
            &ad,
            AdmissionTime {
                unix_seconds: 1001,
                monotonic: start
            }
        ),
        Err(Rejection::Replay)
    );
    cache.network_changed().unwrap();
    assert!(cache.get(&peer).is_none());
    assert_eq!(
        cache.admit(
            peer,
            requester,
            &request,
            0,
            &ad,
            AdmissionTime {
                unix_seconds: 1001,
                monotonic: start
            }
        ),
        Err(Rejection::Request)
    );
    assert_eq!(
        cache.admit(
            peer,
            requester,
            &request,
            1,
            &ad,
            AdmissionTime {
                unix_seconds: 1001,
                monotonic: start
            }
        ),
        Err(Rejection::Replay)
    );
    cache
        .admit(
            peer,
            requester,
            &request,
            1,
            &signed(&key, requester, &request, 2),
            AdmissionTime {
                unix_seconds: 1001,
                monotonic: start,
            },
        )
        .unwrap();
    assert_eq!(
        cache.admit(
            peer,
            requester,
            &request,
            1,
            &ad,
            AdmissionTime {
                unix_seconds: 999,
                monotonic: start
            }
        ),
        Err(Rejection::Clock)
    );
    cache.expire(999, start);
    assert!(cache.get(&peer).is_none());
    cache
        .admit(
            peer,
            requester,
            &request,
            1,
            &signed(&key, requester, &request, 3),
            AdmissionTime {
                unix_seconds: 1001,
                monotonic: start,
            },
        )
        .unwrap();
    cache.expire(1001, start + Duration::from_secs(MAX_TTL));
    assert!(cache.get(&peer).is_none());
    assert!(cache.entries.is_empty());
}
#[test]
fn cache_flood_does_not_evict_replay_tombstones() {
    let mut cache = Cache::new();
    let now = Instant::now();
    let requester = PeerId::random();
    let request = Request::fresh();
    for _ in 0..MAX_CACHE {
        let key = identity::Keypair::generate_ed25519();
        cache
            .admit(
                key.public().to_peer_id(),
                requester,
                &request,
                0,
                &signed(&key, requester, &request, 1),
                AdmissionTime {
                    unix_seconds: 1000,
                    monotonic: now,
                },
            )
            .unwrap();
    }
    cache.network_changed().unwrap();
    let key = identity::Keypair::generate_ed25519();
    assert_eq!(
        cache.admit(
            key.public().to_peer_id(),
            requester,
            &request,
            1,
            &signed(&key, requester, &request, 1),
            AdmissionTime {
                unix_seconds: 1000,
                monotonic: now
            }
        ),
        Err(Rejection::Capacity)
    );
    cache.expire(1300, now + Duration::from_secs(MAX_TTL));
    assert!(cache.entries.is_empty());
}
