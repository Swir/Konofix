use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::room_membership::RoomCountChange;
use crate::room_membership_live::RoomMembershipLiveCoordinator;
use crate::room_membership_network::{
    MembershipTransportEffects, RemoteTransportEffects, RoomMembershipNetworkEvent,
    RoomMembershipTransportError,
};

/// Production-friendly membership snapshot payload that can be embedded in the
/// signed application `WireEvent` without exposing the lower-level transport
/// adapter to the Tauri/libp2p event loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MembershipSnapshotPayload {
    pub peer_id: String,
    pub revision: u64,
    pub rooms: Vec<String>,
}

impl From<RoomMembershipNetworkEvent> for MembershipSnapshotPayload {
    fn from(value: RoomMembershipNetworkEvent) -> Self {
        match value {
            RoomMembershipNetworkEvent::MembershipSnapshot {
                peer_id,
                revision,
                rooms,
            } => Self {
                peer_id,
                revision,
                rooms,
            },
        }
    }
}

/// Exact frontend event payload for one verified room-count transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomUserCountUpdate {
    pub room_id: String,
    pub users: u32,
}

impl From<RoomCountChange> for RoomUserCountUpdate {
    fn from(value: RoomCountChange) -> Self {
        Self {
            room_id: value.room_id,
            users: value.users,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationMembershipEffects {
    /// Snapshot to publish through the signed application GossipSub envelope.
    /// `None` keeps idempotent transitions from manufacturing revisions.
    pub publish: Option<MembershipSnapshotPayload>,
    /// Deterministic room-count updates ready for Tauri `room-user-count` emits.
    pub counts: Vec<RoomUserCountUpdate>,
}

impl From<MembershipTransportEffects> for ApplicationMembershipEffects {
    fn from(value: MembershipTransportEffects) -> Self {
        Self {
            publish: value.publish.map(Into::into),
            counts: value.counts.into_iter().map(Into::into).collect(),
        }
    }
}

fn count_updates(changes: Vec<RoomCountChange>) -> Vec<RoomUserCountUpdate> {
    changes.into_iter().map(Into::into).collect()
}

/// Application-facing boundary for Rooms 2.0 production wiring.
///
/// The large network task should only translate signed `WireEvent` fields into
/// this adapter and emit its returned effects. Membership validation, replay
/// handling, revision monotonicity and source binding stay in the verified
/// coordinator/runtime stack.
#[derive(Debug)]
pub struct RoomMembershipApplicationAdapter {
    live: RoomMembershipLiveCoordinator,
}

impl RoomMembershipApplicationAdapter {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            live: RoomMembershipLiveCoordinator::new(local_peer),
        }
    }

    pub fn announce_room(&mut self, room_id: &str) -> Result<bool, RoomMembershipTransportError> {
        self.live.announce_room(room_id)
    }

    pub fn create_and_enter_local_room(
        &mut self,
        room_id: &str,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.live
            .create_and_enter_local_room(room_id)
            .map(Into::into)
    }

    /// `None` or `Some("world")` means leave temporary-room membership and
    /// return to the global WORLD presence semantics.
    pub fn enter_room(
        &mut self,
        room_id: Option<&str>,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.live.enter_room(room_id).map(Into::into)
    }

    /// Resync reuses the committed revision and therefore never inflates
    /// progress merely because a heartbeat fired.
    pub fn heartbeat_payload(&self) -> Option<MembershipSnapshotPayload> {
        self.live.heartbeat_event().map(Into::into)
    }

    pub fn receive_authenticated_snapshot(
        &mut self,
        payload: MembershipSnapshotPayload,
        authenticated_source: &PeerId,
    ) -> Result<RemoteTransportEffects, RoomMembershipTransportError> {
        self.live.receive_authenticated_snapshot(
            payload.peer_id,
            payload.revision,
            payload.rooms,
            authenticated_source,
        )
    }

    pub fn remote_count_updates(effects: RemoteTransportEffects) -> Vec<RoomUserCountUpdate> {
        match effects {
            RemoteTransportEffects::Applied(changes) => count_updates(changes),
            RemoteTransportEffects::Duplicate
            | RemoteTransportEffects::Stale
            | RemoteTransportEffects::Conflict => Vec::new(),
        }
    }

    pub fn connection_closed(
        &mut self,
        peer_id: &PeerId,
        remaining_established: u32,
    ) -> Vec<RoomUserCountUpdate> {
        count_updates(self.live.connection_closed(peer_id, remaining_established))
    }

    pub fn authenticated_goodbye(&mut self, peer_id: &PeerId) -> Vec<RoomUserCountUpdate> {
        count_updates(self.live.authenticated_goodbye(peer_id))
    }

    pub fn presence_expired(&mut self, peer_id: &PeerId) -> Vec<RoomUserCountUpdate> {
        count_updates(self.live.presence_expired(peer_id))
    }

    pub fn room_closed(
        &mut self,
        room_id: &str,
    ) -> Result<ApplicationMembershipEffects, RoomMembershipTransportError> {
        self.live.room_closed(room_id).map(Into::into)
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        self.live.total_count(room_id)
    }

    pub fn known_room(&self, room_id: &str) -> bool {
        self.live.known_room(room_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn peer_id() -> PeerId {
        Keypair::generate_ed25519().public().to_peer_id()
    }

    #[test]
    fn local_transition_maps_to_wire_payload_and_frontend_count() {
        let local = peer_id();
        let mut app = RoomMembershipApplicationAdapter::new(local.clone());
        let effects = app
            .create_and_enter_local_room("alpha")
            .expect("create alpha");

        assert_eq!(
            effects.publish,
            Some(MembershipSnapshotPayload {
                peer_id: local.to_string(),
                revision: 1,
                rooms: vec!["alpha".into()],
            })
        );
        assert_eq!(
            effects.counts,
            vec![RoomUserCountUpdate {
                room_id: "alpha".into(),
                users: 1,
            }]
        );
        assert_eq!(app.heartbeat_payload(), effects.publish);
    }

    #[test]
    fn remote_replay_does_not_emit_duplicate_frontend_counts() {
        let local = peer_id();
        let remote = peer_id();
        let mut app = RoomMembershipApplicationAdapter::new(local);
        app.announce_room("alpha").expect("announce alpha");
        let payload = MembershipSnapshotPayload {
            peer_id: remote.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };

        let first = app
            .receive_authenticated_snapshot(payload.clone(), &remote)
            .expect("first snapshot");
        assert_eq!(
            RoomMembershipApplicationAdapter::remote_count_updates(first),
            vec![RoomUserCountUpdate {
                room_id: "alpha".into(),
                users: 1,
            }]
        );

        let duplicate = app
            .receive_authenticated_snapshot(payload, &remote)
            .expect("duplicate snapshot");
        assert!(RoomMembershipApplicationAdapter::remote_count_updates(duplicate).is_empty());
    }

    #[test]
    fn source_forgery_fails_before_application_effects() {
        let local = peer_id();
        let remote = peer_id();
        let attacker = peer_id();
        let mut app = RoomMembershipApplicationAdapter::new(local);
        app.announce_room("alpha").expect("announce alpha");

        let result = app.receive_authenticated_snapshot(
            MembershipSnapshotPayload {
                peer_id: remote.to_string(),
                revision: 1,
                rooms: vec!["alpha".into()],
            },
            &attacker,
        );
        assert!(result.is_err());
        assert_eq!(app.total_count("alpha"), 0);
    }
}
