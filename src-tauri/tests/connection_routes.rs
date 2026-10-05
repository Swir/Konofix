#[path = "../src/connection_routes.rs"]
mod connection_routes;

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
async fn failed_direct_attempt_then_real_circuit_is_reported_without_confusing_reservations() {
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
    // A temporary closed listener supplies a genuinely failing direct TCP endpoint.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let direct: Multiaddr = format!(
        "/ip4/127.0.0.1/tcp/{}/p2p/{b_id}",
        closed.local_addr().unwrap().port()
    )
    .parse()
    .unwrap();
    drop(closed);
    let mut direct_failed = false;
    let mut circuit = None;
    let mut fallback_started = false;
    let mut ping_a = false;
    let mut ping_b = false;
    a.dial(direct).unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            tokio::select! {
                event = relay.select_next_some() => if let SwarmEvent::NewListenAddr { address, .. } = event {
                    relay.add_external_address(address.clone());
                    b.listen_on(address.with(Protocol::P2p(relay_id)).with(Protocol::P2pCircuit)).unwrap();
                },
                event = a.select_next_some() => match event {
                    SwarmEvent::OutgoingConnectionError { peer_id: Some(peer), .. } if peer == b_id => {
                        assert!(!fallback_started, "controlled direct failure must precede fallback");
                        direct_failed = true;
                    }
                    SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                        routes_a.established(connection_id, peer_id, &endpoint);
                    }
                    SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == b_id => ping_a = true,
                    _ => {}
                },
                event = b.select_next_some() => match event {
                    SwarmEvent::NewListenAddr { address, .. } if address.iter().any(|p| p == Protocol::P2pCircuit) => {
                        assert!(routes_b.snapshot().iter().all(|r| r.path == "direct"), "a reservation is not a circuit connection");
                        circuit = Some(address);
                    }
                    SwarmEvent::ConnectionEstablished { connection_id, peer_id, endpoint, .. } => {
                        routes_b.established(connection_id, peer_id, &endpoint);
                    }
                    SwarmEvent::Behaviour(ProbeEvent::Ping(ping::Event { peer, result: Ok(_), .. })) if peer == a_id => ping_b = true,
                    _ => {}
                },
            }
            if direct_failed && !fallback_started {
                if let Some(address) = circuit.take() {
                    a.dial(address).unwrap();
                    fallback_started = true;
                }
            }
            if ping_a && ping_b { break; }
        }
    }).await.expect("real authenticated circuit after a failed direct dial");
    for (routes, peer) in [(&routes_a, b_id), (&routes_b, a_id)] {
        let peer_routes: Vec<_> = routes
            .snapshot()
            .into_iter()
            .filter(|r| r.peer_id == peer.to_string())
            .collect();
        assert_eq!(peer_routes.len(), 1);
        assert_eq!(peer_routes[0].path, "relay");
        assert_eq!(peer_routes[0].transport, "circuit");
    }
}
