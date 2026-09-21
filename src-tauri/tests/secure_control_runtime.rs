#[path = "../src/room_password_state.rs"]
mod room_password_state;
#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/secure_control_runtime.rs"]
mod secure_control_runtime;

use std::time::Instant;

use libp2p::PeerId;
use secure_channels::{PrivateDirectMessage, PRIVATE_RATE_MAX_MESSAGES};
use secure_control_runtime::{PresenceIdentity, PrivateMessageError, SecureControlRuntime};
use uuid::Uuid;

fn peer() -> PeerId {
    PeerId::random()
}

fn private_message(
    sender: &PeerId,
    target: &PeerId,
    id: String,
    now_ms: u64,
) -> PrivateDirectMessage {
    PrivateDirectMessage {
        id,
        peer_id: sender.to_string(),
        target_peer_id: target.to_string(),
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
        text: "private hello :)".into(),
        timestamp: now_ms,
    }
}

#[test]
fn protected_room_runtime_keeps_password_checks_before_admission() {
    let owner = peer();
    let guest = peer();
    let now = Instant::now();
    let mut runtime = SecureControlRuntime::default();
    let metadata = runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .unwrap();
    assert!(metadata.password_protected);
    assert!(!runtime.room_authorized("friends", &guest, 1_000));
    assert!(runtime
        .authorize_room_join("friends", &guest, Some("wrong pass"), 1_000, now)
        .is_err());
    assert!(runtime
        .authorize_room_join("friends", &guest, Some("secret room"), 1_000, now)
        .unwrap()
        .is_some());
    assert!(runtime.room_authorized("friends", &guest, 1_000));
}

#[test]
fn password_rotation_is_owner_only_and_revokes_old_authorization() {
    let owner = peer();
    let guest = peer();
    let attacker = peer();
    let now = Instant::now();
    let mut runtime = SecureControlRuntime::default();
    runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .unwrap();
    runtime
        .authorize_room_join("friends", &guest, Some("secret room"), 1_000, now)
        .unwrap();
    assert!(runtime.room_authorized("friends", &guest, 1_000));
    assert!(runtime
        .update_room_password("friends", &attacker, Some("other secret"))
        .is_err());
    let metadata = runtime
        .update_room_password("friends", &owner, Some("other secret"))
        .unwrap();
    assert!(metadata.password_protected);
    assert!(!runtime.room_authorized("friends", &guest, 1_000));
}

#[test]
fn private_runtime_binds_authenticated_peer_presence_target_replay_and_rate() {
    let sender = peer();
    let local = peer();
    let attacker = peer();
    let now_ms = 2_000_000u64;
    let now = Instant::now();
    let presence = PresenceIdentity {
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
    };
    let mut runtime = SecureControlRuntime::default();

    let message = private_message(&sender, &local, Uuid::new_v4().to_string(), now_ms);
    assert_eq!(
        runtime
            .accept_private_message(
                message.clone(),
                &sender,
                &local,
                Some(&presence),
                now_ms,
                now,
            )
            .unwrap(),
        message
    );
    assert_eq!(
        runtime.accept_private_message(
            message.clone(),
            &sender,
            &local,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(PrivateMessageError::Replay)
    );

    let spoofed = private_message(&sender, &local, Uuid::new_v4().to_string(), now_ms);
    assert!(matches!(
        runtime.accept_private_message(spoofed, &attacker, &local, Some(&presence), now_ms, now,),
        Err(PrivateMessageError::Validation(_))
    ));

    for _ in 1..PRIVATE_RATE_MAX_MESSAGES {
        runtime
            .accept_private_message(
                private_message(&sender, &local, Uuid::new_v4().to_string(), now_ms),
                &sender,
                &local,
                Some(&presence),
                now_ms,
                now,
            )
            .unwrap();
    }
    assert_eq!(
        runtime.accept_private_message(
            private_message(&sender, &local, Uuid::new_v4().to_string(), now_ms),
            &sender,
            &local,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(PrivateMessageError::RateLimited)
    );
}

#[test]
fn removing_room_security_state_fails_closed_for_late_join_requests() {
    let owner = peer();
    let guest = peer();
    let mut runtime = SecureControlRuntime::default();
    runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .unwrap();
    runtime.remove_room("friends");
    assert!(runtime.room_metadata("friends").is_none());
    assert!(runtime
        .authorize_room_join(
            "friends",
            &guest,
            Some("secret room"),
            1_000,
            Instant::now(),
        )
        .is_err());
}
