use std::collections::{BTreeMap, BTreeSet};

pub const MAX_MEMBERSHIP_ROOMS_PER_PEER: usize = 64;
pub const MAX_TRACKED_MEMBERSHIPS: usize = 16_384;
pub const MAX_TRACKED_MEMBERSHIP_PEERS: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomCountChange {
    pub room_id: String,
    pub users: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotApply {
    Applied(Vec<RoomCountChange>),
    Duplicate,
    Stale,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    InvalidPeer,
    InvalidRevision,
    TooManyRooms,
    InvalidRoomId(String),
    DuplicateRoomId(String),
    CapacityExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PeerMembership {
    revision: u64,
    rooms: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MembershipLimits {
    rooms_per_peer: usize,
    memberships_total: usize,
    peers_total: usize,
}

impl Default for MembershipLimits {
    fn default() -> Self {
        Self {
            rooms_per_peer: MAX_MEMBERSHIP_ROOMS_PER_PEER,
            memberships_total: MAX_TRACKED_MEMBERSHIPS,
            peers_total: MAX_TRACKED_MEMBERSHIP_PEERS,
        }
    }
}

#[derive(Debug)]
pub struct RoomMembershipTracker {
    peers: BTreeMap<String, PeerMembership>,
    rooms: BTreeMap<String, BTreeSet<String>>,
    memberships: usize,
    limits: MembershipLimits,
}

impl Default for RoomMembershipTracker {
    fn default() -> Self {
        Self::new(MembershipLimits::default())
    }
}

impl RoomMembershipTracker {
    fn new(limits: MembershipLimits) -> Self {
        Self {
            peers: BTreeMap::new(),
            rooms: BTreeMap::new(),
            memberships: 0,
            limits,
        }
    }

    pub fn apply_snapshot<I, S>(
        &mut self,
        peer_id: &str,
        revision: u64,
        room_ids: I,
    ) -> Result<SnapshotApply, SnapshotError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        if peer_id.trim().is_empty() || peer_id.len() > 128 {
            return Err(SnapshotError::InvalidPeer);
        }
        if revision == 0 {
            return Err(SnapshotError::InvalidRevision);
        }
        if !self.peers.contains_key(peer_id) && self.peers.len() >= self.limits.peers_total {
            return Err(SnapshotError::CapacityExceeded);
        }

        let mut next_rooms = BTreeSet::new();
        for raw in room_ids {
            let room_id = raw.as_ref();
            if !valid_temporary_room_id(room_id) {
                return Err(SnapshotError::InvalidRoomId(room_id.to_string()));
            }
            if !next_rooms.insert(room_id.to_string()) {
                return Err(SnapshotError::DuplicateRoomId(room_id.to_string()));
            }
            if next_rooms.len() > self.limits.rooms_per_peer {
                return Err(SnapshotError::TooManyRooms);
            }
        }

        if let Some(current) = self.peers.get(peer_id) {
            if revision < current.revision {
                return Ok(SnapshotApply::Stale);
            }
            if revision == current.revision {
                return Ok(if current.rooms == next_rooms {
                    SnapshotApply::Duplicate
                } else {
                    SnapshotApply::Conflict
                });
            }
        }

        let previous_rooms = self
            .peers
            .get(peer_id)
            .map(|state| state.rooms.clone())
            .unwrap_or_default();
        let retained = previous_rooms.intersection(&next_rooms).count();
        let projected_memberships = self
            .memberships
            .saturating_sub(previous_rooms.len().saturating_sub(retained))
            .saturating_add(next_rooms.len().saturating_sub(retained));
        if projected_memberships > self.limits.memberships_total {
            return Err(SnapshotError::CapacityExceeded);
        }

        let removed = previous_rooms
            .difference(&next_rooms)
            .cloned()
            .collect::<Vec<_>>();
        let added = next_rooms
            .difference(&previous_rooms)
            .cloned()
            .collect::<Vec<_>>();

        for room_id in &removed {
            if let Some(members) = self.rooms.get_mut(room_id) {
                if members.remove(peer_id) {
                    self.memberships = self.memberships.saturating_sub(1);
                }
                if members.is_empty() {
                    self.rooms.remove(room_id);
                }
            }
        }

        for room_id in &added {
            let inserted = self
                .rooms
                .entry(room_id.clone())
                .or_default()
                .insert(peer_id.to_string());
            if inserted {
                self.memberships = self.memberships.saturating_add(1);
            }
        }

        self.peers.insert(
            peer_id.to_string(),
            PeerMembership {
                revision,
                rooms: next_rooms,
            },
        );

        let changed_rooms = removed
            .into_iter()
            .chain(added)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|room_id| RoomCountChange {
                users: self.member_count(&room_id),
                room_id,
            })
            .collect();

        Ok(SnapshotApply::Applied(changed_rooms))
    }

    pub fn member_count(&self, room_id: &str) -> u32 {
        self.rooms
            .get(room_id)
            .map(|members| u32::try_from(members.len()).unwrap_or(u32::MAX))
            .unwrap_or(0)
    }

    pub fn rooms_for_peer(&self, peer_id: &str) -> Vec<String> {
        self.peers
            .get(peer_id)
            .map(|state| state.rooms.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn remove_peer(&mut self, peer_id: &str) -> Vec<RoomCountChange> {
        let Some(state) = self.peers.remove(peer_id) else {
            return Vec::new();
        };

        let mut changes = Vec::with_capacity(state.rooms.len());
        for room_id in state.rooms {
            if let Some(members) = self.rooms.get_mut(&room_id) {
                if members.remove(peer_id) {
                    self.memberships = self.memberships.saturating_sub(1);
                }
                if members.is_empty() {
                    self.rooms.remove(&room_id);
                }
            }
            changes.push(RoomCountChange {
                users: self.member_count(&room_id),
                room_id,
            });
        }
        changes
    }

    pub fn remove_room(&mut self, room_id: &str) -> Vec<String> {
        let Some(members) = self.rooms.remove(room_id) else {
            return Vec::new();
        };

        self.memberships = self.memberships.saturating_sub(members.len());
        for peer_id in &members {
            let should_drop_peer = if let Some(state) = self.peers.get_mut(peer_id) {
                state.rooms.remove(room_id);
                state.rooms.is_empty()
            } else {
                false
            };
            if should_drop_peer {
                self.peers.remove(peer_id);
            }
        }
        members.into_iter().collect()
    }
}

pub fn valid_temporary_room_id(room_id: &str) -> bool {
    !room_id.is_empty()
        && room_id != "world"
        && room_id.chars().count() <= 64
        && room_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_unique_members_and_moves_are_atomic() {
        let mut tracker = RoomMembershipTracker::default();
        let first = tracker
            .apply_snapshot("peer-a", 1, ["alpha"])
            .expect("first snapshot");
        assert_eq!(
            first,
            SnapshotApply::Applied(vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 1,
            }])
        );

        tracker
            .apply_snapshot("peer-b", 1, ["alpha"])
            .expect("second peer");
        assert_eq!(tracker.member_count("alpha"), 2);

        let moved = tracker
            .apply_snapshot("peer-a", 2, ["beta"])
            .expect("move snapshot");
        assert_eq!(
            moved,
            SnapshotApply::Applied(vec![
                RoomCountChange {
                    room_id: "alpha".into(),
                    users: 1,
                },
                RoomCountChange {
                    room_id: "beta".into(),
                    users: 1,
                },
            ])
        );
        assert_eq!(tracker.rooms_for_peer("peer-a"), vec!["beta"]);
    }

    #[test]
    fn duplicate_stale_and_conflicting_revisions_fail_closed() {
        let mut tracker = RoomMembershipTracker::default();
        tracker
            .apply_snapshot("peer-a", 7, ["alpha", "beta"])
            .expect("baseline");

        assert_eq!(
            tracker
                .apply_snapshot("peer-a", 7, ["beta", "alpha"])
                .expect("duplicate"),
            SnapshotApply::Duplicate
        );
        assert_eq!(
            tracker
                .apply_snapshot("peer-a", 6, ["alpha"])
                .expect("stale"),
            SnapshotApply::Stale
        );
        assert_eq!(
            tracker
                .apply_snapshot("peer-a", 7, ["alpha"])
                .expect("conflict"),
            SnapshotApply::Conflict
        );
        assert_eq!(tracker.member_count("alpha"), 1);
        assert_eq!(tracker.member_count("beta"), 1);
    }

    #[test]
    fn peer_disconnect_and_room_close_cleanup_indexes() {
        let mut tracker = RoomMembershipTracker::default();
        tracker
            .apply_snapshot("peer-a", 1, ["alpha", "beta"])
            .expect("peer a");
        tracker
            .apply_snapshot("peer-b", 1, ["alpha"])
            .expect("peer b");

        let disconnect = tracker.remove_peer("peer-a");
        assert_eq!(
            disconnect,
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

        assert_eq!(tracker.remove_room("alpha"), vec!["peer-b"]);
        assert_eq!(tracker.member_count("alpha"), 0);
        assert!(tracker.rooms_for_peer("peer-b").is_empty());
    }

    #[test]
    fn invalid_snapshots_are_rejected_before_state_changes() {
        let mut tracker = RoomMembershipTracker::default();
        assert_eq!(
            tracker.apply_snapshot("", 1, ["alpha"]),
            Err(SnapshotError::InvalidPeer)
        );
        assert_eq!(
            tracker.apply_snapshot("peer-a", 0, ["alpha"]),
            Err(SnapshotError::InvalidRevision)
        );
        assert_eq!(
            tracker.apply_snapshot("peer-a", 1, ["world"]),
            Err(SnapshotError::InvalidRoomId("world".into()))
        );
        assert_eq!(
            tracker.apply_snapshot("peer-a", 1, ["bad room"]),
            Err(SnapshotError::InvalidRoomId("bad room".into()))
        );
        assert_eq!(
            tracker.apply_snapshot("peer-a", 1, ["alpha", "alpha"]),
            Err(SnapshotError::DuplicateRoomId("alpha".into()))
        );
        assert_eq!(tracker.member_count("alpha"), 0);
    }

    #[test]
    fn resource_limits_are_checked_before_mutation() {
        let mut tracker = RoomMembershipTracker::new(MembershipLimits {
            rooms_per_peer: 2,
            memberships_total: 2,
            peers_total: 1,
        });
        assert_eq!(
            tracker.apply_snapshot("peer-a", 1, ["a", "b", "c"]),
            Err(SnapshotError::TooManyRooms)
        );
        tracker
            .apply_snapshot("peer-a", 1, ["a", "b"])
            .expect("within limit");
        assert_eq!(
            tracker.apply_snapshot("peer-b", 1, ["a"]),
            Err(SnapshotError::CapacityExceeded)
        );
        assert_eq!(
            tracker.apply_snapshot("peer-b", 1, std::iter::empty::<&str>()),
            Err(SnapshotError::CapacityExceeded)
        );
        assert_eq!(tracker.member_count("a"), 1);
        assert_eq!(tracker.member_count("b"), 1);
    }
}
