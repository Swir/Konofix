//! Observations of established connections, never inferred from relay reservations.
use libp2p::{core::ConnectedPoint, multiaddr::Protocol, swarm::ConnectionId, PeerId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ConnectionRoute {
    pub peer_id: String,
    pub connection_id: String,
    pub path: String,
    pub transport: String,
    // An observed remote endpoint is not necessarily a dialable listen address.
    pub remote_address: String,
}

#[derive(Default)]
pub(crate) struct ConnectionRoutes(HashMap<ConnectionId, ConnectionRoute>);

impl ConnectionRoutes {
    pub(crate) fn established(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        endpoint: &ConnectedPoint,
    ) {
        let relayed = endpoint.is_relayed();
        let remote = endpoint.get_remote_address();
        let transport = if relayed {
            "circuit"
        } else if remote.iter().any(|p| matches!(p, Protocol::QuicV1)) {
            "quic-v1"
        } else if remote.iter().any(|p| matches!(p, Protocol::Tcp(_))) {
            "tcp"
        } else {
            "other"
        };
        self.0.insert(
            id,
            ConnectionRoute {
                peer_id: peer.to_string(),
                connection_id: id.to_string(),
                path: if relayed { "relay" } else { "direct" }.into(),
                transport: transport.into(),
                remote_address: remote.to_string(),
            },
        );
    }

    pub(crate) fn closed(&mut self, id: ConnectionId) {
        self.0.remove(&id);
    }

    pub(crate) fn snapshot(&self) -> Vec<ConnectionRoute> {
        let mut routes: Vec<_> = self.0.values().cloned().collect();
        routes.sort_by(|a, b| (&a.peer_id, &a.connection_id).cmp(&(&b.peer_id, &b.connection_id)));
        routes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::{
        core::{transport::PortUse, Endpoint},
        swarm::dial_opts::DialOpts,
    };

    fn outgoing(address: &str) -> ConnectedPoint {
        ConnectedPoint::Dialer {
            address: address.parse().unwrap(),
            role_override: Endpoint::Dialer,
            port_use: PortUse::New,
        }
    }
    fn id() -> ConnectionId {
        DialOpts::unknown_peer_id()
            .address("/ip4/127.0.0.1/tcp/1".parse().unwrap())
            .build()
            .connection_id()
    }

    #[test]
    fn relay_is_decided_by_the_authenticated_endpoint_in_both_directions() {
        let peer = PeerId::random();
        let relay = PeerId::random();
        let mut routes = ConnectionRoutes::default();
        assert!(
            routes.snapshot().is_empty(),
            "addresses/reservations alone create no route"
        );
        let circuit = format!("/ip4/127.0.0.1/tcp/4001/p2p/{relay}/p2p-circuit");
        // On an inbound circuit, only local_addr is guaranteed to identify the relay.
        routes.established(
            id(),
            peer,
            &ConnectedPoint::Listener {
                local_addr: circuit.parse().unwrap(),
                send_back_addr: format!("/p2p/{peer}").parse().unwrap(),
            },
        );
        routes.established(id(), peer, &outgoing(&format!("{circuit}/p2p/{peer}")));
        assert!(routes
            .snapshot()
            .iter()
            .all(|r| r.path == "relay" && r.transport == "circuit"));
        assert!(routes
            .snapshot()
            .iter()
            .all(|r| r.peer_id == peer.to_string()));
    }

    #[test]
    fn closing_one_route_keeps_other_routes_to_the_same_peer() {
        let peer = PeerId::random();
        let mut routes = ConnectionRoutes::default();
        let tcp = id();
        let quic = id();
        routes.established(tcp, peer, &outgoing("/ip4/127.0.0.1/tcp/4001"));
        routes.established(quic, peer, &outgoing("/ip4/127.0.0.1/udp/4001/quic-v1"));
        let snapshot = routes.snapshot();
        assert_eq!(snapshot.len(), 2);
        assert!(snapshot.iter().all(|r| r.path == "direct"));
        assert!(snapshot.iter().any(|r| r.transport == "tcp"));
        assert!(snapshot.iter().any(|r| r.transport == "quic-v1"));
        routes.closed(tcp);
        routes.closed(tcp);
        routes.closed(id());
        assert_eq!(routes.snapshot().len(), 1);
        assert_eq!(routes.snapshot()[0].transport, "quic-v1");
        routes.closed(quic);
        assert!(routes.snapshot().is_empty());
    }
}
