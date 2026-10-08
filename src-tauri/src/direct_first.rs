//! Bounded direct-first reconnects from remembered peer addresses.
//! mDNS, DHT, request/response and DCUtR retain their libp2p behaviours.
use libp2p::{
    multiaddr::Protocol,
    swarm::{
        dial_opts::{DialOpts, PeerCondition},
        ConnectionId, DialError, NetworkBehaviour,
    },
    Multiaddr, PeerId, Swarm,
};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

const MAX_PEERS: usize = 128;
const MAX_DIRECT: usize = 8;
const MAX_CIRCUITS: usize = 3;
const PLAN_TTL: Duration = Duration::from_secs(120);

struct Plan {
    peer: PeerId,
    batches: VecDeque<Vec<Multiaddr>>,
    expires: Instant,
}

#[derive(Default)]
pub(crate) struct DirectFirstDials {
    waiting: VecDeque<Plan>,
    pending: HashMap<ConnectionId, Plan>,
}

impl DirectFirstDials {
    pub(crate) fn enqueue(&mut self, peer: PeerId, addresses: Vec<Multiaddr>, now: Instant) {
        if self.waiting.len() + self.pending.len() >= MAX_PEERS
            || self.waiting.iter().any(|p| p.peer == peer)
            || self.pending.values().any(|p| p.peer == peer)
        {
            return;
        }
        let mut direct = Vec::new();
        let mut circuits = Vec::new();
        for address in addresses {
            // Never substitute a relay or a different terminal peer for the recipient.
            if address.iter().last() != Some(Protocol::P2p(peer)) {
                continue;
            }
            let circuit = address.iter().any(|p| p == Protocol::P2pCircuit);
            let (list, cap) = if circuit {
                (&mut circuits, MAX_CIRCUITS)
            } else {
                (&mut direct, MAX_DIRECT)
            };
            if list.len() < cap && !list.contains(&address) {
                list.push(address);
            }
        }
        let mut batches = VecDeque::new();
        if !direct.is_empty() {
            batches.push_back(direct);
        }
        for address in circuits {
            batches.push_back(vec![address]);
        }
        if !batches.is_empty() {
            self.waiting.push_back(Plan {
                peer,
                batches,
                expires: now + PLAN_TTL,
            });
        }
    }

    pub(crate) fn connected(&mut self, peer: PeerId) {
        self.waiting.retain(|p| p.peer != peer);
        self.pending.retain(|_, p| p.peer != peer);
    }

    pub(crate) fn failed(&mut self, id: ConnectionId, now: Instant) {
        if let Some(plan) = self.pending.remove(&id) {
            if now < plan.expires && !plan.batches.is_empty() {
                self.waiting.push_back(plan);
            }
        }
    }

    pub(crate) fn drive<B: NetworkBehaviour>(
        &mut self,
        swarm: &mut Swarm<B>,
        now: Instant,
        mut remember: impl FnMut(&mut B, PeerId, &Multiaddr),
    ) {
        self.pending.retain(|_, p| now < p.expires);
        // Each waiting peer receives at most one attempt per tick. No tight retry loop.
        for _ in 0..self.waiting.len() {
            let Some(mut plan) = self.waiting.pop_front() else {
                break;
            };
            if now >= plan.expires || swarm.is_connected(&plan.peer) {
                continue;
            }
            let Some(addresses) = plan.batches.front() else {
                continue;
            };
            let options = DialOpts::peer_id(plan.peer)
                .condition(PeerCondition::DisconnectedAndNotDialing)
                .addresses(addresses.clone())
                // Do not extend the direct batch with relay addresses from a behaviour.
                .build();
            let id = options.connection_id();
            match swarm.dial(options) {
                Ok(()) => {
                    for address in addresses {
                        remember(swarm.behaviour_mut(), plan.peer, address);
                    }
                    plan.batches.pop_front();
                    self.pending.insert(id, plan);
                }
                Err(DialError::DialPeerConditionFalse(_)) => {
                    // Another discovery path is dialing. Do not count that as direct failure.
                    self.waiting.push_back(plan);
                }
                Err(_) => {
                    plan.batches.pop_front();
                    if !plan.batches.is_empty() {
                        self.waiting.push_back(plan);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn address(peer: PeerId, port: u16, relay: bool) -> Multiaddr {
        let base: Multiaddr = format!("/ip4/127.0.0.1/tcp/{port}").parse().unwrap();
        if relay {
            base.with(Protocol::P2p(PeerId::random()))
                .with(Protocol::P2pCircuit)
                .with(Protocol::P2p(peer))
        } else {
            base.with(Protocol::P2p(peer))
        }
    }

    #[test]
    fn direct_batch_precedes_bounded_circuits_even_when_cache_lists_relay_first() {
        let peer = PeerId::random();
        let now = Instant::now();
        let mut dials = DirectFirstDials::default();
        let mut addresses: Vec<_> = (1..10).map(|p| address(peer, p, true)).collect();
        addresses.extend((10..30).map(|p| address(peer, p, false)));
        addresses.push(address(PeerId::random(), 40, false));
        dials.enqueue(peer, addresses, now);
        dials.enqueue(peer, vec![address(peer, 99, false)], now);
        assert_eq!(dials.waiting.len(), 1);
        let plan = &dials.waiting[0];
        assert_eq!(plan.batches.len(), 4);
        assert_eq!(plan.batches[0].len(), MAX_DIRECT);
        assert!(plan.batches[0]
            .iter()
            .all(|a| !a.iter().any(|p| p == Protocol::P2pCircuit)));
        assert!(plan.batches.iter().skip(1).all(|a| a.len() == 1));
    }

    #[tokio::test]
    async fn competing_discovery_dial_does_not_authorize_relay_fallback() {
        use libp2p::{noise, ping, tcp, yamux, SwarmBuilder};
        let peer = PeerId::random();
        let now = Instant::now();
        let direct = address(peer, 1, false);
        let mut swarm = SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|_| ping::Behaviour::default())
            .unwrap()
            .build();
        // Before polling, this ordinary discovery dial is pending in the swarm.
        swarm.dial(direct.clone()).unwrap();
        let mut dials = DirectFirstDials::default();
        dials.enqueue(peer, vec![address(peer, 2, true), direct.clone()], now);
        dials.drive(&mut swarm, now, |_, _, _| {
            panic!("no new attempt is authorized")
        });
        assert!(dials.pending.is_empty());
        assert_eq!(dials.waiting.len(), 1);
        assert_eq!(dials.waiting[0].batches[0], vec![direct]);
        assert_eq!(dials.waiting[0].batches.len(), 2);
    }

    #[test]
    fn only_matching_failure_advances_and_success_cancels_remaining_fallbacks() {
        let peer = PeerId::random();
        let now = Instant::now();
        let mut dials = DirectFirstDials::default();
        dials.enqueue(
            peer,
            vec![address(peer, 1, false), address(peer, 2, true)],
            now,
        );
        let mut plan = dials.waiting.pop_front().unwrap();
        plan.batches.pop_front();
        let id = DialOpts::peer_id(peer).build().connection_id();
        dials.pending.insert(id, plan);
        dials.failed(DialOpts::peer_id(peer).build().connection_id(), now);
        assert!(dials.waiting.is_empty());
        dials.failed(id, now);
        assert_eq!(dials.waiting.len(), 1);
        dials.connected(peer);
        dials.failed(id, now);
        assert!(dials.waiting.is_empty());
        assert!(dials.pending.is_empty());
    }

    #[test]
    fn expired_and_exhausted_attempts_cannot_recreate_retry_work() {
        let peer = PeerId::random();
        let now = Instant::now();
        let mut dials = DirectFirstDials::default();
        dials.enqueue(
            peer,
            vec![address(peer, 1, false), address(peer, 2, true)],
            now,
        );
        let id = DialOpts::peer_id(peer).build().connection_id();
        dials.pending.insert(id, dials.waiting.pop_front().unwrap());
        dials.failed(id, now + PLAN_TTL);
        assert!(dials.waiting.is_empty());
        assert!(dials.pending.is_empty());
        dials.enqueue(peer, vec![address(peer, 3, false)], now);
        let mut exhausted = dials.waiting.pop_front().unwrap();
        exhausted.batches.clear();
        let id = DialOpts::peer_id(peer).build().connection_id();
        dials.pending.insert(id, exhausted);
        dials.failed(id, now);
        assert!(dials.waiting.is_empty());
        assert!(dials.pending.is_empty());
    }

    #[tokio::test]
    async fn helper_connection_cannot_discard_native_handoff() {
        use futures::StreamExt;
        use libp2p::{identity, noise, ping, swarm::SwarmEvent, tcp, yamux, SwarmBuilder};

        fn local(key: identity::Keypair) -> Swarm<ping::Behaviour> {
            SwarmBuilder::with_existing_identity(key)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default(),
                    noise::Config::new,
                    yamux::Config::default,
                )
                .unwrap()
                .with_behaviour(|_| ping::Behaviour::default())
                .unwrap()
                .build()
        }

        async fn listen(swarm: &mut Swarm<ping::Behaviour>) -> Multiaddr {
            swarm
                .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
                .unwrap();
            loop {
                if let SwarmEvent::NewListenAddr { address, .. } = swarm.select_next_some().await {
                    return address;
                }
            }
        }

        tokio::time::timeout(Duration::from_secs(10), async {
            // A native endpoint and its isolated reader share an authenticated
            // identity, as in production, but are different TCP/Noise swarms.
            let key = identity::Keypair::generate_ed25519();
            let mut target = local(key.clone());
            let mut reader = local(key);
            let mut client = local(identity::Keypair::generate_ed25519());
            let peer = *target.local_peer_id();
            let client_peer = *client.local_peer_id();
            let target_address = listen(&mut target).await.with(Protocol::P2p(peer));
            let client_address = listen(&mut client).await;
            reader.dial(client_address).unwrap();
            let mut client_ready = false;
            let mut reader_ready = false;
            while !client_ready || !reader_ready {
                tokio::select! {
                    event = client.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, .. } = event {
                            assert_eq!(peer_id, peer);
                            client_ready = true;
                        }
                    }
                    event = reader.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, .. } = event {
                            assert_eq!(peer_id, client_peer);
                            reader_ready = true;
                        }
                    }
                }
            }
            assert!(client.is_connected(&peer));
            assert!(!target.is_connected(&client_peer));
            let mut dials = DirectFirstDials::default();
            dials.enqueue(peer, vec![target_address], Instant::now());
            dials.drive(&mut client, Instant::now(), |_, _, _| {});
            assert_eq!(
                dials.waiting.len(),
                1,
                "temporary helper connection discarded the native endpoint plan"
            );

            reader.disconnect_peer_id(client_peer).unwrap();
            while client.is_connected(&peer) {
                tokio::select! {
                    _ = client.select_next_some() => {}
                    _ = reader.select_next_some() => {}
                }
            }
            dials.drive(&mut client, Instant::now(), |_, _, _| {});
            let mut native_ready = false;
            client_ready = false;
            while !native_ready || !client_ready {
                tokio::select! {
                    event = client.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } = event {
                            assert_eq!(peer_id, peer);
                            assert!(endpoint.is_dialer());
                            client_ready = true;
                        }
                    }
                    event = target.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, .. } = event {
                            assert_eq!(peer_id, client_peer);
                            native_ready = true;
                        }
                    }
                    _ = reader.select_next_some() => {}
                }
            }
        })
        .await
        .expect("bounded loopback native handoff exceeded 10 seconds");
    }
}
