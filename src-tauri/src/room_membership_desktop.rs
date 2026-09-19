use libp2p::PeerId;

use crate::room_membership::RoomCountChange;
use crate::room_membership_runtime::{
    MembershipRuntimeError, RemoteMembershipTransition, RoomClosureTransition,
    RoomMembershipRuntime,
};
use crate::room_membership_wire::RoomMembershipSnapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopMembershipEffects {
    pub snapshot: Option<RoomMembershipSnapshot>,
    pub counts: Vec<RoomCountChange>,
}

#[derive(Debug)]
pub struct DesktopRoomMembership {
    runtime: RoomMembershipRuntime,
}

impl DesktopRoomMembership {
    pub fn new(local_peer: PeerId) -> Self {
        Self {
            runtime: RoomMembershipRuntime::new(local_peer),
        }
    }

    pub fn register_announced_room(
        &mut self,
        room_id: &str,
    ) -> Result<bool, MembershipRuntimeError> {
        self.runtime.register_room(room_id)
    }

    pub fn create_and_enter_local_room(
        &mut self,
        room_id: &str,
    ) -> Result<DesktopMembershipEffects, MembershipRuntimeError> {
        self.runtime.register_room(room_id)?;
        self.enter_room(Some(room_id))
    }

    pub fn enter_room(
        &mut self,
        room_id: Option<&str>,
    ) -> Result<DesktopMembershipEffects, MembershipRuntimeError> {
        let transition = match room_id {
            None | Some("world") => self.runtime.set_local_rooms(std::iter::empty::<&str>())?,
            Some(room_id) => self.runtime.set_local_rooms([room_id])?,
        };
        Ok(DesktopMembershipEffects {
            snapshot: transition.snapshot,
            counts: transition.counts,
        })
    }

    pub fn current_snapshot(&self) -> Option<RoomMembershipSnapshot> {
        self.runtime.current_local_snapshot()
    }

    pub fn apply_remote_snapshot(
        &mut self,
        snapshot: &RoomMembershipSnapshot,
        authenticated_source: &PeerId,
    ) -> Result<RemoteMembershipTransition, MembershipRuntimeError> {
        self.runtime
            .apply_remote_snapshot(snapshot, authenticated_source)
    }

    pub fn peer_departed(&mut self, peer_id: &PeerId) -> Vec<RoomCountChange> {
        self.runtime.remove_remote_peer(peer_id)
    }

    pub fn close_room(
        &mut self,
        room_id: &str,
    ) -> Result<DesktopMembershipEffects, MembershipRuntimeError> {
        let RoomClosureTransition {
            existed,
            snapshot,
            count,
        } = self.runtime.close_room(room_id)?;

        if !existed {
            return Ok(DesktopMembershipEffects {
                snapshot: None,
                counts: Vec::new(),
            });
        }

        Ok(DesktopMembershipEffects {
            snapshot,
            counts: count.into_iter().collect(),
        })
    }

    pub fn total_count(&self, room_id: &str) -> u32 {
        self.runtime.total_count(room_id)
    }

    pub fn known_room(&self, room_id: &str) -> bool {
        self.runtime.known_rooms().contains(room_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room_membership_runtime::RemoteMembershipTransition;
    use libp2p::identity::Keypair;

    fn peer_id() -> PeerId {
        Keypair::generate_ed25519().public().to_peer_id()
    }

    #[test]
    fn room_switching_produces_publishable_monotonic_snapshots() {
        let local = peer_id();
        let mut desktop = DesktopRoomMembership::new(local.clone());
        desktop
            .register_announced_room("alpha")
            .expect("register alpha");
        desktop
            .register_announced_room("beta")
            .expect("register beta");

        let alpha = desktop.enter_room(Some("alpha")).expect("enter alpha");
        assert_eq!(alpha.snapshot.as_ref().expect("alpha snapshot").revision, 1);
        assert_eq!(alpha.snapshot.as_ref().expect("alpha snapshot").rooms, vec!["alpha"]);
        assert_eq!(alpha.counts, vec![RoomCountChange { room_id: "alpha".into(), users: 1 }]);

        let beta = desktop.enter_room(Some("beta")).expect("enter beta");
        assert_eq!(beta.snapshot.as_ref().expect("beta snapshot").revision, 2);
        assert_eq!(beta.snapshot.as_ref().expect("beta snapshot").rooms, vec!["beta"]);
        assert_eq!(beta.counts, vec![
            RoomCountChange { room_id: "alpha".into(), users: 0 },
            RoomCountChange { room_id: "beta".into(), users: 1 },
        ]);

        let heartbeat = desktop.current_snapshot().expect("heartbeat snapshot");
        assert_eq!(heartbeat.revision, 2);
        assert_eq!(heartbeat.peer_id, local.to_string());
        assert_eq!(heartbeat.rooms, vec!["beta"]);

        let world = desktop.enter_room(Some("world")).expect("return world");
        assert_eq!(world.snapshot.as_ref().expect("world leave snapshot").revision, 3);
        assert!(world.snapshot.as_ref().expect("world leave snapshot").rooms.is_empty());
        assert_eq!(world.counts, vec![RoomCountChange { room_id: "beta".into(), users: 0 }]);
    }

    #[test]
    fn remote_snapshot_replay_and_departure_converge_counts() {
        let local = peer_id();
        let remote = peer_id();
        let mut desktop = DesktopRoomMembership::new(local);
        desktop
            .register_announced_room("alpha")
            .expect("register alpha");
        desktop.enter_room(Some("alpha")).expect("local joins");

        let snapshot = RoomMembershipSnapshot {
            peer_id: remote.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        };
        assert_eq!(
            desktop
                .apply_remote_snapshot(&snapshot, &remote)
                .expect("remote apply"),
            RemoteMembershipTransition::Applied(vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 2,
            }])
        );
        assert_eq!(
            desktop
                .apply_remote_snapshot(&snapshot, &remote)
                .expect("duplicate apply"),
            RemoteMembershipTransition::Duplicate
        );
        assert_eq!(desktop.total_count("alpha"), 2);
        assert_eq!(
            desktop.peer_departed(&remote),
            vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 1,
            }]
        );
        assert_eq!(desktop.total_count("alpha"), 1);
    }

    #[test]
    fn local_room_close_returns_leave_snapshot_for_network_republication() {
        let local = peer_id();
        let mut desktop = DesktopRoomMembership::new(local);
        let created = desktop
            .create_and_enter_local_room("alpha")
            .expect("create and enter alpha");
        assert_eq!(created.snapshot.expect("create snapshot").revision, 1);
        assert!(desktop.known_room("alpha"));

        let closed = desktop.close_room("alpha").expect("close alpha");
        let leave = closed.snapshot.expect("leave snapshot");
        assert_eq!(leave.revision, 2);
        assert!(leave.rooms.is_empty());
        assert_eq!(
            closed.counts,
            vec![RoomCountChange {
                room_id: "alpha".into(),
                users: 0,
            }]
        );
        assert!(!desktop.known_room("alpha"));
    }

    #[test]
    fn unknown_room_switch_fails_without_creating_phantom_membership() {
        let mut desktop = DesktopRoomMembership::new(peer_id());
        assert!(matches!(
            desktop.enter_room(Some("unknown")),
            Err(MembershipRuntimeError::UnknownRoomId(room)) if room == "unknown"
        ));
        assert!(desktop.current_snapshot().is_none());
        assert_eq!(desktop.total_count("unknown"), 0);
    }
}
