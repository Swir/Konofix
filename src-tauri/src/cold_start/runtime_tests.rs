use super::*;
use libp2p::multiaddr::Protocol;

fn local_swarm(key: &identity::Keypair, server: bool) -> Swarm<DiscoveryBehaviour> {
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
        libp2p::swarm::Config::with_tokio_executor(),
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
async fn real_provider_lookup_authenticates_request_before_native_handoff() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let key = identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        let mut publisher = local_swarm(&key, false);
        let mut seed = local_swarm(&identity::Keypair::generate_ed25519(), true);
        let mut client = Discovery::new(identity::Keypair::generate_ed25519()).unwrap();
        // Replace all production seeds before polling: no public DNS/socket activity.
        client.swarm = local_swarm(&client.key, false);
        let seed_id = *seed.local_peer_id(); let seed_addr = listen(&mut seed).await;
        let publisher_addr = listen(&mut publisher).await;
        publisher.add_external_address(publisher_addr);
        publisher.behaviour_mut().kad.add_address(&seed_id, seed_addr.clone());
        client.swarm.behaviour_mut().kad.add_address(&seed_id, seed_addr);
        let publish = publisher.behaviour_mut().kad.start_providing(provider_key(WORLD_NAMESPACE)).unwrap();
        let mut stored = false; let mut published = false; let mut started = false;
        let mut native_handoff = None;
        while native_handoff.is_none() {
            tokio::select! {
                event = seed.select_next_some() => {
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
                candidate = client.next(), if started => { native_handoff = candidate; }
            }
            if published && stored && !started { client.tick(1001); started = true; }
        }
        let candidate = native_handoff.unwrap();
        assert_eq!(candidate.peer, peer); assert_eq!(candidate.endpoints.len(), 1); assert!(!candidate.relay_opt_in);
        assert!(client.contains(&peer)); assert!(client.pending.is_empty());
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
    let mut swarm = Discovery::new_swarm(&key, DialBudget::new()).unwrap();
    let query = swarm
        .behaviour_mut()
        .kad
        .get_providers(provider_key(&namespace));
    let begin = Instant::now();
    let mut connections = 0u32;
    let mut errors = 0u32;
    let mut successes = 0u32;
    let mut requests = 0u32;
    let mut completed = false;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match swarm.select_next_some().await {
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
                )) if id == query => {
                    successes = stats.num_successes();
                    requests = stats.num_requests();
                    if step.last {
                        completed = matches!(result, kad::QueryResult::GetProviders(Ok(_)));
                        break;
                    }
                }
                _ => {}
            }
        }
    })
    .await;
    drop(swarm);
    let interoperable = result.is_ok() && completed && successes > 0 && connections > 0;
    let report = serde_json::json!({
        "schema": 1, "kind": "konofix-amino-read-only-interop", "source_commit": env!("KONOFIX_SOURCE_COMMIT"),
        "started_unix": started, "elapsed_ms": begin.elapsed().as_millis(), "namespace": namespace,
        "outcome": if interoperable { "RPC_INTEROPERABILITY_PASS" } else { "NO_COMPLETED_INTEROPERABILITY_PROOF" },
        "authenticated_connections": connections, "outgoing_errors": errors,
        "query_requests": requests, "query_successes": successes, "query_completed": completed,
        "deadline_exceeded": result.is_err(), "provider_writes": 0, "value_writes": 0,
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
