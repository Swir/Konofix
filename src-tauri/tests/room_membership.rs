#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;

use std::collections::BTreeSet;

use room_membership::{RoomMembershipTracker, SnapshotApply, SnapshotError};
use room_membership_wire::{
    apply_authenticated_snapshot, LocalMembershipError, LocalMembershipUpdate,
    LocalRoomMembershipState, MembershipApplyError, MembershipWireError, RoomMembershipSnapshot,
};

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

#[test]
fn rooms2_local_publisher_is_monotonic_idempotent_and_fail_closed() {
    let source = libp2p::identity::Keypair::generate_ed25519()
        .public()
        .to_peer_id();
    let mut local = LocalRoomMembershipState::default();

    let first = local
        .replace_rooms(&source, ["beta", "alpha"])
        .expect("first membership change");
    assert_eq!(
        first,
        LocalMembershipUpdate::Publish(RoomMembershipSnapshot {
            peer_id: source.to_string(),
            revision: 1,
            rooms: vec!["alpha".into(), "beta".into()],
        })
    );
    assert_eq!(
        local.replace_rooms(&source, ["alpha", "beta"]),
        Ok(LocalMembershipUpdate::Unchanged)
    );
    assert_eq!(local.revision(), 1);

    assert_eq!(
        local.replace_rooms(&source, ["alpha", "alpha"]),
        Err(LocalMembershipError::DuplicateRoomId("alpha".into()))
    );
    assert_eq!(local.revision(), 1);
    assert_eq!(
        local.rooms(),
        &BTreeSet::from(["alpha".into(), "beta".into()])
    );
}

#[test]
fn rooms2_authenticated_apply_rejects_unknown_and_forged_memberships_without_mutation() {
    let source = libp2p::identity::Keypair::generate_ed25519()
        .public()
        .to_peer_id();
    let attacker = libp2p::identity::Keypair::generate_ed25519()
        .public()
        .to_peer_id();
    let known = BTreeSet::from(["alpha".into()]);
    let mut tracker = RoomMembershipTracker::default();

    let accepted = RoomMembershipSnapshot {
        peer_id: source.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };
    assert!(matches!(
        apply_authenticated_snapshot(&mut tracker, &accepted, &source, &known),
        Ok(SnapshotApply::Applied(_))
    ));
    assert_eq!(tracker.member_count("alpha"), 1);

    let unknown = RoomMembershipSnapshot {
        peer_id: source.to_string(),
        revision: 2,
        rooms: vec!["beta".into()],
    };
    assert_eq!(
        apply_authenticated_snapshot(&mut tracker, &unknown, &source, &known),
        Err(MembershipApplyError::Wire(
            MembershipWireError::UnknownRoomId("beta".into())
        ))
    );
    assert_eq!(tracker.member_count("alpha"), 1);
    assert_eq!(tracker.member_count("beta"), 0);

    let forged = RoomMembershipSnapshot {
        peer_id: source.to_string(),
        revision: 2,
        rooms: vec!["alpha".into()],
    };
    assert_eq!(
        apply_authenticated_snapshot(&mut tracker, &forged, &attacker, &known),
        Err(MembershipApplyError::Wire(
            MembershipWireError::SourceMismatch
        ))
    );
    assert_eq!(tracker.member_count("alpha"), 1);
}
