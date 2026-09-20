use libp2p::PeerId;

use crate::room_membership_application::{
    ApplicationMembershipEffects, MembershipSnapshotPayload, RoomMembershipApplicationAdapter,
    RoomUserCountUpdate,
};
use crate::room_membership_network::RoomMembershipTransportError;

/// Narrow production-loop boundary for Rooms 2.0 membership effects.
///
/// The large Tauri/libp2p network task should translate its existing lifecycle
/// events into this bridge, then perform only two side effects from the return
/// value:
/// - publish `effects.publish` through the signed GossipSub `WireEvent`, and
/// - emit every `effects.counts` item as `room-user-count` to the frontend.
///
/// Keeping that contract in one place prevents the production loop from
/// reimplementing revision, replay, authenticated-source or count semantics.
#[derive(Debug)]
pub struct RoomMembershipProductionBridge {
    adapter: RoomMembershipApplicationAdapter,
}

impl RoomMembershipProductionBridge {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            adapter: RoomMembershipApplicationAdapter::new(local_peer),
        }
    }

    fn counts_only(counts: Vec<RoomUserCountUpdate>) -> ApplicationMembershipEffects {
        ApplicationMembershipEffects {
            publish: None,
            counts,
        }
    }

    pub fn announce_room(&mut self, room_id: &str) -> Result<bool, RoomMembershipTransportError> {
        self.adapter.announce_room(room_id)
    }

    pub fn create_and_enter_local_room(
        &mut self,
        room_id: &str,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.adapter.create_and_enter_local_room(room_id)
    }

    pub fn enter_room(
        &mut self,
        room_id: &str,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.adapter.enter_room(Some(room_id))
    }

    pub fn enter_world(
        &mut self,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.adapter.enter_room(None)
    }

    /// Heartbeat/resync reuses the last committed snapshot and never creates a
    /// new revision merely because a timer fired.
    pub fn heartbeat(&self) -> ApplicationMembershipEffects {
        ApplicationMembershipEffects {
            publish: self.adapter.heartbeat_payload(),
            counts: Vec::new(),
        }
    }

    /// Accept a snapshot only after the outer signed GossipSub envelope has an
    /// authenticated source. The verified adapter performs source binding,
    /// bounded transport validation and replay/conflict handling before any
    /// count effect can escape this bridge.
    pub fn authenticated_snapshot(
        &mut self,
        payload: MembershipSnapshotPayload,
        authenticated_source: &PeerId,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        let remote = self
            .adapter
            .receive_authenticated_snapshot(payload, authenticated_source)?;
        Ok(Self::counts_only(
            RoomMembershipApplicationAdapter::remote_count_updates(remote),
        ))
    }

    pub fn connection_closed(
        &mut self,
        peer_id: &PeerId,
        remaining_established: u32,
    ) -> ApplicationMembershipEffects {
        Self::counts_only(
            self.adapter
                .connection_closed(peer_id, remaining_established),
        )
    }

    pub fn authenticated_goodbye(&mut self, peer_id: &PeerId) -> ApplicationMembershipEffects {
        Self::counts_only(self.adapter.authenticated_goodbye(peer_id))
    }

    pub fn presence_expired(&mut self, peer_id: &PeerId) -> ApplicationMembershipEffects {
        Self::counts_only(self.adapter.presence_expired(peer_id))
    }

    /// Closing an announced room can also produce a local leave snapshot when
    /// the local user was inside that room, so this path deliberately preserves
    /// both publish and count effects.
    pub fn room_closed(
        &mut self,
        room_id: &str,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.adapter.room_closed(room_id)
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        self.adapter.total_count(room_id)
    }

    pub fn known_room(&self, room_id: &str) -> bool {
        self.adapter.known_room(room_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANY_PEERS: usize = 128;

    fn snapshot(peer: &PeerId, revision: u64, rooms: &[&str]) -> MembershipSnapshotPayload {
        MembershipSnapshotPayload {
            peer_id: peer.to_string(),
            revision,
            rooms: rooms.iter().map(|room| (*room).to_string()).collect(),
        }
    }

    #[test]
    fn many_peer_counts_switch_and_cleanup_converge() {
        let mut bridge = RoomMembershipProductionBridge::new(PeerId::random());
        bridge.announce_room("alpha").expect("announce alpha");
        bridge.announce_room("beta").expect("announce beta");

        let peers: Vec<PeerId> = (0..MANY_PEERS).map(|_| PeerId::random()).collect();
        for (index, peer) in peers.iter().enumerate() {
            let effects = bridge
                .authenticated_snapshot(snapshot(peer, 1, &["alpha"]), peer)
                .expect("join alpha");
            assert!(!effects.counts.is_empty());
            assert_eq!(bridge.total_count("alpha"), (index + 1) as u32);
        }
        assert_eq!(bridge.total_count("alpha"), MANY_PEERS as u32);
        assert_eq!(bridge.total_count("beta"), 0);

        let duplicate = bridge
            .authenticated_snapshot(snapshot(&peers[0], 1, &["alpha"]), &peers[0])
            .expect("duplicate resync");
        assert!(duplicate.counts.is_empty());
        assert_eq!(bridge.total_count("alpha"), MANY_PEERS as u32);

        for peer in peers.iter().take(MANY_PEERS / 2) {
            bridge
                .authenticated_snapshot(snapshot(peer, 2, &["beta"]), peer)
                .expect("switch to beta");
        }
        assert_eq!(bridge.total_count("alpha"), (MANY_PEERS / 2) as u32);
        assert_eq!(bridge.total_count("beta"), (MANY_PEERS / 2) as u32);

        for peer in peers.iter().take(24) {
            let effects = bridge.connection_closed(peer, 1);
            assert!(effects.counts.is_empty());
        }
        assert_eq!(bridge.total_count("beta"), (MANY_PEERS / 2) as u32);

        for peer in peers.iter().take(16) {
            bridge.connection_closed(peer, 0);
        }
        assert_eq!(bridge.total_count("beta"), 48);

        for peer in peers.iter().skip(16).take(16) {
            bridge.authenticated_goodbye(peer);
        }
        assert_eq!(bridge.total_count("beta"), 32);

        for peer in peers.iter().skip(32).take(32) {
            bridge.presence_expired(peer);
        }
        assert_eq!(bridge.total_count("beta"), 0);
        assert_eq!(bridge.total_count("alpha"), (MANY_PEERS / 2) as u32);

        for peer in peers.iter().skip(MANY_PEERS / 2) {
            bridge
                .authenticated_snapshot(snapshot(peer, 2, &[]), peer)
                .expect("leave temporary rooms");
        }
        assert_eq!(bridge.total_count("alpha"), 0);
        assert_eq!(bridge.total_count("beta"), 0);

        assert!(bridge.authenticated_goodbye(&peers[0]).counts.is_empty());
        assert!(bridge.presence_expired(&peers[0]).counts.is_empty());
    }
}
