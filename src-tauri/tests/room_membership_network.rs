#[path = "../src/room_membership.rs"]
mod room_membership;
#[path = "../src/room_membership_wire.rs"]
mod room_membership_wire;
#[path = "../src/room_membership_runtime.rs"]
mod room_membership_runtime;
#[path = "../src/room_membership_desktop.rs"]
mod room_membership_desktop;
#[path = "../src/room_membership_network.rs"]
mod room_membership_network;

use libp2p::{identity::Keypair, PeerId};
use room_membership::RoomCountChange;
use room_membership_network::{
    RemoteTransportEffects, RoomMembershipNetwork, RoomMembershipNetworkEvent,
    RoomMembershipTransportError, MAX_ROOM_MEMBERSHIP_WIRE_BYTES,
};

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

#[test]
fn two_clients_exchange_authenticated_snapshots_and_converge_counts() {
    let alice_id = peer_id();
    let bob_id = peer_id();
    let mut alice = RoomMembershipNetwork::new(alice_id.clone());
    let mut bob = RoomMembershipNetwork::new(bob_id.clone());

    for side in [&mut alice, &mut bob] {
        side.register_announced_room("alpha").expect("register alpha");
    }

    let alice_join = alice.enter_room(Some("alpha")).expect("alice join");
    let alice_event = alice_join.publish.expect("alice publish");
    let alice_frame = RoomMembershipNetwork::encode_event(&alice_event).expect("alice frame");
    assert_eq!(
        bob.receive_authenticated(&alice_frame, &alice_id)
            .expect("bob receives alice"),
        RemoteTransportEffects::Applied(vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 1,
        }])
    );

    let bob_join = bob.enter_room(Some("alpha")).expect("bob join");
    let bob_event = bob_join.publish.expect("bob publish");
    let bob_frame = RoomMembershipNetwork::encode_event(&bob_event).expect("bob frame");
    assert_eq!(
        alice
            .receive_authenticated(&bob_frame, &bob_id)
            .expect("alice receives bob"),
        RemoteTransportEffects::Applied(vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 2,
        }])
    );
    assert_eq!(alice.total_count("alpha"), 2);
    assert_eq!(bob.total_count("alpha"), 2);

    assert_eq!(
        alice
            .receive_authenticated(&bob_frame, &bob_id)
            .expect("bob replay"),
        RemoteTransportEffects::Duplicate
    );
    assert_eq!(alice.total_count("alpha"), 2);

    assert_eq!(
        alice.peer_departed(&bob_id),
        vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 1,
        }]
    );
    assert_eq!(alice.total_count("alpha"), 1);
}

#[test]
fn room_switch_republishes_one_monotonic_snapshot_and_updates_both_counts() {
    let local = peer_id();
    let mut network = RoomMembershipNetwork::new(local.clone());
    network.register_announced_room("alpha").expect("alpha");
    network.register_announced_room("beta").expect("beta");

    let alpha = network.enter_room(Some("alpha")).expect("enter alpha");
    let alpha_event = alpha.publish.expect("alpha publish");
    let alpha_revision = match alpha_event {
        RoomMembershipNetworkEvent::MembershipSnapshot { revision, .. } => revision,
    };

    let beta = network.enter_room(Some("beta")).expect("enter beta");
    assert_eq!(
        beta.counts,
        vec![
            RoomCountChange {
                room_id: "alpha".into(),
                users: 0,
            },
            RoomCountChange {
                room_id: "beta".into(),
                users: 1,
            },
        ]
    );
    let beta_event = beta.publish.expect("beta publish");
    match beta_event {
        RoomMembershipNetworkEvent::MembershipSnapshot {
            peer_id,
            revision,
            rooms,
        } => {
            assert_eq!(peer_id, local.to_string());
            assert_eq!(revision, alpha_revision + 1);
            assert_eq!(rooms, vec!["beta"]);
        }
    }
}

#[test]
fn forged_unknown_and_oversized_frames_fail_without_count_changes() {
    let local = peer_id();
    let remote = peer_id();
    let attacker = peer_id();
    let mut network = RoomMembershipNetwork::new(local);
    network.register_announced_room("alpha").expect("alpha");

    let forged = RoomMembershipNetworkEvent::MembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 1,
        rooms: vec!["alpha".into()],
    };
    let forged_frame = RoomMembershipNetwork::encode_event(&forged).expect("encode");
    assert!(network
        .receive_authenticated(&forged_frame, &attacker)
        .is_err());
    assert_eq!(network.total_count("alpha"), 0);

    let unknown = RoomMembershipNetworkEvent::MembershipSnapshot {
        peer_id: remote.to_string(),
        revision: 2,
        rooms: vec!["not-announced".into()],
    };
    let unknown_frame = RoomMembershipNetwork::encode_event(&unknown).expect("encode unknown");
    assert!(network
        .receive_authenticated(&unknown_frame, &remote)
        .is_err());
    assert_eq!(network.total_count("alpha"), 0);

    assert_eq!(
        RoomMembershipNetwork::decode_event(&vec![0u8; MAX_ROOM_MEMBERSHIP_WIRE_BYTES + 1]),
        Err(RoomMembershipTransportError::FrameTooLarge)
    );
}