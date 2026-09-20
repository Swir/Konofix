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
#[path = "../src/room_membership_runtime.rs"]
mod room_membership_runtime;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;

use libp2p::{identity::Keypair, PeerId};
use room_membership_application::{
    MembershipSnapshotPayload, RoomMembershipApplicationAdapter, RoomUserCountUpdate,
};

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

#[test]
fn application_adapter_converges_switch_replay_and_departure_without_revision_inflation() {
    let local = peer_id();
    let remote = peer_id();
    let mut app = RoomMembershipApplicationAdapter::new(local.clone());

    app.announce_room("alpha").expect("alpha");
    app.announce_room("beta").expect("beta");

    let alpha = app.enter_room(Some("alpha")).expect("local alpha");
    let alpha_snapshot = alpha.publish.clone().expect("alpha snapshot");
    assert_eq!(alpha_snapshot.revision, 1);
    assert_eq!(app.heartbeat_payload(), Some(alpha_snapshot.clone()));
    assert_eq!(app.heartbeat_payload(), Some(alpha_snapshot));

    let remote_alpha = MembershipSnapshotPayload {
        peer_id: remote.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };
    let remote_effects = app
        .receive_authenticated_snapshot(remote_alpha.clone(), &remote)
        .expect("remote alpha");
    assert_eq!(
        RoomMembershipApplicationAdapter::remote_count_updates(remote_effects),
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 2,
        }]
    );

    let duplicate = app
        .receive_authenticated_snapshot(remote_alpha, &remote)
        .expect("remote duplicate");
    assert!(RoomMembershipApplicationAdapter::remote_count_updates(duplicate).is_empty());

    let beta = app.enter_room(Some("beta")).expect("local beta");
    let beta_snapshot = beta.publish.clone().expect("beta snapshot");
    assert_eq!(beta_snapshot.revision, 2);
    assert_eq!(beta_snapshot.rooms, vec!["beta"]);
    assert_eq!(
        beta.counts,
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
    assert_eq!(app.heartbeat_payload(), Some(beta_snapshot));

    // A non-final transport close cannot erase membership.
    assert!(app.connection_closed(&remote, 1).is_empty());
    assert_eq!(app.total_count("alpha"), 1);

    // The final close is authoritative and exactly-once.
    assert_eq!(
        app.connection_closed(&remote, 0),
        vec![RoomUserCountUpdate {
            room_id: "alpha".into(),
            users: 0,
        }]
    );
    assert!(app.authenticated_goodbye(&remote).is_empty());
    assert!(app.presence_expired(&remote).is_empty());
}

#[test]
fn active_room_close_produces_leave_snapshot_and_zero_count_for_ui() {
    let local = peer_id();
    let mut app = RoomMembershipApplicationAdapter::new(local.clone());
    app.create_and_enter_local_room("alpha")
        .expect("create alpha");

    let close = app.room_closed("alpha").expect("close alpha");
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
    assert!(!app.known_room("alpha"));
}
