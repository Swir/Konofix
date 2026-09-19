use std::collections::BTreeSet;

use libp2p::PeerId;

use crate::room_membership::{
    valid_temporary_room_id, RoomCountChange, RoomMembershipTracker, SnapshotApply,
};
use crate::room_membership_wire::{
    apply_authenticated_snapshot, LocalMembershipError, LocalMembershipUpdate,
    LocalRoomMembershipState, MembershipApplyError, RoomMembershipSnapshot,
};

pub const MAX_RUNTIME_ROOMS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipRuntimeError {
    InvalidRoomId(String),
    UnknownRoomId(String),
    RoomCapacityExceeded,
    LoopbackSnapshot,
    Local(LocalMembershipError),
    Remote(MembershipApplyError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMembershipTransition {
    pub snapshot: Option<RoomMembershipSnapshot>,
    pub counts: Vec<RoomCountChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteMembershipTransition {
    Applied(Vec<RoomCountChange>),
    Duplicate,
    Stale,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomClosureTransition {
    pub existed: bool,
    pub snapshot: Option<RoomMembershipSnapshot>,
    pub count: Option<RoomCountChange>,
}

#[derive(Debug)]
pub struct RoomMembershipRuntime {
    local_peer: PeerId,
    known_rooms: BTreeSet<String>,
    local: LocalRoomMembershipState,
    remote: RoomMembershipTracker,
}

impl RoomMembershipRuntime {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            local_peer,
            known_rooms: BTreeSet::new(),
            local: LocalRoomMembershipState::default(),
            remote: RoomMembershipTracker::default(),
        }
    }

    pub fn local_peer(&self) -> &PeerId {
        &self.local_peer
    }

    pub fn known_rooms(&self) -> &BTreeSet<String> {
        &self.known_rooms
    }

    pub fn local_rooms(&self) -> &BTreeSet<String> {
        self.local.rooms()
    }

    pub fn register_room(&mut self, room_id: &str) -> Result<bool, MembershipRuntimeError> {
        if !valid_temporary_room_id(room_id) {
            return Err(MembershipRuntimeError::InvalidRoomId(room_id.to_string()));
        }
        if self.known_rooms.contains(room_id) {
            return Ok(false);
        }
        if self.known_rooms.len() >= MAX_RUNTIME_ROOMS {
            return Err(MembershipRuntimeError::RoomCapacityExceeded);
        }
        self.known_rooms.insert(room_id.to_string());
        Ok(true)
    }

    pub fn register_rooms<I, S>(&mut self, room_ids: I) -> Result<usize, MembershipRuntimeError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut additions = BTreeSet::new();
        for raw in room_ids {
            let room_id = raw.as_ref();
            if !valid_temporary_room_id(room_id) {
                return Err(MembershipRuntimeError::InvalidRoomId(room_id.to_string()));
            }
            if !self.known_rooms.contains(room_id) {
                additions.insert(room_id.to_string());
            }
        }

        if self.known_rooms.len().saturating_add(additions.len()) > MAX_RUNTIME_ROOMS {
            return Err(MembershipRuntimeError::RoomCapacityExceeded);
        }

        let added = additions.len();
        self.known_rooms.extend(additions);
        Ok(added)
    }

    pub fn set_local_rooms<I, S>(
        &mut self,
        room_ids: I,
    ) -> Result<LocalMembershipTransition, MembershipRuntimeError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let requested = room_ids
            .into_iter()
            .map(|room_id| room_id.as_ref().to_string())
            .collect::<Vec<_>>();

        for room_id in &requested {
            if !valid_temporary_room_id(room_id) {
                return Err(MembershipRuntimeError::InvalidRoomId(room_id.clone()));
            }
            if !self.known_rooms.contains(room_id) {
                return Err(MembershipRuntimeError::UnknownRoomId(room_id.clone()));
            }
        }

        let previous = self.local.rooms().clone();
        let update = self
            .local
            .replace_rooms(&self.local_peer, requested.iter().map(String::as_str))
            .map_err(MembershipRuntimeError::Local)?;

        match update {
            LocalMembershipUpdate::Unchanged => Ok(LocalMembershipTransition {
                snapshot: None,
                counts: Vec::new(),
            }),
            LocalMembershipUpdate::Publish(snapshot) => {
                let changed = previous
                    .symmetric_difference(self.local.rooms())
                    .cloned()
                    .collect::<Vec<_>>();
                let counts = changed
                    .into_iter()
                    .map(|room_id| RoomCountChange {
                        users: self.total_count(&room_id),
                        room_id,
                    })
                    .collect();
                Ok(LocalMembershipTransition {
                    snapshot: Some(snapshot),
                    counts,
                })
            }
        }
    }

    pub fn apply_remote_snapshot(
        &mut self,
        snapshot: &RoomMembershipSnapshot,
        authenticated_source: &PeerId,
    ) -> Result<RemoteMembershipTransition, MembershipRuntimeError> {
        if authenticated_source == &self.local_peer {
            return Err(MembershipRuntimeError::LoopbackSnapshot);
        }

        let result = apply_authenticated_snapshot(
            &mut self.remote,
            snapshot,
            authenticated_source,
            &self.known_rooms,
        )
        .map_err(MembershipRuntimeError::Remote)?;

        Ok(match result {
            SnapshotApply::Applied(changes) => RemoteMembershipTransition::Applied(
                changes
                    .into_iter()
                    .map(|change| RoomCountChange {
                        users: self.total_count(&change.room_id),
                        room_id: change.room_id,
                    })
                    .collect(),
            ),
            SnapshotApply::Duplicate => RemoteMembershipTransition::Duplicate,
            SnapshotApply::Stale => RemoteMembershipTransition::Stale,
            SnapshotApply::Conflict => RemoteMembershipTransition::Conflict,
        })
    }

    pub fn remove_remote_peer(&mut self, peer_id: &PeerId) -> Vec<RoomCountChange> {
        if peer_id == &self.local_peer {
            return Vec::new();
        }
        self.remote
            .remove_peer(&peer_id.to_string())
            .into_iter()
            .map(|change| RoomCountChange {
                users: self.total_count(&change.room_id),
                room_id: change.room_id,
            })
            .collect()
    }

    pub fn close_room(
        &mut self,
        room_id: &str,
    ) -> Result<RoomClosureTransition, MembershipRuntimeError> {
        if !self.known_rooms.contains(room_id) {
            return Ok(RoomClosureTransition {
                existed: false,
                snapshot: None,
                count: None,
            });
        }

        let next_local = self
            .local
            .rooms()
            .iter()
            .filter(|candidate| candidate.as_str() != room_id)
            .cloned()
            .collect::<Vec<_>>();

        let local_update = self
            .local
            .replace_rooms(&self.local_peer, next_local.iter().map(String::as_str))
            .map_err(MembershipRuntimeError::Local)?;
        let snapshot = match local_update {
            LocalMembershipUpdate::Unchanged => None,
            LocalMembershipUpdate::Publish(snapshot) => Some(snapshot),
        };

        self.remote.remove_room(room_id);
        self.known_rooms.remove(room_id);

        Ok(RoomClosureTransition {
            existed: true,
            snapshot,
            count: Some(RoomCountChange {
                room_id: room_id.to_string(),
                users: 0,
            }),
        })
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        let local = u32::from(self.local.rooms().contains(room_id));
        self.remote.member_count(room_id).saturating_add(local)
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
    fn local_and_remote_memberships_share_one_total_count_view() {
        let local_peer = peer_id();
        let remote_peer = peer_id();
        let mut runtime = RoomMembershipRuntime::new(local_peer.clone());
        runtime
            .register_rooms(["alpha", "beta"])
            .expect("register rooms");

        let local = runtime
            .set_local_rooms(["alpha"])
            .expect("local joins alpha");
        assert_eq!(local.counts.len(), 1);
        assert_eq!(runtime.total_count("alpha"), 1);

        let remote = RoomMembershipSnapshot {
            peer_id: remote_peer.to_string(),
            revision: 1,
            rooms: vec!["alpha".into(), "beta".into()],
        };
        assert_eq!(
            runtime
                .apply_remote_snapshot(&remote, &remote_peer)
                .expect("remote snapshot"),
            RemoteMembershipTransition::Applied(vec![
                RoomCountChange {
                    room_id: "alpha".into(),
                    users: 2,
                },
                RoomCountChange {
                    room_id: "beta".into(),
                    users: 1,
                },
            ])
        );

        let moved = runtime
            .set_local_rooms(["beta"])
            .expect("local moves to beta");
        assert_eq!(moved.snapshot.expect("publish").revision, 2);
        assert_eq!(runtime.total_count("alpha"), 1);
        assert_eq!(runtime.total_count("beta"), 2);
    }

    #[test]
    fn unknown_forged_and_loopback_snapshots_fail_before_count_mutation() {
        let local_peer = peer_id();
        let remote_peer = peer_id();
        let attacker = peer_id();
        let mut runtime = RoomMembershipRuntime::new(local_peer.clone());
        runtime.register_room("alpha").expect("register alpha");

        let unknown = RoomMembershipSnapshot {
            peer_id: remote_peer.to_string(),
            revision: 1,
            rooms: vec!["beta".into()],
        };
        assert!(matches!(
            runtime.apply_remote_snapshot(&unknown, &remote_peer),
            Err(MembershipRuntimeError::Remote(_))
        ));
        assert_eq!(runtime.total_count("alpha"), 0);

        let forged = RoomMembershipSnapshot {
            peer_id: remote_peer.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        assert!(matches!(
            runtime.apply_remote_snapshot(&forged, &attacker),
            Err(MembershipRuntimeError::Remote(_))
        ));
        assert_eq!(runtime.total_count("alpha"), 0);

        let loopback = RoomMembershipSnapshot {
            peer_id: local_peer.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        assert_eq!(
            runtime.apply_remote_snapshot(&loopback, &local_peer),
            Err(MembershipRuntimeError::LoopbackSnapshot)
        );
        assert_eq!(runtime.total_count("alpha"), 0);
    }

    #[test]
    fn disconnect_and_room_close_converge_counts_and_local_snapshot() {
        let local_peer = peer_id();
        let remote_peer = peer_id();
        let mut runtime = RoomMembershipRuntime::new(local_peer);
        runtime
            .register_rooms(["alpha", "beta"])
            .expect("register rooms");
        runtime
            .set_local_rooms(["alpha"])
            .expect("local joins alpha");

        let remote = RoomMembershipSnapshot {
            peer_id: remote_peer.to_string(),
            revision: 1,
            rooms: vec!["alpha".into(), "beta".into()],
        };
        runtime
            .apply_remote_snapshot(&remote, &remote_peer)
            .expect("remote joins");

        assert_eq!(
            runtime.remove_remote_peer(&remote_peer),
            vec![
                RoomCountChange {
                    room_id: "alpha".into(),
                    users: 1,
                },
                RoomCountChange {
                    room_id: "beta".into(),
                    users: 0,
                },
            ]
        );

        let closed = runtime.close_room("alpha").expect("close alpha");
        assert!(closed.existed);
        assert_eq!(
            closed.count,
            Some(RoomCountChange {
                room_id: "alpha".into(),
                users: 0,
            })
        );
        assert_eq!(closed.snapshot.expect("publish leave").rooms, Vec::<String>::new());
        assert!(!runtime.known_rooms().contains("alpha"));
        assert!(runtime.local_rooms().is_empty());
    }

    #[test]
    fn room_registration_is_atomic_and_bounded() {
        let mut runtime = RoomMembershipRuntime::new(peer_id());
        assert_eq!(runtime.register_rooms(["alpha", "beta"]), Ok(2));
        assert_eq!(runtime.register_rooms(["alpha", "beta"]), Ok(0));

        let before = runtime.known_rooms().clone();
        assert_eq!(
            runtime.register_rooms(["gamma", "bad room"]),
            Err(MembershipRuntimeError::InvalidRoomId("bad room".into()))
        );
        assert_eq!(runtime.known_rooms(), &before);
    }
}
