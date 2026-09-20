#[path = "../src/room_membership.rs"]
mod room_membership;
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
use room_membership::RoomCountChange;
use room_membership_live::RoomMembershipLiveCoordinator;
use room_membership_network::{RemoteTransportEffects, RoomMembershipNetworkEvent};

fn peer_id() -> PeerId {
    Keypair::generate_ed25519().public().to_peer_id()
}

fn event(peer: &PeerId, revision: u64, rooms: &[&str]) -> RoomMembershipNetworkEvent {
    RoomMembershipNetworkEvent::MembershipSnapshot {
        peer_id: peer.to_string(),
        revision,
        rooms: rooms.iter().map(|room| (*room).to_string()).collect(),
    }
}

#[test]
fn live_coordinator_survives_multi_connection_churn_without_phantom_decrement() {
    let local = peer_id();
    let remote = peer_id();
    let mut live = RoomMembershipLiveCoordinator::new(local);
    live.announce_room("alpha").expect("alpha");

    assert!(matches!(
        live.receive_authenticated_event(&event(&remote, 1, &["alpha"]), &remote)
            .expect("remote membership"),
        RemoteTransportEffects::Applied(_)
    ));
    assert_eq!(live.total_count("alpha"), 1);

    // One transport closed while another connection to the same peer remains.
    assert!(live.connection_closed(&remote, 1).is_empty());
    assert_eq!(live.total_count("alpha"), 1);

    // The final close is authoritative and cleanup is exactly-once.
    assert_eq!(
        live.connection_closed(&remote, 0),
        vec![RoomCountChange {
            room_id: "alpha".into(),
            users: 0,
        }]
    );
    assert!(live.presence_expired(&remote).is_empty());
    assert!(live.authenticated_goodbye(&remote).is_empty());
}

#[test]
fn live_coordinator_switch_close_and_resync_converge() {
    let local = peer_id();
    let remote = peer_id();
    let mut live = RoomMembershipLiveCoordinator::new(local);
    live.announce_room("alpha").expect("alpha");
    live.announce_room("beta").expect("beta");

    let alpha = live.enter_room(Some("alpha")).expect("local alpha");
    let first = alpha.publish.expect("alpha publish");
    assert_eq!(live.heartbeat_event(), Some(first));

    live.receive_authenticated_event(&event(&remote, 1, &["alpha"]), &remote)
        .expect("remote alpha");
    assert_eq!(live.total_count("alpha"), 2);

    let beta = live.enter_room(Some("beta")).expect("local beta");
    assert_eq!(
        beta.counts,
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

    let close = live.room_closed("beta").expect("close beta");
    assert_eq!(
        close.counts,
        vec![RoomCountChange {
            room_id: "beta".into(),
            users: 0,
        }]
    );
    assert!(close.publish.is_some());
    assert!(!live.known_room("beta"));
    assert_eq!(live.total_count("alpha"), 1);
}
