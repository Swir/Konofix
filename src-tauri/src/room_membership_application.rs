use std::collections::BTreeSet;

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::room_membership::{
    valid_temporary_room_id, RoomCountChange, MAX_MEMBERSHIP_ROOMS_PER_PEER,
};
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

impl MembershipSnapshotPayload {
    /// Parses the claimed identity only when it is already in canonical PeerId
    /// text form. This keeps source matching deterministic across the outer
    /// signed GossipSub envelope and the membership runtime.
    pub fn claimed_peer_id(&self) -> Option<PeerId> {
        let peer = self.peer_id.parse::<PeerId>().ok()?;
        (peer.to_string() == self.peer_id).then_some(peer)
    }

    /// Cheap fail-closed framing validation for the production `WireEvent`
    /// boundary. The runtime still performs its own authoritative validation
    /// before state mutation; this guard prevents obviously malformed or
    /// unbounded snapshots from reaching that layer.
    pub fn is_well_formed(&self) -> bool {
        if self.claimed_peer_id().is_none()
            || self.revision == 0
            || self.rooms.len() > MAX_MEMBERSHIP_ROOMS_PER_PEER
        {
            return false;
        }

        let mut unique = BTreeSet::new();
        self.rooms
            .iter()
            .all(|room_id| valid_temporary_room_id(room_id) && unique.insert(room_id.as_str()))
    }

    pub fn matches_authenticated_source(&self, source: &PeerId) -> bool {
        self.claimed_peer_id()
            .as_ref()
            .is_some_and(|claimed| claimed == source)
    }
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

    #[test]
    fn production_payload_guard_rejects_noncanonical_unbounded_and_duplicated_claims() {
        let source = peer_id();
        let valid = MembershipSnapshotPayload {
            peer_id: source.to_string(),
            revision: 1,
            rooms: vec!["alpha".into(), "beta".into()],
        };
        assert!(valid.is_well_formed());
        assert!(valid.matches_authenticated_source(&source));

        let other = peer_id();
        assert!(!valid.matches_authenticated_source(&other));

        let mut zero_revision = valid.clone();
        zero_revision.revision = 0;
        assert!(!zero_revision.is_well_formed());

        let mut duplicate = valid.clone();
        duplicate.rooms = vec!["alpha".into(), "alpha".into()];
        assert!(!duplicate.is_well_formed());

        let mut world = valid.clone();
        world.rooms = vec!["world".into()];
        assert!(!world.is_well_formed());

        let mut invalid_room = valid.clone();
        invalid_room.rooms = vec!["bad room".into()];
        assert!(!invalid_room.is_well_formed());

        let mut too_many = valid.clone();
        too_many.rooms = (0..=MAX_MEMBERSHIP_ROOMS_PER_PEER)
            .map(|index| format!("room-{index}"))
            .collect();
        assert!(!too_many.is_well_formed());

        let mut invalid_peer = valid;
        invalid_peer.peer_id = "not-a-peer-id".into();
        assert!(!invalid_peer.is_well_formed());
        assert!(!invalid_peer.matches_authenticated_source(&source));
    }
}
