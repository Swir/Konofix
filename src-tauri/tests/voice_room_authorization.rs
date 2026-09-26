#[path = "../src/room_password_state.rs"]
mod room_password_state;
#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/secure_control_runtime.rs"]
mod secure_control_runtime;

use std::time::Instant;

use libp2p::PeerId;
use secure_channels::{VoiceRoomIntent, VoiceScope, VoiceSignal, VoiceSignalAction};
use secure_control_runtime::{PresenceIdentity, SecureControlRuntime, VoiceSignalError};
use uuid::Uuid;

fn peer() -> PeerId {
    PeerId::random()
}

fn room_invite(sender: &PeerId, target: &PeerId, room_id: &str, now_ms: u64) -> VoiceSignal {
    VoiceSignal {
        id: Uuid::new_v4().to_string(),
        session_id: Uuid::new_v4().to_string(),
        peer_id: sender.to_string(),
        target_peer_id: target.to_string(),
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
        scope: VoiceScope::Room {
            room_id: room_id.into(),
        },
        action: VoiceSignalAction::Invite,
        sdp: None,
        candidate: None,
        room_intent: Some(VoiceRoomIntent::Listen),
        muted: None,
        timestamp: now_ms,
    }
}

#[test]
fn protected_room_voice_requires_current_sender_authorization_at_owner() {
    let owner = peer();
    let guest = peer();
    let now_ms = 9_000_000u64;
    let now = Instant::now();
    let presence = PresenceIdentity {
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
    };
    let mut runtime = SecureControlRuntime::default();

    runtime
        .create_room("friends".into(), owner, Some("secret room"))
        .expect("create protected room");

    assert_eq!(
        runtime.accept_voice_signal(
            room_invite(&guest, &owner, "friends", now_ms),
            &guest,
            &owner,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(VoiceSignalError::Validation(
            "Voice sender is not authorized for this protected room."
        ))
    );

    runtime
        .authorize_room_join("friends", &guest, Some("secret room"), now_ms, now)
        .expect("authorize protected-room guest");

    let accepted = room_invite(&guest, &owner, "friends", now_ms);
    assert_eq!(
        runtime
            .accept_voice_signal(
                accepted.clone(),
                &guest,
                &owner,
                Some(&presence),
                now_ms,
                now,
            )
            .expect("authorized room voice"),
        accepted
    );

    runtime
        .update_room_password("friends", &owner, Some("rotated secret"))
        .expect("rotate room password");

    assert_eq!(
        runtime.accept_voice_signal(
            room_invite(&guest, &owner, "friends", now_ms),
            &guest,
            &owner,
            Some(&presence),
            now_ms,
            now,
        ),
        Err(VoiceSignalError::Validation(
            "Voice sender is not authorized for this protected room."
        ))
    );
}

#[test]
fn unprotected_owned_room_does_not_require_a_password_grant_for_voice() {
    let owner = peer();
    let guest = peer();
    let now_ms = 10_000_000u64;
    let now = Instant::now();
    let presence = PresenceIdentity {
        nick: "Alice".into(),
        nick_color: Some("#62E5FF".into()),
    };
    let mut runtime = SecureControlRuntime::default();

    runtime
        .create_room("open-room".into(), owner, None)
        .expect("create open room");

    let signal = room_invite(&guest, &owner, "open-room", now_ms);
    assert_eq!(
        runtime
            .accept_voice_signal(signal.clone(), &guest, &owner, Some(&presence), now_ms, now,)
            .expect("open-room voice"),
        signal
    );
}
