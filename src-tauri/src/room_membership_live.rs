use libp2p::PeerId;

use crate::room_membership::RoomCountChange;
use crate::room_membership_network::{
    MembershipTransportEffects, RemoteTransportEffects, RoomMembershipNetwork,
    RoomMembershipNetworkEvent, RoomMembershipTransportError,
};

/// Runtime-facing coordinator for the final Rooms 2.0 production wiring layer.
///
/// It keeps network-task lifecycle semantics explicit and testable before the
/// coordinator is embedded into the large Tauri/libp2p event loop. In
/// particular, a transient connection close must not erase membership while
/// another connection to the same peer remains established.
#[derive(Debug)]
pub struct RoomMembershipLiveCoordinator {
    network: RoomMembershipNetwork,
}

impl RoomMembershipLiveCoordinator {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            network: RoomMembershipNetwork::new(local_peer),
        }
    }

    pub fn announce_room(&mut self, room_id: &str) -> Result<bool, RoomMembershipTransportError> {
        self.network.register_announced_room(room_id)
    }

    pub fn create_and_enter_local_room(
        &mut self,
        room_id: &str,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.network.create_and_enter_local_room(room_id)
    }

    pub fn enter_room(
        &mut self,
        room_id: Option<&str>,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.network.enter_room(room_id)
    }

    /// Returns a resync event without advancing the local membership revision.
    pub fn heartbeat_event(&self) -> Option<RoomMembershipNetworkEvent> {
        self.network.heartbeat_event()
    }

    /// Accepts an already-decoded membership event from the production
    /// GossipSub envelope while still enforcing the transport size cap and the
    /// authenticated-source binding before state mutation.
    pub fn receive_authenticated_event(
        &mut self,
        event: &RoomMembershipNetworkEvent,
        authenticated_source: &PeerId,
    ) -> Result<RemoteTransportEffects, RoomMembershipTransportError> {
        let frame = RoomMembershipNetwork::encode_event(event)?;
        self.network
            .receive_authenticated(&frame, authenticated_source)
    }

    /// Bridges decoded production `WireEvent` fields into the verified
    /// membership transport without duplicating source-binding, replay or room
    /// validation inside the large network event loop.
    pub fn receive_authenticated_snapshot(
        &mut self,
        peer_id: String,
        revision: u64,
        rooms: Vec<String>,
        authenticated_source: &PeerId,
    ) -> Result<RemoteTransportEffects, RoomMembershipTransportError> {
        self.receive_authenticated_event(
            &RoomMembershipNetworkEvent::MembershipSnapshot {
                peer_id,
                revision,
                rooms,
            },
            authenticated_source,
        )
    }

    /// A libp2p peer may have multiple simultaneous connections. Only the final
    /// connection close is allowed to clear the peer's room membership.
    pub fn connection_closed(
        &mut self,
        peer_id: &PeerId,
        remaining_established: u32,
    ) -> Vec<RoomCountChange> {
        if remaining_established == 0 {
            self.network.peer_departed(peer_id)
        } else {
            Vec::new()
        }
    }

    /// Call only after the outer signed `WireEvent::Goodbye` has been bound to
    /// its authenticated GossipSub source.
    pub fn authenticated_goodbye(&mut self, peer_id: &PeerId) -> Vec<RoomCountChange> {
        self.network.peer_departed(peer_id)
    }

    /// Presence expiry is another authoritative departure path. Cleanup is
    /// idempotent, so a prior final disconnect/goodbye cannot double-decrement.
    pub fn presence_expired(&mut self, peer_id: &PeerId) -> Vec<RoomCountChange> {
        self.network.peer_departed(peer_id)
    }

    /// Removes a room from the known registry. If the local user was inside it,
    /// the returned effects include the monotonic leave snapshot that must be
    /// republished by the production network task.
    pub fn room_closed(
        &mut self,
        room_id: &str,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.network.close_room(room_id)
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        self.network.total_count(room_id)
    }

    pub fn known_room(&self, room_id: &str) -> bool {
        self.network.known_room(room_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn peer_id() -> PeerId {
        Keypair::generate_ed25519().public().to_peer_id()
    }

    fn snapshot(peer: &PeerId, revision: u64, room: &str) -> RoomMembershipNetworkEvent {
        RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id: peer.to_string(),
            revision,
            rooms: vec![room.to_string()],
        }
    }

    #[test]
    fn decoded_snapshot_bridge_preserves_source_binding_and_replay_semantics() {
        let local = peer_id();
        let remote = peer_id();
        let attacker = peer_id();
        let mut live = RoomMembershipLiveCoordinator::new(local);
        live.announce_room("alpha").expect("announce alpha");

        assert!(live
            .receive_authenticated_snapshot(remote.to_string(), 1, vec!["alpha".into()], &attacker,)
            .is_err());
        assert_eq!(live.total_count("alpha"), 0);

        assert_eq!(
            live.receive_authenticated_snapshot(
                remote.to_string(),
                1,
                vec!["alpha".into()],
                &remote,
            )
            .expect("authenticated snapshot"),
            RemoteTransportEffects::Applied(vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 1,
            }])
        );
        assert_eq!(
            live.receive_authenticated_snapshot(
                remote.to_string(),
                1,
                vec!["alpha".into()],
                &remote,
            )
            .expect("duplicate snapshot"),
            RemoteTransportEffects::Duplicate
        );
        assert_eq!(live.total_count("alpha"), 1);
    }

    #[test]
    fn only_final_connection_close_removes_remote_membership() {
        let local = peer_id();
        let remote = peer_id();
        let mut live = RoomMembershipLiveCoordinator::new(local);
        live.announce_room("alpha").expect("announce alpha");
        live.receive_authenticated_event(&snapshot(&remote, 1, "alpha"), &remote)
            .expect("remote joins");
        assert_eq!(live.total_count("alpha"), 1);

        assert!(live.connection_closed(&remote, 1).is_empty());
        assert_eq!(live.total_count("alpha"), 1);
        assert_eq!(
            live.connection_closed(&remote, 0),
            vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 0,
            }]
        );
        assert_eq!(live.total_count("alpha"), 0);
        assert!(live.connection_closed(&remote, 0).is_empty());
    }

    #[test]
    fn goodbye_and_presence_expiry_are_idempotent_departure_paths() {
        let local = peer_id();
        let remote = peer_id();
        let mut live = RoomMembershipLiveCoordinator::new(local);
        live.announce_room("alpha").expect("announce alpha");

        live.receive_authenticated_event(&snapshot(&remote, 1, "alpha"), &remote)
            .expect("first join");
        assert_eq!(live.authenticated_goodbye(&remote).len(), 1);
        assert!(live.authenticated_goodbye(&remote).is_empty());

        live.receive_authenticated_event(&snapshot(&remote, 2, "alpha"), &remote)
            .expect("second join");
        assert_eq!(live.presence_expired(&remote).len(), 1);
        assert!(live.presence_expired(&remote).is_empty());
        assert_eq!(live.total_count("alpha"), 0);
    }

    #[test]
    fn room_close_republishes_local_leave_and_zeroes_count() {
        let local = peer_id();
        let mut live = RoomMembershipLiveCoordinator::new(local.clone());
        let created = live
            .create_and_enter_local_room("alpha")
            .expect("create alpha");
        let created_revision = match created.publish.expect("join snapshot") {
            RoomMembershipNetworkEvent::MembershipSnapshot { revision, .. } => revision,
        };
        assert_eq!(live.total_count("alpha"), 1);

        let closed = live.room_closed("alpha").expect("close alpha");
        assert_eq!(
            closed.counts,
            vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 0,
            }]
        );
        match closed.publish.expect("leave snapshot") {
            RoomMembershipNetworkEvent::MembershipSnapshot {
                peer_id,
                revision,
                rooms,
            } => {
                assert_eq!(peer_id, local.to_string());
                assert_eq!(revision, created_revision + 1);
                assert!(rooms.is_empty());
            }
        }
        assert!(!live.known_room("alpha"));
    }

    #[test]
    fn heartbeat_is_revision_stable_across_resyncs() {
        let mut live = RoomMembershipLiveCoordinator::new(peer_id());
        live.announce_room("alpha").expect("announce alpha");
        let join = live.enter_room(Some("alpha")).expect("join alpha");
        let published = join.publish.expect("join snapshot");
        assert_eq!(live.heartbeat_event(), Some(published.clone()));
        assert_eq!(live.heartbeat_event(), Some(published));
    }
}
