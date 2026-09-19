use std::{collections::BTreeSet, str::FromStr};

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::room_membership::{valid_temporary_room_id, MAX_MEMBERSHIP_ROOMS_PER_PEER};

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
}
