#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_application.rs"]
mod room_membership_application;
#[path = "../src/room_membership_desktop.rs"]
mod room_membership_desktop;
#[path = "../src/room_membership_live.rs"]
mod room_membership_live;
#[path = "../src/room_membership_network.rs"]
mod room_membership_network;
#[path = "../src/room_membership_production.rs"]
mod room_membership_production;
#[path = "../src/room_membership_runtime.rs"]
mod room_membership_runtime;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;

use libp2p::{identity::Keypair, PeerId};
use room_membership_application::{MembershipSnapshotPayload, RoomUserCountUpdate};
use room_membership_production::RoomMembershipProductionBridge;

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

#[test]
fn two_peers_converge_switch_world_and_replay_without_revision_inflation() {
    let peer_a = peer_id();
    let peer_b = peer_id();
    let mut a = RoomMembershipProductionBridge::new(peer_a.clone());
    let mut b = RoomMembershipProductionBridge::new(peer_b.clone());

    for room in ["alpha", "beta"] {
        a.announce_room(room).expect("announce on A");
        b.announce_room(room).expect("announce on B");
    }

    let a_alpha = a
        .create_and_enter_local_room("alpha")
        .expect("A creates alpha");
    let a_alpha_snapshot = a_alpha.publish.clone().expect("A alpha snapshot");
    assert_eq!(a_alpha_snapshot.revision, 1);
    assert_eq!(
        a_alpha.counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 1,
        }]
    );

    let b_from_a = b
        .authenticated_snapshot(a_alpha_snapshot.clone(), &peer_a)
        .expect("B accepts A alpha snapshot");
    assert_eq!(
        b_from_a.counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 1,
        }]
    );

    let b_alpha = b.enter_room("alpha").expect("B enters alpha");
    let b_alpha_snapshot = b_alpha.publish.clone().expect("B alpha snapshot");
    assert_eq!(b_alpha_snapshot.revision, 1);
    assert_eq!(
        b_alpha.counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 2,
        }]
    );

    let a_from_b = a
        .authenticated_snapshot(b_alpha_snapshot.clone(), &peer_b)
        .expect("A accepts B alpha snapshot");
    assert_eq!(
        a_from_b.counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 2,
        }]
    );
    assert_eq!(a.total_count("alpha"), 2);
    assert_eq!(b.total_count("alpha"), 2);

    let replay = a
        .authenticated_snapshot(b_alpha_snapshot, &peer_b)
        .expect("duplicate replay remains valid but silent");
    assert!(replay.publish.is_none());
    assert!(replay.counts.is_empty());

    let a_beta = a.enter_room("beta").expect("A switches to beta");
    let a_beta_snapshot = a_beta.publish.clone().expect("A beta snapshot");
    assert_eq!(a_beta_snapshot.revision, 2);
    assert_eq!(a_beta_snapshot.rooms, vec!["beta"]);
    assert_eq!(
        a_beta.counts,
        vec![
            RoomUserCountUpdate {
                room_id: "alpha".into(),
                users: 1,
            },
            RoomUserCountUpdate {
                room_id: "beta".into(),
                users: 1,
            },
        ]
    );

    let b_from_switch = b
        .authenticated_snapshot(a_beta_snapshot, &peer_a)
        .expect("B accepts A switch");
    assert_eq!(
        b_from_switch.counts,
        vec![
            RoomUserCountUpdate {
                room_id: "alpha".into(),
                users: 1,
            },
            RoomUserCountUpdate {
                room_id: "beta".into(),
                users: 1,
            },
        ]
    );

    let a_world = a.enter_world().expect("A returns to WORLD");
    let a_world_snapshot = a_world.publish.clone().expect("A WORLD snapshot");
    assert_eq!(a_world_snapshot.revision, 3);
    assert!(a_world_snapshot.rooms.is_empty());
    assert_eq!(
        a_world.counts,
        vec![RoomUserCountUpdate {
            room_id: "beta".into(),
            users: 0,
        }]
    );
    assert_eq!(a.heartbeat().publish, Some(a_world_snapshot));
    assert!(a.heartbeat().counts.is_empty());
}

#[test]
fn lifecycle_departure_effects_are_final_connection_only_and_idempotent() {
    let local = peer_id();
    let remote = peer_id();
    let mut bridge = RoomMembershipProductionBridge::new(local);
    bridge.announce_room("alpha").expect("announce alpha");
    bridge.enter_room("alpha").expect("local user enters alpha");
    bridge
        .authenticated_snapshot(
            MembershipSnapshotPayload {
                peer_id: remote.to_string(),
                revision: 1,
                rooms: vec!["alpha".into()],
            },
            &remote,
        )
        .expect("remote enters alpha");
    assert_eq!(bridge.total_count("alpha"), 2);

    let transient = bridge.connection_closed(&remote, 1);
    assert!(transient.publish.is_none());
    assert!(transient.counts.is_empty());
    assert_eq!(bridge.total_count("alpha"), 2);

    assert_eq!(
        bridge.connection_closed(&remote, 0).counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 1,
        }]
    );
    assert_eq!(bridge.total_count("alpha"), 1);
    assert!(bridge.authenticated_goodbye(&remote).counts.is_empty());
    assert!(bridge.presence_expired(&remote).counts.is_empty());
}

#[test]
fn forged_snapshot_is_rejected_before_any_production_effect_escapes() {
    let local = peer_id();
    let remote = peer_id();
    let attacker = peer_id();
    let mut bridge = RoomMembershipProductionBridge::new(local);
    bridge.announce_room("alpha").expect("announce alpha");

    let result = bridge.authenticated_snapshot(
        MembershipSnapshotPayload {
            peer_id: remote.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        },
        &attacker,
    );
    assert!(result.is_err());
    assert_eq!(bridge.total_count("alpha"), 0);
}

#[test]
fn active_room_close_preserves_leave_publish_and_zero_count_effects() {
    let local = peer_id();
    let mut bridge = RoomMembershipProductionBridge::new(local.clone());
    bridge
        .create_and_enter_local_room("alpha")
        .expect("create alpha");

    let close = bridge.room_closed("alpha").expect("close alpha");
    assert_eq!(
        close.publish,
        Some(MembershipSnapshotPayload {
            peer_id: local.to_string(),
            revision: 2,
            rooms: Vec::new(),
        })
    );
    assert_eq!(
        close.counts,
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 0,
        }]
    );
    assert!(!bridge.known_room("alpha"));
    assert_eq!(bridge.heartbeat().publish, close.publish);
}
