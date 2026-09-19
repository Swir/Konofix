#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;

use room_membership::{RoomMembershipTracker, SnapshotApply, SnapshotError};
use room_membership_wire::{MembershipWireError, RoomMembershipSnapshot};

#[test]
fn rooms2_counts_follow_revisioned_peer_snapshots() {
    let mut tracker = RoomMembershipTracker::default();

    tracker
        .apply_snapshot("peer-a", 1, ["alpha"])
        .expect("peer-a joins alpha");
    tracker
        .apply_snapshot("peer-b", 1, ["alpha", "beta"])
        .expect("peer-b joins alpha and beta");

    assert_eq!(tracker.member_count("alpha"), 2);
    assert_eq!(tracker.member_count("beta"), 1);

    assert!(matches!(
        tracker
            .apply_snapshot("peer-a", 2, ["beta"])
            .expect("peer-a moves to beta"),
        SnapshotApply::Applied(_)
    ));
    assert_eq!(tracker.member_count("alpha"), 1);
    assert_eq!(tracker.member_count("beta"), 2);

    tracker.remove_peer("peer-b");
    assert_eq!(tracker.member_count("alpha"), 0);
    assert_eq!(tracker.member_count("beta"), 1);
}

#[test]
fn rooms2_rejects_ambiguous_and_unbounded_snapshot_input() {
    let mut tracker = RoomMembershipTracker::default();
    tracker
        .apply_snapshot("peer-a", 10, ["alpha"])
        .expect("baseline");

    assert_eq!(
        tracker
            .apply_snapshot("peer-a", 10, ["beta"])
            .expect("same revision is classified"),
        SnapshotApply::Conflict
    );
    assert_eq!(
        tracker.apply_snapshot("peer-a", 11, ["world"]),
        Err(SnapshotError::InvalidRoomId("world".into()))
    );
    assert_eq!(tracker.member_count("alpha"), 1);
    assert_eq!(tracker.member_count("beta"), 0);
}

#[test]
fn rooms2_wire_snapshot_is_bound_to_authenticated_libp2p_source() {
    let source = libp2p::identity::Keypair::generate_ed25519()
        .public()
        .to_peer_id();
    let attacker = libp2p::identity::Keypair::generate_ed25519()
        .public()
        .to_peer_id();
    let mut snapshot = RoomMembershipSnapshot {
        peer_id: source.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };

    assert_eq!(snapshot.validate_authenticated_source(&source), Ok(()));
    snapshot.peer_id = attacker.to_string();
    assert_eq!(
        snapshot.validate_authenticated_source(&source),
        Err(MembershipWireError::SourceMismatch)
    );
}
