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
            max_reservations_per_peer: 1,
            reservation_duration: Duration::from_secs(120),
            max_circuits: 2,
            max_circuits_per_peer: 1,
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
