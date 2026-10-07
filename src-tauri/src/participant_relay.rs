//! Desktop relay participation: explicit session consent and fresh reachability.
use libp2p::{relay, PeerId};
use std::{
    collections::HashSet,
    num::NonZeroU32,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub(crate) struct Participation {
    consent: bool,
    reachable_until: Option<Instant>,
    gate: Arc<AtomicBool>,
    clients: HashSet<PeerId>,
}
impl Participation {
    pub(crate) fn new(consent: bool) -> Self {
        Self {
            consent,
            reachable_until: None,
            gate: Arc::new(AtomicBool::new(false)),
            clients: HashSet::new(),
        }
    }
    pub(crate) fn behaviour(&self, peer: PeerId) -> relay::Behaviour {
        let mut config = relay::Config {
            max_reservations: 8,
            // libp2p-relay 0.22 compares the existing count with `>` before
            // admission. Zero therefore permits exactly one; wire test below
            // protects this pinned-version workaround against dependency drift.
            max_reservations_per_peer: 0,
            reservation_duration: Duration::from_secs(120),
            max_circuits: 2,
            max_circuits_per_peer: 0,
            max_circuit_duration: Duration::from_secs(120),
            max_circuit_bytes: 8 * 1024 * 1024,
            ..Default::default()
        }
        .reservation_rate_per_peer(NonZeroU32::new(2).unwrap(), Duration::from_secs(60))
        .reservation_rate_per_ip(NonZeroU32::new(4).unwrap(), Duration::from_secs(60))
        .circuit_src_per_peer(NonZeroU32::new(2).unwrap(), Duration::from_secs(60))
        .circuit_src_per_ip(NonZeroU32::new(4).unwrap(), Duration::from_secs(60));
        // Gate requests already negotiated before Status::Disable reaches handlers.
        let gate = self.gate.clone();
        config.reservation_rate_limiters.insert(
            0,
            Box::new(move |_, _: &libp2p::Multiaddr, _| gate.load(Ordering::SeqCst)),
        );
        let gate = self.gate.clone();
        config.circuit_src_rate_limiters.insert(
            0,
            Box::new(move |_, _: &libp2p::Multiaddr, _| gate.load(Ordering::SeqCst)),
        );
        // Global admission, shared across peer/IP identities: at most 8 circuits/minute.
        let mut window = Instant::now();
        let mut count = 0u8;
        config
            .circuit_src_rate_limiters
            .push(Box::new(move |_, _: &libp2p::Multiaddr, _| {
                let now = Instant::now();
                if now.duration_since(window) >= Duration::from_secs(60) {
                    window = now;
                    count = 0;
                }
                if count >= 8 {
                    return false;
                }
                count += 1;
                true
            }));
        let mut behaviour = relay::Behaviour::new(peer, config);
        behaviour.set_status(Some(relay::Status::Disable));
        behaviour
    }
    pub(crate) fn public_probe(&mut self, now: Instant) {
        self.reachable_until = Some(now + Duration::from_secs(300));
    }
    pub(crate) fn invalidate(&mut self) {
        self.reachable_until = None;
        self.gate.store(false, Ordering::SeqCst);
    }
    pub(crate) fn enabled(&self, now: Instant) -> bool {
        self.consent && self.reachable_until.is_some_and(|until| now < until)
    }
    pub(crate) fn reachable(&self, now: Instant) -> bool {
        self.reachable_until.is_some_and(|until| now < until)
    }
    pub(crate) fn update(&mut self, behaviour: &mut relay::Behaviour, now: Instant) -> Vec<PeerId> {
        let enabled = self.enabled(now);
        self.gate.store(enabled, Ordering::SeqCst);
        behaviour.set_status(Some(if enabled {
            relay::Status::Enable
        } else {
            relay::Status::Disable
        }));
        if enabled {
            Vec::new()
        } else {
            self.clients.drain().collect()
        }
    }
    pub(crate) fn observe(&mut self, event: &relay::Event) {
        match event {
            relay::Event::ReservationReqAccepted { src_peer_id, .. } => {
                self.clients.insert(*src_peer_id);
            }
            relay::Event::CircuitReqAccepted {
                src_peer_id,
                dst_peer_id,
            } => {
                self.clients.insert(*src_peer_id);
                self.clients.insert(*dst_peer_id);
            }
            _ => {}
        }
        // No unbounded history: stale participants are removed on final disconnect.
    }
    pub(crate) fn disconnected(&mut self, peer: &PeerId) {
        self.clients.remove(peer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_and_current_public_probe_are_both_required() {
        let now = Instant::now();
        let mut off = Participation::new(false);
        off.public_probe(now);
        assert!(!off.enabled(now));
        assert!(off.reachable(now));
        let mut on = Participation::new(true);
        assert!(!on.enabled(now));
        let mut server = on.behaviour(PeerId::random());
        on.public_probe(now);
        assert!(on.enabled(now));
        assert!(on.update(&mut server, now).is_empty());
        let client = PeerId::random();
        on.observe(&relay::Event::ReservationReqAccepted {
            src_peer_id: client,
            renewed: false,
        });
        on.invalidate();
        assert!(!on.enabled(now));
        assert_eq!(on.update(&mut server, now), vec![client]);
        assert!(on.update(&mut server, now).is_empty());
        on.public_probe(now);
        assert!(!on.enabled(now + Duration::from_secs(300)));
        on.disconnected(&client);
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use futures::StreamExt;
    use libp2p::{
        identity, noise, ping,
        swarm::{NetworkBehaviour, SwarmEvent},
        tcp, yamux, Multiaddr, Swarm, SwarmBuilder,
    };
    #[derive(NetworkBehaviour)]
    struct Host {
        relay: relay::Behaviour,
        ping: ping::Behaviour,
    }
    #[derive(NetworkBehaviour)]
    struct Client {
        relay: relay::client::Behaviour,
        ping: ping::Behaviour,
    }
    fn client(key: identity::Keypair) -> Swarm<Client> {
        SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .unwrap()
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .unwrap()
            .with_behaviour(|_, relay| Client {
                relay,
                ping: ping::Behaviour::default(),
            })
            .unwrap()
            .build()
    }
    #[tokio::test]
    async fn production_relay_policy_rejects_second_reservation_for_same_authenticated_peer() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut policy = Participation::new(true);
            let mut host = SwarmBuilder::with_new_identity().with_tokio()
                .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default).unwrap()
                .with_behaviour(|key| Host { relay: policy.behaviour(key.public().to_peer_id()), ping: ping::Behaviour::default() }).unwrap().build();
            host.listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap()).unwrap();
            let address: Multiaddr = loop {
                if let SwarmEvent::NewListenAddr { address, .. } = host.select_next_some().await { break address; }
            };
            host.add_external_address(address.clone());
            // Deliberate local test input to the policy, NOT public reachability proof.
            policy.public_probe(Instant::now());
            policy.update(&mut host.behaviour_mut().relay, Instant::now());
            let key = identity::Keypair::generate_ed25519(); let peer = key.public().to_peer_id();
            let mut first = client(key.clone()); let mut second = client(key);
            let circuit: Multiaddr = format!("{address}/p2p/{}/p2p-circuit", host.local_peer_id()).parse().unwrap();
            first.listen_on(circuit.clone()).unwrap();
            let mut first_accepted = false; let mut second_started = false;
            loop {
                tokio::select! {
                    event = host.select_next_some() => {
                        if let SwarmEvent::Behaviour(HostEvent::Relay(event)) = event {
                            policy.observe(&event);
                            if let relay::Event::ReservationReqDenied { src_peer_id, status } = event {
                                assert!(first_accepted); assert!(second_started); assert_eq!(src_peer_id, peer);
                                assert!(matches!(status, relay::StatusCode::ResourceLimitExceeded)); break;
                            }
                        }
                    }
                    event = first.select_next_some() => {
                        if matches!(event, SwarmEvent::Behaviour(ClientEvent::Relay(relay::client::Event::ReservationReqAccepted { .. }))) { first_accepted = true; }
                    }
                    _ = second.select_next_some(), if second_started => {}
                }
                if first_accepted && !second_started { second.listen_on(circuit.clone()).unwrap(); second_started = true; }
            }
            policy.invalidate();
            assert_eq!(policy.update(&mut host.behaviour_mut().relay, Instant::now()), vec![peer]);
        }).await.expect("bounded local relay admission exceeded 10 seconds");
    }
}
