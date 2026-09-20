use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::room_membership::RoomCountChange;
use crate::room_membership_desktop::{DesktopMembershipEffects, DesktopRoomMembership};
use crate::room_membership_runtime::{MembershipRuntimeError, RemoteMembershipTransition};
use crate::room_membership_wire::RoomMembershipSnapshot;

/// Hard cap for one room-membership gossip frame before JSON parsing.
/// The current protocol allows at most a small bounded set of room ids, so
/// 16 KiB leaves comfortable framing headroom without accepting unbounded input.
pub const MAX_ROOM_MEMBERSHIP_WIRE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RoomMembershipNetworkEvent {
    MembershipSnapshot {
        peer_id: String,
        revision: u64,
        rooms: Vec<String>,
    },
}

impl From<RoomMembershipSnapshot> for RoomMembershipNetworkEvent {
    fn from(snapshot: RoomMembershipSnapshot) -> Self {
        Self::MembershipSnapshot {
            peer_id: snapshot.peer_id,
            revision: snapshot.revision,
            rooms: snapshot.rooms,
        }
    }
}

impl RoomMembershipNetworkEvent {
    pub fn into_snapshot(self) -> RoomMembershipSnapshot {
        match self {
            Self::MembershipSnapshot {
                peer_id,
                revision,
                rooms,
            } => RoomMembershipSnapshot {
                peer_id,
                revision,
                rooms,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomMembershipTransportError {
    FrameTooLarge,
    InvalidJson,
    Runtime(MembershipRuntimeError),
}

impl From<MembershipRuntimeError> for RoomMembershipTransportError {
    fn from(value: MembershipRuntimeError) -> Self {
        Self::Runtime(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MembershipTransportEffects {
    /// A local snapshot that should be published on GossipSub. `None` means
    /// the requested operation was idempotent and must not manufacture a new revision.
    pub publish: Option<RoomMembershipNetworkEvent>,
    /// Exact room-count changes produced by the verified membership runtime.
    pub counts: Vec<RoomCountChange>,
}

impl From<DesktopMembershipEffects> for MembershipTransportEffects {
    fn from(value: DesktopMembershipEffects) -> Self {
        Self {
            publish: value.snapshot.map(RoomMembershipNetworkEvent::from),
            counts: value.counts,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteTransportEffects {
    Applied(Vec<RoomCountChange>),
    Duplicate,
    Stale,
    Conflict,
}

impl From<RemoteMembershipTransition> for RemoteTransportEffects {
    fn from(value: RemoteMembershipTransition) -> Self {
        match value {
            RemoteMembershipTransition::Applied(counts) => Self::Applied(counts),
            RemoteMembershipTransition::Duplicate => Self::Duplicate,
            RemoteMembershipTransition::Stale => Self::Stale,
            RemoteMembershipTransition::Conflict => Self::Conflict,
        }
    }
}

/// Network-facing adapter for Rooms 2.0 membership synchronization.
///
/// This type keeps protocol parsing, authenticated-source checks, monotonic
/// replay handling and room-count effects behind one boundary. The production
/// GossipSub loop can therefore publish/receive this contract without duplicating
/// state-transition rules in the networking task or frontend.
#[derive(Debug)]
pub struct RoomMembershipNetwork {
    desktop: DesktopRoomMembership,
}

impl RoomMembershipNetwork {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            desktop: DesktopRoomMembership::new(local_peer),
        }
    }

    pub fn register_announced_room(
        &mut self,
        room_id: &str,
    ) -> Result<bool, RoomMembershipTransportError> {
        self.desktop
            .register_announced_room(room_id)
            .map_err(Into::into)
    }

    pub fn create_and_enter_local_room(
        &mut self,
        room_id: &str,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.desktop
            .create_and_enter_local_room(room_id)
            .map(Into::into)
            .map_err(Into::into)
    }

    pub fn enter_room(
        &mut self,
        room_id: Option<&str>,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.desktop
            .enter_room(room_id)
            .map(Into::into)
            .map_err(Into::into)
    }

    /// Returns the currently committed snapshot for heartbeat/resync without
    /// increasing the local revision.
    pub fn heartbeat_event(&self) -> Option<RoomMembershipNetworkEvent> {
        self.desktop
            .current_snapshot()
            .map(RoomMembershipNetworkEvent::from)
    }

    pub fn encode_event(
        event: &RoomMembershipNetworkEvent,
    ) -> Result<Vec<u8>, RoomMembershipTransportError> {
        let bytes = serde_json::to_vec(event).map_err(|_| RoomMembershipTransportError::InvalidJson)?;
        if bytes.len() > MAX_ROOM_MEMBERSHIP_WIRE_BYTES {
            return Err(RoomMembershipTransportError::FrameTooLarge);
        }
        Ok(bytes)
    }

    pub fn decode_event(
        bytes: &[u8],
    ) -> Result<RoomMembershipNetworkEvent, RoomMembershipTransportError> {
        if bytes.len() > MAX_ROOM_MEMBERSHIP_WIRE_BYTES {
            return Err(RoomMembershipTransportError::FrameTooLarge);
        }
        serde_json::from_slice(bytes).map_err(|_| RoomMembershipTransportError::InvalidJson)
    }

    /// Applies a membership frame only after binding the claimed Peer ID to
    /// the authenticated libp2p source. Unknown rooms, malformed identities,
    /// replays and revision conflicts are handled by the existing verified runtime.
    pub fn receive_authenticated(
        &mut self,
        bytes: &[u8],
        authenticated_source: &PeerId,
    ) -> Result<RemoteTransportEffects, RoomMembershipTransportError> {
        let snapshot = Self::decode_event(bytes)?.into_snapshot();
        self.desktop
            .apply_remote_snapshot(&snapshot, authenticated_source)
            .map(Into::into)
            .map_err(Into::into)
    }

    pub fn peer_departed(&mut self, peer_id: &PeerId) -> Vec<RoomCountChange> {
        self.desktop.peer_departed(peer_id)
    }

    pub fn close_room(
        &mut self,
        room_id: &str,
    ) -> Result<MembershipTransportEffects, RoomMembershipTransportError> {
        self.desktop
            .close_room(room_id)
            .map(Into::into)
            .map_err(Into::into)
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        self.desktop.total_count(room_id)
    }

    pub fn known_room(&self, room_id: &str) -> bool {
        self.desktop.known_room(room_id)
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
    fn heartbeat_reuses_revision_and_does_not_invent_state_changes() {
        let local = peer_id();
        let mut network = RoomMembershipNetwork::new(local);
        network.register_announced_room("alpha").expect("room");
        let joined = network.enter_room(Some("alpha")).expect("join");
        let first = joined.publish.expect("publish");
        let heartbeat = network.heartbeat_event().expect("heartbeat");
        assert_eq!(heartbeat, first);
        assert!(network.enter_room(Some("alpha")).expect("same room").publish.is_none());
        assert_eq!(network.heartbeat_event(), Some(first));
    }

    #[test]
    fn source_mismatch_fails_before_remote_count_mutation() {
        let local = peer_id();
        let remote = peer_id();
        let attacker = peer_id();
        let mut network = RoomMembershipNetwork::new(local);
        network.register_announced_room("alpha").expect("room");

        let event = RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id: remote.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        let bytes = RoomMembershipNetwork::encode_event(&event).expect("encode");
        assert!(network.receive_authenticated(&bytes, &attacker).is_err());
        assert_eq!(network.total_count("alpha"), 0);
        assert_eq!(
            network.receive_authenticated(&bytes, &remote).expect("valid source"),
            RemoteTransportEffects::Applied(vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 1,
            }])
        );
    }

    #[test]
    fn duplicate_stale_and_conflicting_revisions_do_not_double_count() {
        let local = peer_id();
        let remote = peer_id();
        let mut network = RoomMembershipNetwork::new(local);
        network.register_announced_room("alpha").expect("alpha");
        network.register_announced_room("beta").expect("beta");

        let first = RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id: remote.to_string(),
            revision: 2,
            rooms: vec!["alpha".into()],
        };
        let first_bytes = RoomMembershipNetwork::encode_event(&first).expect("encode first");
        assert!(matches!(
            network.receive_authenticated(&first_bytes, &remote).expect("apply first"),
            RemoteTransportEffects::Applied(_)
        ));
        assert_eq!(
            network.receive_authenticated(&first_bytes, &remote).expect("duplicate"),
            RemoteTransportEffects::Duplicate
        );

        let stale = RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id: remote.to_string(),
            revision: 1,
            rooms: vec!["beta".into()],
        };
        assert_eq!(
            network
                .receive_authenticated(
                    &RoomMembershipNetwork::encode_event(&stale).expect("encode stale"),
                    &remote,
                )
                .expect("stale"),
            RemoteTransportEffects::Stale
        );

        let conflict = RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id: remote.to_string(),
            revision: 2,
            rooms: vec!["beta".into()],
        };
        assert_eq!(
            network
                .receive_authenticated(
                    &RoomMembershipNetwork::encode_event(&conflict).expect("encode conflict"),
                    &remote,
                )
                .expect("conflict"),
            RemoteTransportEffects::Conflict
        );
        assert_eq!(network.total_count("alpha"), 1);
        assert_eq!(network.total_count("beta"), 0);
    }

    #[test]
    fn oversized_and_malformed_frames_fail_closed() {
        assert_eq!(
            RoomMembershipNetwork::decode_event(&vec![b'x'; MAX_ROOM_MEMBERSHIP_WIRE_BYTES + 1]),
            Err(RoomMembershipTransportError::FrameTooLarge)
        );
        assert_eq!(
            RoomMembershipNetwork::decode_event(b"not-json"),
            Err(RoomMembershipTransportError::InvalidJson)
        );
    }
}