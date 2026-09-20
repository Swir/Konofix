#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_desktop.rs"]
mod room_membership_desktop;
#[path = "../src/room_membership_runtime.rs"]
mod room_membership_runtime;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;

use libp2p::{identity::Keypair, PeerId};
use room_membership::RoomCountChange;
use room_membership_desktop::DesktopRoomMembership;
use room_membership_runtime::RemoteMembershipTransition;
use room_membership_wire::RoomMembershipSnapshot;

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

#[test]
fn desktop_contract_converges_create_switch_remote_replay_and_disconnect() {
    let local = peer_id();
    let remote = peer_id();
    let mut desktop = DesktopRoomMembership::new(local.clone());

    let create = desktop
        .create_and_enter_local_room("alpha")
        .expect("local room creation");
    let first = create.snapshot.expect("first snapshot");
    assert_eq!(first.peer_id, local.to_string());
    assert_eq!(first.revision, 1);
    assert_eq!(first.rooms, vec!["alpha"]);
    assert_eq!(
        create.counts,
        vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 1,
        }]
    );

    let remote_join = RoomMembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };
    assert_eq!(
        desktop
            .apply_remote_snapshot(&remote_join, &remote)
            .expect("remote alpha join"),
        RemoteMembershipTransition::Applied(vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 2,
        }])
    );
    assert_eq!(
        desktop
            .apply_remote_snapshot(&remote_join, &remote)
            .expect("remote duplicate"),
        RemoteMembershipTransition::Duplicate
    );

    desktop
        .register_announced_room("beta")
        .expect("remote room announcement");
    let move_to_beta = desktop.enter_room(Some("beta")).expect("switch beta");
    assert_eq!(
        move_to_beta
            .snapshot
            .as_ref()
            .expect("move snapshot")
            .revision,
        2
    );
    assert_eq!(
        move_to_beta.counts,
        vec![
            RoomCountChange {
                room_id: "alpha".into(),
                users: 1,
            },
            RoomCountChange {
                room_id: "beta".into(),
                users: 1,
            },
        ]
    );

    let heartbeat = desktop.current_snapshot().expect("resync snapshot");
    assert_eq!(heartbeat.revision, 2);
    assert_eq!(heartbeat.rooms, vec!["beta"]);

    assert_eq!(
        desktop.peer_departed(&remote),
        vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 0,
        }]
    );
    assert_eq!(desktop.total_count("alpha"), 0);
    assert_eq!(desktop.total_count("beta"), 1);

    let world = desktop.enter_room(Some("world")).expect("return world");
    assert_eq!(world.snapshot.as_ref().expect("leave snapshot").revision, 3);
    assert!(world
        .snapshot
        .as_ref()
        .expect("leave snapshot")
        .rooms
        .is_empty());
    assert_eq!(
        world.counts,
        vec![RoomCountChange {
            room_id: "beta".into(),
            users: 0,
        }]
    );
}

#[test]
fn desktop_contract_fails_closed_for_unknown_and_forged_membership() {
    let local = peer_id();
    let remote = peer_id();
    let attacker = peer_id();
    let mut desktop = DesktopRoomMembership::new(local);
    desktop
        .register_announced_room("alpha")
        .expect("register alpha");

    assert!(desktop.enter_room(Some("missing")).is_err());
    assert_eq!(desktop.total_count("alpha"), 0);

    let forged = RoomMembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };
    assert!(desktop.apply_remote_snapshot(&forged, &attacker).is_err());
    assert_eq!(desktop.total_count("alpha"), 0);

    let unknown = RoomMembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 2,
        rooms: vec!["missing".into()],
    };
    assert!(desktop.apply_remote_snapshot(&unknown, &remote).is_err());
    assert_eq!(desktop.total_count("alpha"), 0);
}
