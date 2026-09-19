#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;
#[path = "../src/room_membership_runtime.rs"]
mod room_membership_runtime;

use libp2p::{identity::Keypair, PeerId};
use room_membership::RoomCountChange;
use room_membership_runtime::{RemoteMembershipTransition, RoomMembershipRuntime};
use room_membership_wire::RoomMembershipSnapshot;

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

#[test]
fn rooms2_runtime_controller_converges_two_peer_counts() {
    let local = peer_id();
    let remote = peer_id();
    let mut runtime = RoomMembershipRuntime::new(local);
    runtime
        .register_rooms(["alpha", "beta"])
        .expect("known rooms");

    let first = runtime
        .set_local_rooms(["alpha"])
        .expect("local membership");
    assert_eq!(first.counts, vec![RoomCountChange {
        room_id: "alpha".into(),
        users: 1,
    }]);

    let snapshot = RoomMembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 1,
        rooms: vec!["alpha".into(), "beta".into()],
    };
    assert_eq!(
        runtime
            .apply_remote_snapshot(&snapshot, &remote)
            .expect("authenticated remote snapshot"),
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
}

#[test]
fn rooms2_runtime_disconnect_and_close_are_idempotent() {
    let local = peer_id();
    let remote = peer_id();
    let mut runtime = RoomMembershipRuntime::new(local);
    runtime.register_room("alpha").expect("known room");
    runtime
        .set_local_rooms(["alpha"])
        .expect("local membership");
    runtime
        .apply_remote_snapshot(
            &RoomMembershipSnapshot {
                peer_id: remote.to_string(),
                revision: 1,
                rooms: vec!["alpha".into()],
            },
            &remote,
        )
        .expect("remote membership");

    assert_eq!(
        runtime.remove_remote_peer(&remote),
        vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 1,
        }]
    );
    assert!(runtime.remove_remote_peer(&remote).is_empty());

    let first_close = runtime.close_room("alpha").expect("first close");
    assert!(first_close.existed);
    assert_eq!(first_close.count.expect("count").users, 0);
    assert!(runtime
        .close_room("alpha")
        .expect("duplicate close")
        .count
        .is_none());
}
