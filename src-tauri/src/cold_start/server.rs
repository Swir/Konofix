//! Bounded on-demand signed advertisements on the native application transport.
use super::{public_endpoint, Advertisement, Request, MAX_ENDPOINTS};
use libp2p::{identity, Multiaddr, PeerId};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub struct Server {
    key: identity::Keypair,
    sequence: u64,
    window: Instant,
    responses: usize,
    peers: HashMap<PeerId, Instant>,
}
impl Server {
    pub fn new(key: identity::Keypair) -> Self {
        Self {
            key,
            sequence: 0,
            window: Instant::now(),
            responses: 0,
            peers: HashMap::new(),
        }
    }
    pub fn respond(
        &mut self,
        peer: PeerId,
        request: &Request,
        endpoints: &[Multiaddr],
        relay: bool,
        unix: u64,
    ) -> Option<Advertisement> {
        let now = Instant::now();
        if now.duration_since(self.window) >= Duration::from_secs(60) {
            self.window = now;
            self.responses = 0;
        }
        self.peers
            .retain(|_, last| now.duration_since(*last) < Duration::from_secs(15));
        if self.responses >= 16 || self.peers.contains_key(&peer) || self.peers.len() >= 128 {
            return None;
        }
        self.responses += 1;
        self.peers.insert(peer, now);
        let local = self.key.public().to_peer_id();
        let mut endpoints: Vec<_> = endpoints
            .iter()
            .filter_map(|a| public_endpoint(&a.to_string(), local))
            .map(|a| a.to_string())
            .collect();
        endpoints.sort();
        endpoints.dedup();
        endpoints.truncate(MAX_ENDPOINTS);
        self.sequence = self.sequence.checked_add(1)?;
        Advertisement::sign(
            &self.key,
            peer,
            request,
            unix,
            self.sequence,
            endpoints,
            relay,
        )
        .ok()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_rate_limited_and_claims_use_current_native_endpoints() {
        let key = identity::Keypair::generate_ed25519();
        let local = key.public().to_peer_id();
        let mut server = Server::new(key);
        let request = Request::fresh();
        let endpoint = format!("/ip4/8.8.8.8/tcp/1/p2p/{local}").parse().unwrap();
        let peer = PeerId::random();
        assert!(server
            .respond(peer, &request, std::slice::from_ref(&endpoint), false, 1000)
            .is_some());
        assert!(server
            .respond(peer, &request, std::slice::from_ref(&endpoint), false, 1000)
            .is_none());
        for _ in 1..16 {
            assert!(server
                .respond(
                    PeerId::random(),
                    &request,
                    std::slice::from_ref(&endpoint),
                    false,
                    1000
                )
                .is_some());
        }
        assert!(server
            .respond(PeerId::random(), &request, &[endpoint], false, 1000)
            .is_none());
    }
}
