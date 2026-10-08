//! Correlate a remote AutoNAT response with a real native inbound connection.
use super::public_endpoint;
use libp2p::{
    core::ConnectedPoint, multiaddr::Protocol, swarm::NetworkBehaviour, Multiaddr, PeerId, Swarm,
};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Witness {
    inbound: HashMap<PeerId, (Vec<(bool, u16)>, Instant)>,
    responses: HashMap<PeerId, (Multiaddr, Instant)>,
    confirmed: HashMap<Multiaddr, Instant>,
    owned_external: HashSet<Multiaddr>,
}
pub(super) fn port(address: &Multiaddr) -> Option<(bool, u16)> {
    let tcp = address.iter().find_map(|p| {
        if let Protocol::Tcp(port) = p {
            Some((false, port))
        } else {
            None
        }
    });
    tcp.or_else(|| {
        address.iter().find_map(|p| {
            if let Protocol::Udp(port) = p {
                Some((true, port))
            } else {
                None
            }
        })
    })
}
impl Witness {
    pub fn clear(&mut self) {
        self.inbound.clear();
        self.responses.clear();
        self.confirmed.clear();
        // Keep ownership until sync_external withdraws our announcements.
    }
    /// Reconcile only addresses introduced by this witness. Pre-existing native
    /// UPnP/AutoNAT/relay addresses belong to their existing behaviours.
    pub fn sync_external<B: NetworkBehaviour>(&mut self, swarm: &mut Swarm<B>, now: Instant) {
        self.expire(now);
        let current = self.endpoints(now);
        self.owned_external.retain(|address| {
            if current.contains(address) {
                true
            } else {
                swarm.remove_external_address(address);
                false
            }
        });
        for address in current {
            if !swarm
                .external_addresses()
                .any(|existing| existing == &address)
            {
                swarm.add_external_address(address.clone());
                self.owned_external.insert(address);
            }
        }
    }
    pub fn endpoints(&self, now: Instant) -> Vec<Multiaddr> {
        let mut endpoints: Vec<_> = self
            .confirmed
            .iter()
            .filter(|(_, until)| now < **until)
            .map(|(address, _)| address.clone())
            .collect();
        endpoints.sort();
        endpoints
    }
    fn expire(&mut self, now: Instant) {
        self.confirmed.retain(|_, until| now < *until);
        self.inbound
            .retain(|_, (_, at)| now.duration_since(*at) < Duration::from_secs(30));
        self.responses
            .retain(|_, (_, at)| now.duration_since(*at) < Duration::from_secs(30));
    }
    fn matched(&mut self, peer: PeerId, now: Instant) -> Option<Multiaddr> {
        let (address, _) = self.responses.get(&peer)?;
        let (ports, _) = self.inbound.get(&peer)?;
        if !ports.contains(&port(address)?) {
            return None;
        }
        let (address, _) = self.responses.remove(&peer)?;
        if self.confirmed.len() >= super::MAX_ENDPOINTS && !self.confirmed.contains_key(&address) {
            return None;
        }
        self.confirmed
            .insert(address.clone(), now + Duration::from_secs(300));
        Some(address)
    }
    pub fn connection(
        &mut self,
        peer: PeerId,
        endpoint: &ConnectedPoint,
        now: Instant,
    ) -> Option<Multiaddr> {
        self.expire(now);
        let ConnectedPoint::Listener {
            local_addr,
            send_back_addr,
        } = endpoint
        else {
            return None;
        };
        if endpoint.is_relayed() {
            return None;
        }
        let mut remote = send_back_addr.clone();
        if !matches!(remote.iter().last(), Some(Protocol::P2p(_))) {
            remote.push(Protocol::P2p(peer));
        }
        public_endpoint(&remote.to_string(), peer)?;
        if let Some(port) = port(local_addr) {
            if self.inbound.len() < 32 || self.inbound.contains_key(&peer) {
                let (ports, at) = self
                    .inbound
                    .entry(peer)
                    .or_insert_with(|| (Vec::new(), now));
                if ports.len() < 4 && !ports.contains(&port) {
                    ports.push(port);
                }
                *at = now;
            }
        }
        self.matched(peer, now)
    }
    pub fn response(
        &mut self,
        server: PeerId,
        local: PeerId,
        address: Multiaddr,
        now: Instant,
    ) -> Option<Multiaddr> {
        self.expire(now);
        if public_endpoint(&address.to_string(), local).is_none() || super::is_circuit(&address) {
            return None;
        }
        if self.responses.len() < 32 || self.responses.contains_key(&server) {
            self.responses.insert(server, (address, now));
        }
        self.matched(server, now)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assertion_alone_wrong_port_stale_and_previous_network_are_not_proof() {
        let mut witness = Witness::default();
        let server = PeerId::random();
        let local = PeerId::random();
        let now = Instant::now();
        let ad = format!("/ip4/8.8.8.8/tcp/45555/p2p/{local}")
            .parse()
            .unwrap();
        assert!(witness.response(server, local, ad, now).is_none());
        let incoming = ConnectedPoint::Listener {
            local_addr: "/ip4/192.168.1.2/tcp/45555".parse().unwrap(),
            send_back_addr: "/ip4/1.1.1.1/tcp/4001".parse().unwrap(),
        };
        assert!(witness
            .connection(PeerId::random(), &incoming, now)
            .is_none());
        let confirmed = witness.connection(server, &incoming, now).unwrap();
        assert_eq!(witness.endpoints(now), vec![confirmed]);
        assert!(witness.endpoints(now + Duration::from_secs(300)).is_empty());
        witness.clear();
        assert!(witness.endpoints(now).is_empty());
        assert!(witness
            .response(
                server,
                local,
                format!("/ip4/8.8.8.8/tcp/45555/p2p/{local}")
                    .parse()
                    .unwrap(),
                now
            )
            .is_none());
        assert!(witness
            .connection(server, &incoming, now + Duration::from_secs(30))
            .is_none());
        assert!(witness
            .response(
                server,
                local,
                format!("/ip4/8.8.8.8/tcp/45556/p2p/{local}")
                    .parse()
                    .unwrap(),
                now + Duration::from_secs(30)
            )
            .is_none());
    }
}
