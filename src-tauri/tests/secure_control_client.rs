#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/secure_control_client.rs"]
mod secure_control_client;

use libp2p::PeerId;
use secure_control_client::{ObservedRoomSecurity, SecureControlClient, SecureResponseOutcome};
use secure_control_transport_helpers::{private_request, room_request};
use secure_channels::{ControlRequest, ControlResponse, PrivateDirectMessage, SecretString};
use uuid::Uuid;

mod secure_control_transport_helpers {
    use super::*;

    pub fn room_request(room_id: &str, password: &str) -> ControlRequest {
        ControlRequest::RoomJoin {
            request_id: Uuid::new_v4().to_string(),
            room_id: room_id.to_string(),
            password: SecretString::new(password.to_string()),
        }
    }

    pub fn private_request(sender: &PeerId, target: &PeerId) -> ControlRequest {
        ControlRequest::PrivateMessage(PrivateDirectMessage {
            id: Uuid::new_v4().to_string(),
            peer_id: sender.to_string(),
            target_peer_id: target.to_string(),
            nick: "Alice".into(),
            nick_color: Some("#62E5FF".into()),
            text: "private hello :)".into(),
            timestamp: 1_000,
        })
    }
}

fn protected_room(owner: PeerId, revision: u64) -> ObservedRoomSecurity {
    ObservedRoomSecurity {
        room_id: "friends".into(),
        owner,
        password_protected: true,
        auth_revision: revision,
    }
}

#[test]
fn protected_room_requires_matching_owner_ack_and_current_revision() {
    let local = PeerId::random();
    let owner = PeerId::random();
    let attacker = PeerId::random();
    let mut client = SecureControlClient::default();
    client.observe_room(protected_room(owner, 7));
    assert!(client.room_requires_authorization("friends", &local));

    let request = room_request("friends", "secret room");
    let ControlRequest::RoomJoin { request_id, .. } = &request else {
        unreachable!()
    };
    let request_id = request_id.clone();
    client.track_room_join(&request, owner, 7).unwrap();

    assert_eq!(
        client.handle_response(
            &attacker,
            ControlResponse::RoomJoin {
                request_id: request_id.clone(),
                granted: true,
                reason: None,
            },
        ),
        SecureResponseOutcome::Ignored
    );
    assert!(!client.room_authorized("friends", &local));

    assert_eq!(
        client.handle_response(
            &owner,
            ControlResponse::RoomJoin {
                request_id,
                granted: true,
                reason: None,
            },
        ),
        SecureResponseOutcome::RoomJoinGranted {
            room_id: "friends".into(),
            auth_revision: 7,
        }
    );
    assert!(client.room_authorized("friends", &local));

    client.observe_room(protected_room(owner, 8));
    assert!(client.room_requires_authorization("friends", &local));
    assert!(!client.room_authorized("friends", &local));
}

#[test]
fn unlocked_and_owned_rooms_do_not_require_remote_authorization() {
    let local = PeerId::random();
    let remote = PeerId::random();
    let mut client = SecureControlClient::default();
    client.observe_room(ObservedRoomSecurity {
        room_id: "public".into(),
        owner: remote,
        password_protected: false,
        auth_revision: 1,
    });
    client.observe_room(ObservedRoomSecurity {
        room_id: "mine".into(),
        owner: local,
        password_protected: true,
        auth_revision: 1,
    });
    assert!(client.room_authorized("public", &local));
    assert!(client.room_authorized("mine", &local));
    assert!(!client.room_requires_authorization("public", &local));
    assert!(!client.room_requires_authorization("mine", &local));
}

#[test]
fn private_ack_is_bound_to_expected_peer_and_message_id() {
    let sender = PeerId::random();
    let target = PeerId::random();
    let attacker = PeerId::random();
    let mut client = SecureControlClient::default();

    let request = private_request(&sender, &target);
    let ControlRequest::PrivateMessage(message) = &request else {
        unreachable!()
    };
    let message = message.clone();
    client.track_private_message(&request, target).unwrap();

    assert_eq!(
        client.handle_response(
            &attacker,
            ControlResponse::PrivateAck {
                message_id: message.id.clone(),
                accepted: true,
                reason: None,
            },
        ),
        SecureResponseOutcome::Ignored
    );

    assert_eq!(
        client.handle_response(
            &target,
            ControlResponse::PrivateAck {
                message_id: message.id.clone(),
                accepted: true,
                reason: None,
            },
        ),
        SecureResponseOutcome::PrivateDelivered { message }
    );
}

#[test]
fn response_reasons_are_bounded_before_reaching_ui() {
    let local = PeerId::random();
    let owner = PeerId::random();
    let mut client = SecureControlClient::default();
    client.observe_room(protected_room(owner, 3));
    let request = room_request("friends", "secret room");
    let ControlRequest::RoomJoin { request_id, .. } = &request else {
        unreachable!()
    };
    let request_id = request_id.clone();
    client.track_room_join(&request, owner, 3).unwrap();
    assert_eq!(
        client.handle_response(
            &owner,
            ControlResponse::RoomJoin {
                request_id,
                granted: false,
                reason: Some("x".repeat(16_000)),
            },
        ),
        SecureResponseOutcome::RoomJoinRejected {
            room_id: "friends".into(),
            reason: "access_denied".into(),
        }
    );
    assert!(client.room_requires_authorization("friends", &local));
}
