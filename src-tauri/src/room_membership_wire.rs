use std::{collections::BTreeSet, str::FromStr};

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::room_membership::{
    valid_temporary_room_id, RoomMembershipTracker, SnapshotApply, SnapshotError,
    MAX_MEMBERSHIP_ROOMS_PER_PEER,
};

pub const MAX_MEMBERSHIP_PEER_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomMembershipSnapshot {
    pub peer_id: String,
    pub revision: u64,
    pub rooms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipWireError {
    InvalidClaimedPeer,
    SourceMismatch,
    InvalidRevision,
    TooManyRooms,
    InvalidRoomId(String),
    DuplicateRoomId(String),
    UnknownRoomId(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipApplyError {
    Wire(MembershipWireError),
    Tracker(SnapshotError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalMembershipError {
    TooManyRooms,
    InvalidRoomId(String),
    DuplicateRoomId(String),
    RevisionExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalMembershipUpdate {
    Unchanged,
    Publish(RoomMembershipSnapshot),
}

#[derive(Debug, Default)]
pub struct LocalRoomMembershipState {
    revision: u64,
    rooms: BTreeSet<String>,
}

impl RoomMembershipSnapshot {
    pub fn validate_authenticated_source(
        &self,
        authenticated_source: &PeerId,
    ) -> Result<(), MembershipWireError> {
        if self.peer_id.is_empty() || self.peer_id.len() > MAX_MEMBERSHIP_PEER_ID_BYTES {
            return Err(MembershipWireError::InvalidClaimedPeer);
        }
        let claimed =
            PeerId::from_str(&self.peer_id).map_err(|_| MembershipWireError::InvalidClaimedPeer)?;
        if &claimed != authenticated_source {
            return Err(MembershipWireError::SourceMismatch);
        }
        if self.revision == 0 {
            return Err(MembershipWireError::InvalidRevision);
        }
        if self.rooms.len() > MAX_MEMBERSHIP_ROOMS_PER_PEER {
            return Err(MembershipWireError::TooManyRooms);
        }

        let mut unique_rooms = BTreeSet::new();
        for room_id in &self.rooms {
            if !valid_temporary_room_id(room_id) {
                return Err(MembershipWireError::InvalidRoomId(room_id.clone()));
            }
            if !unique_rooms.insert(room_id.as_str()) {
                return Err(MembershipWireError::DuplicateRoomId(room_id.clone()));
            }
        }
        Ok(())
    }

    pub fn validate_known_rooms(
        &self,
        known_room_ids: &BTreeSet<String>,
    ) -> Result<(), MembershipWireError> {
        for room_id in &self.rooms {
            if !known_room_ids.contains(room_id) {
                return Err(MembershipWireError::UnknownRoomId(room_id.clone()));
            }
        }
        Ok(())
    }
}

impl LocalRoomMembershipState {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn rooms(&self) -> &BTreeSet<String> {
        &self.rooms
    }

    pub fn replace_rooms<I, S>(
        &mut self,
        local_peer: &PeerId,
        room_ids: I,
    ) -> Result<LocalMembershipUpdate, LocalMembershipError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut next_rooms = BTreeSet::new();
        for raw in room_ids {
            let room_id = raw.as_ref();
            if !valid_temporary_room_id(room_id) {
                return Err(LocalMembershipError::InvalidRoomId(room_id.to_string()));
            }
            if !next_rooms.insert(room_id.to_string()) {
                return Err(LocalMembershipError::DuplicateRoomId(room_id.to_string()));
            }
            if next_rooms.len() > MAX_MEMBERSHIP_ROOMS_PER_PEER {
                return Err(LocalMembershipError::TooManyRooms);
            }
        }

        if self.rooms == next_rooms {
            return Ok(LocalMembershipUpdate::Unchanged);
        }

        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(LocalMembershipError::RevisionExhausted)?;
        self.revision = next_revision;
        self.rooms = next_rooms;

        Ok(LocalMembershipUpdate::Publish(RoomMembershipSnapshot {
            peer_id: local_peer.to_string(),
            revision: self.revision,
            rooms: self.rooms.iter().cloned().collect(),
        }))
    }
}

pub fn apply_authenticated_snapshot(
    tracker: &mut RoomMembershipTracker,
    snapshot: &RoomMembershipSnapshot,
    authenticated_source: &PeerId,
    known_room_ids: &BTreeSet<String>,
) -> Result<SnapshotApply, MembershipApplyError> {
    snapshot
        .validate_authenticated_source(authenticated_source)
        .map_err(MembershipApplyError::Wire)?;
    snapshot
        .validate_known_rooms(known_room_ids)
        .map_err(MembershipApplyError::Wire)?;
    tracker
        .apply_snapshot(
            &snapshot.peer_id,
            snapshot.revision,
            snapshot.rooms.iter().map(String::as_str),
        )
        .map_err(MembershipApplyError::Tracker)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn peer_id() -> PeerId {
        Keypair::generate_ed25519().public().to_peer_id()
    }

    #[test]
    fn accepts_source_bound_snapshot() {
        let source = peer_id();
        let snapshot = RoomMembershipSnapshot {
            peer_id: source.to_string(),
            revision: 1,
            rooms: vec!["alpha".into(), "beta".into()],
        };
        assert_eq!(snapshot.validate_authenticated_source(&source), Ok(()));
        assert_eq!(
            snapshot.validate_known_rooms(&BTreeSet::from(["alpha".into(), "beta".into()])),
            Ok(())
        );
    }

    #[test]
    fn rejects_forged_source_and_invalid_shape() {
        let source = peer_id();
        let other = peer_id();
        let mut snapshot = RoomMembershipSnapshot {
            peer_id: other.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        assert_eq!(
            snapshot.validate_authenticated_source(&source),
            Err(MembershipWireError::SourceMismatch)
        );

        snapshot.peer_id = source.to_string();
        snapshot.revision = 0;
        assert_eq!(
            snapshot.validate_authenticated_source(&source),
            Err(MembershipWireError::InvalidRevision)
        );

        snapshot.revision = 2;
        snapshot.rooms = vec!["world".into()];
        assert_eq!(
            snapshot.validate_authenticated_source(&source),
            Err(MembershipWireError::InvalidRoomId("world".into()))
        );

        snapshot.rooms = vec!["alpha".into(), "alpha".into()];
        assert_eq!(
            snapshot.validate_authenticated_source(&source),
            Err(MembershipWireError::DuplicateRoomId("alpha".into()))
        );
    }

    #[test]
    fn rejects_unbounded_or_unknown_claims_before_membership_mutation() {
        let source = peer_id();
        let mut snapshot = RoomMembershipSnapshot {
            peer_id: "x".repeat(MAX_MEMBERSHIP_PEER_ID_BYTES + 1),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        assert_eq!(
            snapshot.validate_authenticated_source(&source),
            Err(MembershipWireError::InvalidClaimedPeer)
        );

        snapshot.peer_id = source.to_string();
        assert_eq!(snapshot.validate_authenticated_source(&source), Ok(()));
        assert_eq!(
            snapshot.validate_known_rooms(&BTreeSet::from(["beta".into()])),
            Err(MembershipWireError::UnknownRoomId("alpha".into()))
        );
    }

    #[test]
    fn local_state_emits_only_monotonic_membership_changes() {
        let source = peer_id();
        let mut state = LocalRoomMembershipState::default();

        assert_eq!(
            state.replace_rooms(&source, std::iter::empty::<&str>()),
            Ok(LocalMembershipUpdate::Unchanged)
        );
        let first = state
            .replace_rooms(&source, ["beta", "alpha"])
            .expect("first local membership change");
        assert_eq!(
            first,
            LocalMembershipUpdate::Publish(RoomMembershipSnapshot {
                peer_id: source.to_string(),
                revision: 1,
                rooms: vec!["alpha".into(), "beta".into()],
            })
        );
        assert_eq!(state.revision(), 1);
        assert_eq!(
            state.replace_rooms(&source, ["alpha", "beta"]),
            Ok(LocalMembershipUpdate::Unchanged)
        );
        assert_eq!(state.revision(), 1);

        let second = state
            .replace_rooms(&source, ["beta"])
            .expect("second local membership change");
        assert_eq!(
            second,
            LocalMembershipUpdate::Publish(RoomMembershipSnapshot {
                peer_id: source.to_string(),
                revision: 2,
                rooms: vec!["beta".into()],
            })
        );
        assert_eq!(state.rooms(), &BTreeSet::from(["beta".into()]));
    }

    #[test]
    fn invalid_local_change_does_not_advance_revision_or_mutate_state() {
        let source = peer_id();
        let mut state = LocalRoomMembershipState::default();
        state
            .replace_rooms(&source, ["alpha"])
            .expect("baseline local membership");

        assert_eq!(
            state.replace_rooms(&source, ["alpha", "alpha"]),
            Err(LocalMembershipError::DuplicateRoomId("alpha".into()))
        );
        assert_eq!(state.revision(), 1);
        assert_eq!(state.rooms(), &BTreeSet::from(["alpha".into()]));
    }

    #[test]
    fn authenticated_apply_joins_wire_validation_and_tracker_atomically() {
        let source = peer_id();
        let other = peer_id();
        let known = BTreeSet::from(["alpha".into(), "beta".into()]);
        let mut tracker = RoomMembershipTracker::default();
        let snapshot = RoomMembershipSnapshot {
            peer_id: source.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };

        assert_eq!(
            apply_authenticated_snapshot(&mut tracker, &snapshot, &source, &known),
            Ok(SnapshotApply::Applied(vec![
                crate::room_membership::RoomCountChange {
                    room_id: "alpha".into(),
                    users: 1,
                },
            ]))
        );
        assert_eq!(tracker.member_count("alpha"), 1);

        let forged = RoomMembershipSnapshot {
            peer_id: source.to_string(),
            revision: 2,
            rooms: vec!["beta".into()],
        };
        assert_eq!(
            apply_authenticated_snapshot(&mut tracker, &forged, &other, &known),
            Err(MembershipApplyError::Wire(
                MembershipWireError::SourceMismatch
            ))
        );
        assert_eq!(tracker.member_count("alpha"), 1);
        assert_eq!(tracker.member_count("beta"), 0);
    }
}
