#[path = "../src/room_password_state.rs"]
mod room_password_state;
#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/secure_control_runtime.rs"]
mod secure_control_runtime;
#[path = "../src/secure_control_transport.rs"]
mod secure_control_transport;

use std::time::Instant;

use futures::io::Cursor;
use libp2p::{request_response::Codec, PeerId, StreamProtocol};
use secure_channels::{
    ControlRequest, ControlResponse, PrivateDirectMessage, SecretString, CONTROL_PROTOCOL,
    MAX_CONTROL_REQUEST_WIRE_BYTES, MAX_CONTROL_RESPONSE_WIRE_BYTES,
};
use secure_control_runtime::{PresenceIdentity, SecureControlRuntime};
use secure_control_transport::{
    control_behaviour, control_codec, handle_inbound_control_request, private_message_request,
    room_join_request,
};
use uuid::Uuid;

fn peer() -> PeerId {
    PeerId::random()
}

#[test]
fn protected_room_join_handler_returns_peer_bound_grant_without_secret_echo() {
    let owner = peer();
    let guest = peer();
    let local = owner;
    let now_ms = 1_000_000u64;
    let now = Instant::now();
    let mut runtime = SecureControlRuntime::default();
    runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .unwrap();

    let request = room_join_request("friends", "secret room".into()).unwrap();
    let debug = format!("{request:?}");
    assert!(!debug.contains("secret room"));
    let outcome = handle_inbound_control_request(
        &mut runtime,
        request,
        &guest,
        &local,
        None,
        now_ms,
        now,
    );
    assert!(matches!(
        outcome.response,
        ControlResponse::RoomJoin {
            granted: true,
            reason: None,
            ..
        }
    ));
    let grant = outcome.room_grant.expect("locked room must issue a grant");
    assert_eq!(grant.grantee_peer_id, guest.to_string());
    assert_eq!(grant.owner_peer_id, owner.to_string());
    assert_eq!(grant.room_id, "friends");
    assert!(runtime.room_authorized("friends", &guest, now_ms));
}

#[test]
fn wrong_password_and_malformed_requests_fail_closed_with_bounded_reasons() {
    let owner = peer();
    let guest = peer();
    let mut runtime = SecureControlRuntime::default();
    runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .unwrap();

    let wrong = room_join_request("friends", "wrong pass".into()).unwrap();
    let denied = handle_inbound_control_request(
        &mut runtime,
        wrong,
        &guest,
        &owner,
        None,
        2_000_000,
        Instant::now(),
    );
    match denied.response {
        ControlResponse::RoomJoin {
            granted,
            reason,
            ..
        } => {
            assert!(!granted);
            assert_eq!(reason.as_deref(), Some("access_denied"));
        }
        _ => panic!("wrong response kind"),
    }
    assert!(!format!("{denied:?}").contains("wrong pass"));
    assert!(!runtime.room_authorized("friends", &guest, 2_000_000));

    let malformed = ControlRequest::RoomJoin {
        request_id: "not-a-uuid".into(),
        room_id: "friends".into(),
        password: SecretString::new("secret room".into()),
    };
    let malformed = handle_inbound_control_request(
        &mut runtime,
        malformed,
        &guest,
        &owner,
        None,
        2_000_000,
        Instant::now(),
    );
    assert!(matches!(
        malformed.response,
        ControlResponse::RoomJoin {
            granted: false,
            reason: Some(ref reason),
            ..
        } if reason == "invalid_request"
    ));
}

#[test]
fn private_handler_emits_only_authenticated_targeted_messages_and_rejects_replay() {
    let sender = peer();
    let receiver = peer();
    let attacker = peer();
    let now_ms = 3_000_000u64;
    let now = Instant::now();
    let presence = PresenceIdentity {
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
    };
    let mut runtime = SecureControlRuntime::default();

    let request = private_message_request(
        &sender,
        &receiver,
        "Alice",
        Some("#62E5FF".into()),
        "private hello :)",
        now_ms,
    )
    .unwrap();
    let ControlRequest::PrivateMessage(message) = request else {
        panic!("private request expected")
    };
    let message_id = message.id.clone();
    let accepted = handle_inbound_control_request(
        &mut runtime,
        ControlRequest::PrivateMessage(message.clone()),
        &sender,
        &receiver,
        Some(&presence),
        now_ms,
        now,
    );
    assert!(matches!(
        accepted.response,
        ControlResponse::PrivateAck {
            accepted: true,
            reason: None,
            ..
        }
    ));
    assert_eq!(accepted.private_message.as_ref().unwrap().id, message_id);
    assert!(accepted.room_grant.is_none());

    let replay = handle_inbound_control_request(
        &mut runtime,
        ControlRequest::PrivateMessage(message.clone()),
        &sender,
        &receiver,
        Some(&presence),
        now_ms,
        now,
    );
    assert!(matches!(
        replay.response,
        ControlResponse::PrivateAck {
            accepted: false,
            reason: Some(ref reason),
            ..
        } if reason == "replay_rejected"
    ));
    assert!(replay.private_message.is_none());

    let mut spoofed = message;
    spoofed.id = Uuid::new_v4().to_string();
    let spoofed = handle_inbound_control_request(
        &mut runtime,
        ControlRequest::PrivateMessage(spoofed),
        &attacker,
        &receiver,
        Some(&presence),
        now_ms,
        now,
    );
    assert!(matches!(
        spoofed.response,
        ControlResponse::PrivateAck {
            accepted: false,
            reason: Some(ref reason),
            ..
        } if reason == "private_rejected"
    ));
    assert!(spoofed.private_message.is_none());
}

#[test]
fn outbound_private_builder_rejects_self_empty_and_oversize_targets() {
    let local = peer();
    let remote = peer();
    assert!(private_message_request(&local, &local, "Alice", None, "hello", 1).is_err());
    assert!(private_message_request(&local, &remote, "Alice", None, "   ", 1).is_err());
    assert!(
        private_message_request(&local, &remote, "Alice", None, &"x".repeat(4001), 1).is_err()
    );
    assert!(private_message_request(&local, &remote, "Alice", None, "hello", 1).is_ok());
}

#[tokio::test]
async fn control_codec_rejects_oversized_request_and_response_frames() {
    let protocol = StreamProtocol::new(CONTROL_PROTOCOL);
    let mut request_codec = control_codec();
    let mut encoded_request = Cursor::new(Vec::new());
    request_codec
        .write_request(
            &protocol,
            &mut encoded_request,
            ControlRequest::RoomJoin {
                request_id: Uuid::new_v4().to_string(),
                room_id: "friends".into(),
                password: SecretString::new(
                    "x".repeat(MAX_CONTROL_REQUEST_WIRE_BYTES as usize + 1),
                ),
            },
        )
        .await
        .unwrap();
    assert!(encoded_request.get_ref().len() as u64 > MAX_CONTROL_REQUEST_WIRE_BYTES);
    encoded_request.set_position(0);
    assert!(request_codec
        .read_request(&protocol, &mut encoded_request)
        .await
        .is_err());

    let mut response_codec = control_codec();
    let mut encoded_response = Cursor::new(Vec::new());
    response_codec
        .write_response(
            &protocol,
            &mut encoded_response,
            ControlResponse::PrivateAck {
                message_id: Uuid::new_v4().to_string(),
                accepted: false,
                reason: Some("x".repeat(MAX_CONTROL_RESPONSE_WIRE_BYTES as usize + 1)),
            },
        )
        .await
        .unwrap();
    assert!(encoded_response.get_ref().len() as u64 > MAX_CONTROL_RESPONSE_WIRE_BYTES);
    encoded_response.set_position(0);
    assert!(response_codec
        .read_response(&protocol, &mut encoded_response)
        .await
        .is_err());
}

#[test]
fn dedicated_control_behaviour_can_be_constructed_without_gossipsub_fallback() {
    let _behaviour = control_behaviour();
    assert_eq!(CONTROL_PROTOCOL, "/konofix/control/1.0.0");
}

#[test]
fn malformed_private_id_never_echoes_unbounded_attacker_input() {
    let sender = peer();
    let receiver = peer();
    let mut runtime = SecureControlRuntime::default();
    let message = PrivateDirectMessage {
        id: "A".repeat(16_000),
        peer_id: sender.to_string(),
        target_peer_id: receiver.to_string(),
        nick: "Alice".into(),
        nick_color: None,
        text: "hello".into(),
        timestamp: 4_000_000,
    };
    let outcome = handle_inbound_control_request(
        &mut runtime,
        ControlRequest::PrivateMessage(message),
        &sender,
        &receiver,
        None,
        4_000_000,
        Instant::now(),
    );
    match outcome.response {
        ControlResponse::PrivateAck {
            message_id,
            accepted,
            reason,
        } => {
            assert_eq!(message_id, Uuid::nil().to_string());
            assert!(!accepted);
            assert_eq!(reason.as_deref(), Some("private_rejected"));
        }
        _ => panic!("private ack expected"),
    }
}
