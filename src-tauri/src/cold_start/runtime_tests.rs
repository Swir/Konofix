use super::*;
use libp2p::multiaddr::Protocol;

fn local_swarm(key: &identity::Keypair, server: bool) -> Swarm<DiscoveryBehaviour> {
    local_swarm_with_config(key, server, libp2p::swarm::Config::with_tokio_executor())
}

fn local_swarm_with_config(
    key: &identity::Keypair,
    server: bool,
    config: libp2p::swarm::Config,
) -> Swarm<DiscoveryBehaviour> {
    let tcp = tcp::tokio::Transport::new(tcp::Config::default())
        .upgrade(upgrade::Version::V1Lazy)
        .authenticate(noise::Config::new(key).unwrap())
        .multiplex(yamux::Config::default())
        .map(|(peer, mux), _| (peer, StreamMuxerBox::new(mux)));
    let mut behaviour = behaviour(key);
    behaviour.kad.set_mode(Some(if server {
        kad::Mode::Server
    } else {
        kad::Mode::Client
    }));
    // A local fixture accepts inbound streams; the production discovery client does not.
    behaviour.ads = ad_behaviour(request_response::ProtocolSupport::Full);
    behaviour.limits = connection_limits::Behaviour::new(
        connection_limits::ConnectionLimits::default().with_max_established(Some(16)),
    );
    Swarm::new(
        PublicTransport::loopback(tcp, DialBudget::new()).boxed(),
        behaviour,
        key.public().to_peer_id(),
        config,
    )
}
async fn listen(swarm: &mut Swarm<DiscoveryBehaviour>) -> Multiaddr {
    swarm
        .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
        .unwrap();
    loop {
        if let SwarmEvent::NewListenAddr { address, .. } = swarm.select_next_some().await {
            return address;
        }
    }
}

#[tokio::test]
async fn read_only_lookup_does_not_send_background_bootstrap_rpcs() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut seed = local_swarm(&identity::Keypair::generate_ed25519(), true);
        let seed_id = *seed.local_peer_id();
        let seed_addr = listen(&mut seed).await;
        let mut client = local_swarm(&identity::Keypair::generate_ed25519(), false);
        let query = seeded_query(&mut client, &[(seed_id, seed_addr)], |kad| {
            kad.get_providers(provider_key("local/read-only-budget"))
        });
        let mut reads = 0;
        let mut other_rpcs = 0;
        let mut completed = false;
        // libp2p's insertion-triggered bootstrap waits 500ms. Keep polling after
        // the lookup finishes so a successful fast query cannot hide it.
        let observation = tokio::time::sleep(Duration::from_millis(1200));
        tokio::pin!(observation);
        loop {
            tokio::select! {
                _ = &mut observation, if completed => break,
                event = seed.select_next_some() => {
                    if let SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(kad::Event::InboundRequest { request })) = event {
                        match request {
                            kad::InboundRequest::GetProvider { .. } => reads += 1,
                            _ => other_rpcs += 1,
                        }
                    }
                }
                event = client.select_next_some() => {
                    if let SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(kad::Event::OutboundQueryProgressed { id, result, step, .. })) = event {
                        if id == query && step.last {
                            assert!(matches!(result, kad::QueryResult::GetProviders(Ok(_))));
                            observation.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(1200));
                            completed = true;
                        }
                    }
                }
            }
        }
        assert!(completed, "local GET_PROVIDERS must actually succeed");
        assert_eq!(client.behaviour_mut().kad.kbuckets().count(), 0);
        assert_eq!(reads, 1);
        assert_eq!(other_rpcs, 0, "read-only lookup sent unsolicited Kademlia RPCs");
    }).await.expect("local RPC accounting exceeded 5 seconds");
}

#[tokio::test]
async fn real_provider_lookup_authenticates_request_before_native_handoff() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let key = identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        // Keep these fixture connections idle for longer than the unchanged
        // 20-second test deadline: only explicit helper cleanup may pass.
        let mut publisher = local_swarm_with_config(&key, false,
            libp2p::swarm::Config::with_tokio_executor().with_idle_connection_timeout(Duration::from_secs(60)));
        let mut seed = local_swarm(&identity::Keypair::generate_ed25519(), true);
        let mut routing_peer = local_swarm(&identity::Keypair::generate_ed25519(), true);
        let mut client = Discovery::new(identity::Keypair::generate_ed25519()).unwrap();
        // Replace all production seeds before polling: no public DNS/socket activity.
        client.swarm = local_swarm_with_config(&client.key, false,
            libp2p::swarm::Config::with_tokio_executor().with_idle_connection_timeout(Duration::from_secs(60)));
        let seed_id = *seed.local_peer_id(); let seed_addr = listen(&mut seed).await;
        let routing_id = *routing_peer.local_peer_id(); let routing_addr = listen(&mut routing_peer).await;
        // The entry point has no provider record. Its closer-peer response must
        // lead to a second DHT server using query-local addresses, despite the
        // isolated client's intentionally empty persistent routing table.
        seed.behaviour_mut().kad.add_address(&routing_id, routing_addr.clone());
        let publisher_addr = listen(&mut publisher).await;
        publisher.add_external_address(publisher_addr);
        client.seeds = vec![(seed_id, seed_addr)];
        let publish = seeded_query(&mut publisher, &[(routing_id, routing_addr)], |kad| kad.start_providing(provider_key(WORLD_NAMESPACE))).unwrap();
        let mut stored = false; let mut published = false; let mut started = false;
        let mut native_handoff = None;
        while native_handoff.is_none() {
            tokio::select! {
                _ = seed.select_next_some() => {},
                event = routing_peer.select_next_some() => {
                    if matches!(event, SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(kad::Event::InboundRequest { request: kad::InboundRequest::AddProvider {..}, .. }))) { stored = true; }
                }
                event = publisher.select_next_some() => match event {
                    SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(kad::Event::OutboundQueryProgressed { id, result: kad::QueryResult::StartProviding(result), .. })) if id == publish => { result.unwrap(); published = true; }
                    SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Ads(request_response::Event::Message { peer: requester, message: request_response::Message::Request { request, channel, .. }, .. })) => {
                        let endpoint = format!("/ip4/8.8.8.8/tcp/45555/p2p/{peer}"); // syntax fixture, NEVER dialed
                        let ad = Advertisement::sign(&key, requester, &request, SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(), 1, vec![endpoint], false).unwrap();
                        publisher.behaviour_mut().ads.send_response(channel, Some(ad)).unwrap();
                    }
                    _ => {}
                },
                candidate = client.next(), if started => { if let Some(Event::Candidate(candidate)) = candidate { native_handoff = Some(candidate); } }
            }
            if published && stored && !started { client.tick(1001); started = true; }
        }
        let candidate = native_handoff.unwrap();
        assert_eq!(candidate.peer, peer); assert_eq!(candidate.endpoints.len(), 1); assert!(!candidate.relay_opt_in);
        assert!(client.contains(&peer)); assert!(client.pending.is_empty());
        assert_eq!(client.swarm.behaviour_mut().kad.kbuckets().count(), 0);
        assert_eq!(client.status, "verified-participant");
        // A completed lookup must not erase the admitted status. The temporary
        // ad connection must close on both ends so it cannot occupy the native
        // peer's connection slot while a simultaneous handoff waits.
        while client.query.is_some()
            || client.swarm.is_connected(&peer)
            || publisher.is_connected(client.swarm.local_peer_id())
        {
            tokio::select! {
                _ = seed.select_next_some() => {},
                _ = routing_peer.select_next_some() => {},
                _ = publisher.select_next_some() => {},
                _ = client.next() => {},
            }
        }
        assert_eq!(client.status, "verified-participant");
        let before = *client.swarm.local_peer_id();
        client.network_changed().unwrap();
        assert_eq!(*client.swarm.local_peer_id(), before);
        assert!(!client.contains(&peer)); assert!(client.pending.is_empty());
        assert_eq!(client.cache.generation(), 1);
        // Rebuilt public swarm is dropped without polling or any public test traffic.
    }).await.expect("local discovery/admission exceeded 20 seconds");
}

#[tokio::test]
async fn publisher_requires_public_reachability_and_limits_reannouncement() {
    let mut client = Discovery::new(identity::Keypair::generate_ed25519()).unwrap();
    let peer = *client.swarm.local_peer_id();
    let address: Multiaddr = format!("/ip4/8.8.8.8/tcp/1/p2p/{peer}").parse().unwrap();
    client.publish(std::slice::from_ref(&address), false);
    assert!(!client.published);
    client.publish(
        &[format!("/ip4/127.0.0.1/tcp/1/p2p/{peer}").parse().unwrap()],
        true,
    );
    assert!(!client.published);
    client.publish(&[address], true);
    assert!(client.publication.is_some());
    client.network_changed().unwrap();
    client.publish(
        &[format!("/ip4/1.1.1.1/tcp/1/p2p/{peer}").parse().unwrap()],
        true,
    );
    assert!(!client.published); // no announcement flood on interface flapping
    assert_eq!(client.swarm.behaviour().kad.mode(), kad::Mode::Client);
    assert!(client.swarm.listeners().next().is_none());
    for raw in SEEDS {
        assert!(matches!(
            raw.parse::<Multiaddr>().unwrap().iter().last(),
            Some(Protocol::P2p(_))
        ));
    }
    // No swarm is polled; syntax/recovery assertions do not contact fixture addresses.
}

#[tokio::test]
async fn native_witness_address_does_not_outlive_its_reachability_lease() {
    let mut swarm = local_swarm(&identity::Keypair::generate_ed25519(), false);
    let local = *swarm.local_peer_id();
    let server = PeerId::random();
    let mut witness = super::super::reachability::Witness::default();
    let now = Instant::now();
    let address: Multiaddr = format!("/ip4/8.8.8.8/tcp/45555/p2p/{local}")
        .parse()
        .unwrap();
    let preexisting: Multiaddr = format!("/ip4/9.9.9.9/tcp/45555/p2p/{local}")
        .parse()
        .unwrap();
    swarm.add_external_address(preexisting.clone());
    let inbound = libp2p::core::ConnectedPoint::Listener {
        local_addr: "/ip4/192.168.1.2/tcp/45555".parse().unwrap(),
        send_back_addr: "/ip4/1.1.1.1/tcp/4001".parse().unwrap(),
    };
    assert!(witness
        .response(server, local, address.clone(), now)
        .is_none());
    assert_eq!(
        witness.connection(server, &inbound, now),
        Some(address.clone())
    );
    // Even a matching witness must not take ownership of a pre-existing address.
    assert_eq!(
        witness.response(server, local, preexisting.clone(), now),
        Some(preexisting.clone())
    );
    witness.sync_external(&mut swarm, now);
    assert!(swarm.external_addresses().any(|a| a == &address));
    witness.sync_external(&mut swarm, now + Duration::from_secs(299));
    assert!(swarm.external_addresses().any(|a| a == &address));
    assert!(witness.endpoints(now + Duration::from_secs(300)).is_empty());
    witness.sync_external(&mut swarm, now + Duration::from_secs(300));
    assert!(
        !swarm.external_addresses().any(|a| a == &address),
        "expired witness remained advertised by the native swarm"
    );
    assert!(swarm.external_addresses().any(|a| a == &preexisting));

    for seconds in [301, 400] {
        let at = now + Duration::from_secs(seconds);
        assert!(witness
            .response(server, local, address.clone(), at)
            .is_none());
        assert_eq!(
            witness.connection(server, &inbound, at),
            Some(address.clone())
        );
        witness.sync_external(&mut swarm, at);
    }
    witness.sync_external(&mut swarm, now + Duration::from_secs(601));
    assert!(
        swarm.external_addresses().any(|a| a == &address),
        "fresh revalidation must renew the lease"
    );
    // Network change / private-or-unknown status withdraws immediately, without
    // touching an address already owned by the native stack before this witness.
    witness.clear();
    witness.sync_external(&mut swarm, now + Duration::from_secs(602));
    assert!(!swarm.external_addresses().any(|a| a == &address));
    assert!(swarm.external_addresses().any(|a| a == &preexisting));
    // Synthetic endpoint strings exercise state only: no swarm is ever polled.
}

#[tokio::test]
#[ignore = "manual one-shot public read-only interoperability trial; never run in CI"]
async fn public_amino_read_only_once() {
    use std::io::Write;
    assert_eq!(
        std::env::var("KONOFIX_ALLOW_PUBLIC_AMINO_ONCE").as_deref(),
        Ok("read-only-no-wan-claim")
    );
    let output =
        std::env::var("KONOFIX_AMINO_PROBE_OUTPUT").expect("new evidence file path required");
    // Reserve evidence before any network traffic; never overwrite a previous attempt.
    let mut evidence = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)
        .unwrap();
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let namespace = format!(
        "konofix/experimental/interop-read-only/{}",
        uuid::Uuid::new_v4()
    );
    let key = identity::Keypair::generate_ed25519();
    let budget = DialBudget::new();
    let mut swarm = Discovery::new_swarm(&key, budget.clone()).unwrap();
    let query = seeded_query(&mut swarm, &seed_addresses().unwrap(), |kad| {
        kad.get_providers(provider_key(&namespace))
    });
    let begin = Instant::now();
    let mut connections = 0u32;
    let mut errors = 0u32;
    let mut successes = 0u32;
    let mut requests = 0u32;
    let mut completed = false;
    let mut unexpected_queries = HashSet::new();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = swarm.select_next_some().await;
            for active in swarm.behaviour().kad.iter_queries() {
                if active.id() != query {
                    unexpected_queries.insert(active.id());
                }
            }
            match event {
                SwarmEvent::ConnectionEstablished { .. } => connections += 1,
                SwarmEvent::OutgoingConnectionError { .. } => errors += 1,
                SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(
                    kad::Event::OutboundQueryProgressed {
                        id,
                        result,
                        stats,
                        step,
                        ..
                    },
                )) => {
                    if id != query {
                        unexpected_queries.insert(id);
                        break;
                    }
                    successes = stats.num_successes();
                    requests = stats.num_requests();
                    if step.last {
                        completed = matches!(result, kad::QueryResult::GetProviders(Ok(_)));
                        break;
                    }
                }
                _ => {}
            }
            if !unexpected_queries.is_empty() {
                break;
            }
        }
    })
    .await;
    drop(swarm);
    let interoperable = result.is_ok()
        && completed
        && successes > 0
        && connections > 0
        && unexpected_queries.is_empty();
    let report = serde_json::json!({
        "schema": 2, "kind": "konofix-amino-read-only-interop", "source_commit": env!("KONOFIX_SOURCE_COMMIT"),
        "started_unix": started, "elapsed_ms": begin.elapsed().as_millis(), "namespace": namespace,
        "outcome": if interoperable { "RPC_INTEROPERABILITY_PASS" } else { "NO_COMPLETED_INTEROPERABILITY_PROOF" },
        "authenticated_connections": connections, "outgoing_errors": errors,
        "query_requests": requests, "query_successes": successes, "query_completed": completed,
        "unexpected_queries": unexpected_queries.len(),
        "deadline_exceeded": result.is_err(), "provider_writes": 0, "value_writes": 0,
        "transport_stages": budget.snapshot(),
        "remote_ttl": "none requested: read-only", "chat_messages": 0, "physical_wan_acceptance": "NOT_EVALUATED",
        "limits": {"seconds":30,"dials_per_300_seconds":64,"connections":16,"pending_dials":4,"queries":1}
    });
    writeln!(
        evidence,
        "{}",
        serde_json::to_string_pretty(&report).unwrap()
    )
    .unwrap();
    evidence.sync_all().unwrap();
    println!("{report}");
    assert!(
        interoperable,
        "public RPC interoperability not established; evidence preserved, no retry"
    );
}

#[tokio::test]
#[ignore = "manual one-shot public relay capability probe; never run in CI"]
async fn public_ipfs_relay_capability_once() {
    use libp2p::{connection_limits, relay, swarm::NetworkBehaviour, SwarmBuilder};
    use std::io::Write;

    #[derive(NetworkBehaviour)]
    struct ProbeBehaviour {
        relay: relay::client::Behaviour,
        identify: identify::Behaviour,
        ping: ping::Behaviour,
        limits: connection_limits::Behaviour,
    }

    assert_eq!(
        std::env::var("KONOFIX_ALLOW_PUBLIC_RELAY_PROBE").as_deref(),
        Ok("identify-and-one-reservation-per-seed")
    );
    let output =
        std::env::var("KONOFIX_RELAY_PROBE_OUTPUT").expect("new evidence file path required");
    let mut evidence = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)
        .unwrap();
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Current IPFS AutoConf Amino bootstrappers. This probe is deliberately
    // bounded and does not assume that a bootstrap also offers relay service.
    let seeds: [&str; 5] = [
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
        "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
    ];
    let key = identity::Keypair::generate_ed25519();
    let mut swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .unwrap()
        .with_quic()
        .with_dns()
        .unwrap()
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|key, relay| ProbeBehaviour {
            relay,
            identify: identify::Behaviour::new(
                identify::Config::new("/konofix/public-relay-probe/1".into(), key.public())
                    .with_interval(Duration::from_secs(300)),
            ),
            ping: ping::Behaviour::default(),
            limits: connection_limits::Behaviour::new(
                connection_limits::ConnectionLimits::default()
                    .with_max_established(Some(8))
                    .with_max_pending_outgoing(Some(8)),
            ),
        })
        .unwrap()
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(30)))
        .build();

    let mut expected = HashMap::new();
    for raw in seeds {
        let address: Multiaddr = raw.parse().unwrap();
        let Some(libp2p::multiaddr::Protocol::P2p(peer)) = address.iter().last() else {
            unreachable!("pinned seed without PeerID")
        };
        expected.insert(peer, address.clone());
        // A circuit listener asks the remote node for one bounded reservation.
        // Failure is evidence too; no retry occurs in this test.
        swarm
            .listen_on(address.with(libp2p::multiaddr::Protocol::P2pCircuit))
            .unwrap();
    }

    let begin = Instant::now();
    let mut identified = serde_json::Map::new();
    let mut accepted = HashSet::new();
    let mut listener_errors = Vec::new();
    let mut outgoing_errors = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match swarm.select_next_some().await {
                SwarmEvent::Behaviour(ProbeBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info, .. },
                )) if expected.contains_key(&peer_id) => {
                    identified.insert(
                        peer_id.to_string(),
                        serde_json::json!({
                            "agent": info.agent_version,
                            "protocols": info.protocols.iter().map(ToString::to_string).collect::<Vec<_>>(),
                            "listen_addresses": info.listen_addrs.iter().map(ToString::to_string).collect::<Vec<_>>(),
                        }),
                    );
                }
                SwarmEvent::Behaviour(ProbeBehaviourEvent::Relay(
                    relay::client::Event::ReservationReqAccepted {
                        relay_peer_id, ..
                    },
                )) => {
                    accepted.insert(relay_peer_id);
                }
                SwarmEvent::ListenerError { error, .. } => {
                    listener_errors.push(error.to_string());
                }
                SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                    outgoing_errors.push(serde_json::json!({
                        "peer": peer_id.map(|peer| peer.to_string()),
                        "error": error.to_string(),
                    }));
                }
                _ => {}
            }
            if accepted.len() + listener_errors.len() >= expected.len() {
                break;
            }
        }
    })
    .await;
    drop(swarm);

    let report = serde_json::json!({
        "schema": 1,
        "kind": "konofix-public-ipfs-relay-capability",
        "source_commit": env!("KONOFIX_SOURCE_COMMIT"),
        "started_unix": started,
        "elapsed_ms": begin.elapsed().as_millis(),
        "outcome": if accepted.is_empty() { "NO_PUBLIC_RELAY_RESERVATION" } else { "PUBLIC_RELAY_RESERVATION_OBSERVED" },
        "seeds_requested": expected.len(),
        "identified": identified,
        "accepted_relay_peers": accepted.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "listener_errors": listener_errors,
        "outgoing_errors": outgoing_errors,
        "deadline_exceeded": result.is_err(),
        "chat_messages": 0,
        "physical_wan_acceptance": "NOT_EVALUATED",
        "limits": {"seconds": 30, "reservations_per_seed": 1, "retries": 0}
    });
    writeln!(
        evidence,
        "{}",
        serde_json::to_string_pretty(&report).unwrap()
    )
    .unwrap();
    evidence.sync_all().unwrap();
    println!("{report}");
    assert!(
        !accepted.is_empty(),
        "no public IPFS bootstrap accepted a relay reservation; evidence preserved, no retry"
    );
}

#[tokio::test]
async fn native_probe_bridge_needs_inbound_evidence_and_discards_old_interface_ports() {
    let mut client = Discovery::new(identity::Keypair::generate_ed25519()).unwrap();
    client.observed_hosts.push("/ip4/8.8.8.8".parse().unwrap());
    client.refresh_probe_candidates();
    assert!(client.probe_candidates.is_empty());
    client.native_listeners(std::iter::repeat_n(
        "/ip4/127.0.0.1/tcp/45555".parse().unwrap(),
        12,
    ));
    assert_eq!(client.native_ports.len(), 1);
    assert_eq!(client.probe_candidates.len(), 1);
    let local = *client.swarm.local_peer_id();
    let server = PeerId::random();
    let response = Event::PublicProbe {
        server,
        address: format!("/ip4/8.8.8.8/tcp/45555/p2p/{local}")
            .parse()
            .unwrap(),
    };
    let mut witness = super::super::reachability::Witness::default();
    if let Event::PublicProbe { server, address } = response {
        assert!(witness
            .response(server, local, address, Instant::now())
            .is_none());
    }
    client.network_changed().unwrap();
    witness.clear();
    assert!(client.native_ports.is_empty());
    assert!(client.observed_hosts.is_empty());
    assert!(client.probe_candidates.is_empty());
    assert!(client.probe_servers.is_empty());
    // This test does not poll any swarm; its literals are never dialed.
}

#[tokio::test]
async fn repeated_interface_addresses_cannot_starve_quic_reachability_candidates() {
    let mut client = Discovery::isolated_for_test(identity::Keypair::generate_ed25519()).unwrap();
    // Syntax fixtures only: this test never polls a swarm or dials these hosts.
    client.observed_hosts.push("/ip4/8.8.8.8".parse().unwrap());
    let tcp_interfaces = (1..=12).map(|last| {
        format!("/ip4/192.168.1.{last}/tcp/45555")
            .parse::<Multiaddr>()
            .unwrap()
    });
    let quic: Multiaddr = "/ip4/192.168.1.1/udp/45555/quic-v1".parse().unwrap();
    client.native_listeners(tcp_interfaces.chain(std::iter::once(quic)));
    let local = client.swarm.local_peer_id();
    assert!(
        client.probe_candidates.contains(
            &format!("/ip4/8.8.8.8/udp/45555/quic-v1/p2p/{local}")
                .parse()
                .unwrap()
        ),
        "repeated TCP interfaces must not consume the QUIC probe slot"
    );
    assert_eq!(client.native_ports.len(), 2);
    assert_eq!(client.probe_candidates.len(), 2);

    client.network_changed().unwrap();
    assert!(client.probe_candidates.is_empty());
    client.native_listeners(
        (45000..45012).map(|port| format!("/ip4/192.168.1.1/tcp/{port}").parse().unwrap()),
    );
    assert_eq!(
        client.native_ports.len(),
        4,
        "distinct-port cap remains unchanged"
    );
}

#[tokio::test]
async fn isolated_desktop_fixture_never_restores_public_seeds_on_network_change() {
    let mut client = Discovery::isolated_for_test(identity::Keypair::generate_ed25519()).unwrap();
    assert_eq!(client.swarm.behaviour_mut().kad.kbuckets().count(), 0);
    client.network_changed().unwrap();
    assert_eq!(client.swarm.behaviour_mut().kad.kbuckets().count(), 0);
    client.tick(1000);
    tokio::time::timeout(Duration::from_secs(2), async {
        while client.query.is_some() {
            client.next().await;
        }
    })
    .await
    .expect("seedless query should complete without a network dial");
    assert_eq!(client.budget.snapshot()["accepted_transport_dials"], 0);
    assert_eq!(client.budget.snapshot()["dns_candidates"], 0);
}

#[tokio::test]
async fn admission_limit_rejection_leaves_no_phantom_request_response_connection() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut host = local_swarm(&identity::Keypair::generate_ed25519(), true);
        host.behaviour_mut().limits = connection_limits::Behaviour::new(
            connection_limits::ConnectionLimits::default().with_max_established_per_peer(Some(1)),
        );
        let key = identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        let mut first = local_swarm(&key, false);
        let mut second = local_swarm(&key, false);
        let address = listen(&mut host).await;
        first.dial(address.clone()).unwrap();
        let connection = loop {
            tokio::select! {
                event = host.select_next_some() => if let SwarmEvent::ConnectionEstablished { connection_id, .. } = event { break connection_id; },
                _ = first.select_next_some() => {},
            }
        };
        second.dial(address).unwrap();
        loop {
            tokio::select! {
                event = host.select_next_some() => if let SwarmEvent::IncomingConnectionError { error, .. } = event {
                    assert!(matches!(error, libp2p::swarm::ListenError::Denied { .. }));
                    break;
                },
                _ = first.select_next_some() => {},
                _ = second.select_next_some() => {},
            }
        }
        assert!(host.close_connection(connection));
        loop {
            tokio::select! {
                event = host.select_next_some() => if let SwarmEvent::ConnectionClosed { peer_id, num_established, .. } = event {
                    assert_eq!(peer_id, peer); assert_eq!(num_established, 0);
                    assert!(!host.is_connected(&peer)); break;
                },
                _ = first.select_next_some() => {},
                _ = second.select_next_some() => {},
            }
        }
    }).await.expect("bounded connection rejection/close regression exceeded 10 seconds");
}
