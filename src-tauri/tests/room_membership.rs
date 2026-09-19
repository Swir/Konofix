#[path = "../src/room_membership.rs"]
mod room_membership;

use room_membership::{RoomMembershipTracker, SnapshotApply, SnapshotError};

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
