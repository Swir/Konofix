#[path = "../src/connection_routes.rs"]
mod connection_routes;
#[path = "../src/direct_first.rs"]
mod direct_first;

use connection_routes::ConnectionRoutes;
use futures::StreamExt;
use libp2p::{
    multiaddr::Protocol,
    noise, ping, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, Swarm, SwarmBuilder,
};
use std::time::Duration;

#[derive(NetworkBehaviour)]
struct Probe {
    relay: relay::client::Behaviour,
    ping: ping::Behaviour,
}

fn probe() -> Swarm<Probe> {
    SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .unwrap()
        .with_quic()
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .unwrap()
        .with_behaviour(|_, relay| Probe {
            relay,
            ping: ping::Behaviour::new(
                ping::Config::new().with_interval(Duration::from_millis(100)),
            ),
        })
        .unwrap()
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(30)))
        .build()
}

#[tokio::test]
async fn real_tcp_and_quic_endpoints_are_observed_as_direct() {
    for (listen, transport) in [
        ("/ip4/127.0.0.1/tcp/0", "tcp"),
        ("/ip4/127.0.0.1/udp/0/quic-v1", "quic-v1"),
    ] {
        let mut a = probe();
        let mut b = probe();
        let a_id = *a.local_peer_id();
        let b_id = *b.local_peer_id();
        let mut routes_a = ConnectionRoutes::default();
        let mut routes_b = ConnectionRoutes::default();
        b.listen_on(listen.parse().unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut ping_a = false; let mut ping_b = false;
            loop {
                tokio::select! {
                    event = a.select_next_some() => match event {
                        SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                            assert_eq!(peer_id, b_id);
                            routes_a.established(connection_id, peer_id, &endpoint);
                        }
                        SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == b_id => ping_a = true,
                        _ => {}
                    },
                    event = b.select_next_some() => match event {
                        SwarmEvent::NewListenAddr { address, .. } => a.dial(address.with(Protocol::P2p(b_id))).unwrap(),
                        SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                            assert_eq!(peer_id, a_id);
                            routes_b.established(connection_id, peer_id, &endpoint);
                        }
                        SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == a_id => ping_b = true,
                        _ => {}
                    },
                }
                if ping_a && ping_b { break; }
            }
        }).await.expect("real authenticated direct ping in both directions");
        for routes in [&routes_a, &routes_b] {
            assert_eq!(routes.snapshot().len(), 1);
            assert_eq!(routes.snapshot()[0].path, "direct");
            assert_eq!(routes.snapshot()[0].transport, transport);
        }
    }
}

// Controlled loopback transport regression, not physical WAN/CGNAT acceptance.
#[tokio::test]
async fn remembered_direct_is_preferred_and_circuit_fallback_requires_direct_failure() {
    for direct_available in [true, false] {
        cached_route_case(direct_available).await;
    }
}

async fn cached_route_case(direct_available: bool) {
    use std::time::Instant;
    let mut relay = SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .unwrap()
        .with_behaviour(|key| {
            relay::Behaviour::new(key.public().to_peer_id(), relay::Config::default())
        })
        .unwrap()
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(30)))
        .build();
    let relay_id = *relay.local_peer_id();
    relay
        .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
        .unwrap();
    let mut a = probe();
    let mut b = probe();
    let a_id = *a.local_peer_id();
    let b_id = *b.local_peer_id();
    let mut routes_a = ConnectionRoutes::default();
    let mut routes_b = ConnectionRoutes::default();
    let mut direct_address = None;
    if direct_available {
        b.listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
    } else {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        direct_address = Some(
            format!(
                "/ip4/127.0.0.1/tcp/{}/p2p/{b_id}",
                closed.local_addr().unwrap().port()
            )
            .parse::<Multiaddr>()
            .unwrap(),
        );
        drop(closed);
    }
    let mut dials = direct_first::DirectFirstDials::default();
    let mut direct_failed = false;
    let mut circuit = None;
    let mut queued = false;
    let mut circuit_attempted = false;
    let mut ping_a = false;
    let mut ping_b = false;
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    dials.drive(&mut a, Instant::now(), |_, peer, address| {
                        assert_eq!(peer, b_id);
                        if address.iter().any(|p| p == Protocol::P2pCircuit) {
                            assert!(direct_failed && !direct_available, "fallback cannot precede failure or race a working direct route");
                            circuit_attempted = true;
                        }
                    });
                }
                event = relay.select_next_some() => if let SwarmEvent::NewListenAddr { address, .. } = event {
                    relay.add_external_address(address.clone());
                    b.listen_on(address.with(Protocol::P2p(relay_id)).with(Protocol::P2pCircuit)).unwrap();
                },
                event = a.select_next_some() => match event {
                    SwarmEvent::OutgoingConnectionError { peer_id: Some(peer), connection_id, .. } if peer == b_id => {
                        assert!(!circuit_attempted, "only the controlled direct dial is expected to fail");
                        assert!(!direct_available);
                        direct_failed = true;
                        dials.failed(connection_id, Instant::now());
                    }
                    SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                        dials.connected(peer_id);
                        routes_a.established(connection_id, peer_id, &endpoint);
                    }
                    SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == b_id => ping_a = true,
                    _ => {}
                },
                event = b.select_next_some() => match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        if address.iter().any(|p| p == Protocol::P2pCircuit) {
                            assert!(routes_b.snapshot().iter().all(|r| r.path == "direct"), "a reservation is not a circuit connection");
                            circuit = Some(address);
                        } else {
                            direct_address = Some(address.with(Protocol::P2p(b_id)));
                        }
                    }
                    SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                        routes_b.established(connection_id, peer_id, &endpoint);
                    }
                    SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == a_id => ping_b = true,
                    _ => {}
                },
            }
            if !queued {
                if let (Some(circuit), Some(direct)) = (&circuit, &direct_address) {
                    // Relay is deliberately first in cache order; production scheduling must reorder it.
                    dials.enqueue(b_id, vec![circuit.clone(), direct.clone()], Instant::now());
                    queued = true;
                }
            }
            if ping_a && ping_b { break; }
        }
    }).await.expect("authenticated direct or controlled cached circuit fallback");
    assert_eq!(circuit_attempted, !direct_available);
    assert_eq!(direct_failed, !direct_available);
    for (routes, peer) in [(&routes_a, b_id), (&routes_b, a_id)] {
        let peer_routes: Vec<_> = routes
            .snapshot()
            .into_iter()
            .filter(|r| r.peer_id == peer.to_string())
            .collect();
        assert_eq!(peer_routes.len(), 1);
        assert_eq!(
            peer_routes[0].path,
            if direct_available { "direct" } else { "relay" }
        );
        assert_eq!(
            peer_routes[0].transport,
            if direct_available { "tcp" } else { "circuit" }
        );
    }
}
