#[path = "../src/room_password_state.rs"]
mod room_password_state;
#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/secure_control_runtime.rs"]
mod secure_control_runtime;

use std::time::Instant;

use libp2p::PeerId;
use secure_channels::{
    PrivateDirectMessage, VoiceScope, VoiceSignal, VoiceSignalAction, PRIVATE_RATE_MAX_MESSAGES,
    VOICE_INVITE_RATE_MAX,
};
use secure_control_runtime::{
    PresenceIdentity, PrivateMessageError, SecureControlRuntime, VoiceSignalError,
};
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

    // A structurally valid replay is deliberately charged to the authenticated
    // sender's rate window before replay rejection. This prevents replay spam
    // from bypassing the per-peer rate limiter. The first accepted message and
    // the replay therefore consume two slots; validation failures from another
    // peer do not consume the sender's allowance.
    for _ in 2..PRIVATE_RATE_MAX_MESSAGES {
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
fn private_runtime_rejects_peer_without_authenticated_presence() {
    let sender = peer();
    let local = peer();
    let now_ms = 2_500_000u64;
    let mut runtime = SecureControlRuntime::default();
    let message = private_message(&sender, &local, Uuid::new_v4().to_string(), now_ms);

    assert_eq!(
        runtime.accept_private_message(message, &sender, &local, None, now_ms, Instant::now(),),
        Err(PrivateMessageError::Validation(
            "Private sender has no authenticated presence."
        ))
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

fn voice_invite(
    sender: &PeerId,
    target: &PeerId,
    id: String,
    session_id: String,
    now_ms: u64,
) -> VoiceSignal {
    VoiceSignal {
        id,
        session_id,
        peer_id: sender.to_string(),
        target_peer_id: target.to_string(),
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
        scope: VoiceScope::Private,
        action: VoiceSignalAction::Invite,
        sdp: None,
        candidate: None,
        room_intent: None,
        muted: None,
        timestamp: now_ms,
    }
}

#[test]
fn voice_runtime_rejects_replay_spoofing_and_invite_spam() {
    let sender = peer();
    let local = peer();
    let attacker = peer();
    let now_ms = 6_000_000u64;
    let now = Instant::now();
    let presence = PresenceIdentity {
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
    };
    let mut runtime = SecureControlRuntime::default();
    let first = voice_invite(
        &sender,
        &local,
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
        now_ms,
    );

    assert_eq!(
        runtime
            .accept_voice_signal(
                first.clone(),
                &sender,
                &local,
                Some(&presence),
                now_ms,
                now,
            )
            .unwrap(),
        first
    );
    assert_eq!(
        runtime.accept_voice_signal(
            first.clone(),
            &sender,
            &local,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(VoiceSignalError::Replay)
    );

    let spoofed = voice_invite(
        &sender,
        &local,
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
        now_ms,
    );
    assert!(matches!(
        runtime.accept_voice_signal(
            spoofed,
            &attacker,
            &local,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(VoiceSignalError::Validation(_))
    ));

    // The accepted invite and its replay both consume the general signal budget,
    // but only valid invite actions consume the dedicated invite-spam window.
    for _ in 2..VOICE_INVITE_RATE_MAX {
        runtime
            .accept_voice_signal(
                voice_invite(
                    &sender,
                    &local,
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    now_ms,
                ),
                &sender,
                &local,
                Some(&presence),
                now_ms,
                now,
            )
            .unwrap();
    }
    assert_eq!(
        runtime.accept_voice_signal(
            voice_invite(
                &sender,
                &local,
                Uuid::new_v4().to_string(),
                Uuid::new_v4().to_string(),
                now_ms,
            ),
            &sender,
            &local,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(VoiceSignalError::InviteRateLimited)
    );
}

#[test]
fn voice_runtime_requires_authenticated_presence() {
    let sender = peer();
    let local = peer();
    let signal = voice_invite(
        &sender,
        &local,
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
        7_000_000,
    );
    let mut runtime = SecureControlRuntime::default();
    assert_eq!(
        runtime.accept_voice_signal(
            signal,
            &sender,
            &local,
            None,
            7_000_000,
            Instant::now(),
        ),
        Err(VoiceSignalError::Validation(
            "Voice sender has no authenticated presence."
        ))
    );
}
