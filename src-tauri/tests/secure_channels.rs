#[path = "../src/secure_channels.rs"]
mod secure_channels;

use std::time::{Duration, Instant};

use libp2p::PeerId;
use secure_channels::{
    validate_private_message, validate_room_password, ControlRequest, PrivateDirectMessage,
    ReplayCache, RoomAccessGrant, SecretString, WindowRateLimiter, PRIVATE_MESSAGE_MAX_AGE_MS,
    PRIVATE_RATE_MAX_MESSAGES, PRIVATE_RATE_WINDOW_SECS, ROOM_ACCESS_GRANT_TTL_SECS,
    ROOM_AUTH_MAX_ATTEMPTS, ROOM_AUTH_WINDOW_SECS,
};
use uuid::Uuid;

fn peer() -> PeerId {
    PeerId::random()
}

#[test]
fn room_password_validation_is_bounded_and_plaintext_debug_is_redacted() {
    assert_eq!(validate_room_password(None).unwrap(), None);
    assert_eq!(validate_room_password(Some("")).unwrap(), None);
    assert!(validate_room_password(Some("short")).is_err());
    assert!(validate_room_password(Some("correct horse")).is_ok());
    assert!(validate_room_password(Some(&"x".repeat(65))).is_err());
    assert!(validate_room_password(Some("secret\nline")).is_err());

    let request = ControlRequest::RoomJoin {
        request_id: Uuid::new_v4().to_string(),
        room_id: "friends".into(),
        password: SecretString::new("correct horse".into()),
    };
    let debug = format!("{request:?}");
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains("correct horse"));
}

#[test]
fn access_grants_bind_room_owner_grantee_revision_and_expiry() {
    let owner = peer();
    let grantee = peer();
    let stranger = peer();
    let now = 10_000u64;
    let grant = RoomAccessGrant {
        room_id: "friends".into(),
        owner_peer_id: owner.to_string(),
        grantee_peer_id: grantee.to_string(),
        revision: 7,
        expires_at: now + ROOM_ACCESS_GRANT_TTL_SECS * 1_000,
    };

    assert!(grant.is_valid_for("friends", &owner, &grantee, 7, now));
    assert!(!grant.is_valid_for("other", &owner, &grantee, 7, now));
    assert!(!grant.is_valid_for("friends", &owner, &stranger, 7, now));
    assert!(!grant.is_valid_for("friends", &owner, &grantee, 8, now));
    assert!(!grant.is_valid_for(
        "friends",
        &owner,
        &grantee,
        7,
        grant.expires_at
    ));

    let far_future = RoomAccessGrant {
        expires_at: now + (ROOM_ACCESS_GRANT_TTL_SECS + 1) * 1_000,
        ..grant
    };
    assert!(!far_future.is_valid_for("friends", &owner, &grantee, 7, now));
}

#[test]
fn room_auth_rate_limit_resets_only_after_window() {
    let now = Instant::now();
    let mut limiter = WindowRateLimiter::default();
    let window = Duration::from_secs(ROOM_AUTH_WINDOW_SECS);
    for _ in 0..ROOM_AUTH_MAX_ATTEMPTS {
        assert!(limiter.allow("peer-a/friends", now, ROOM_AUTH_MAX_ATTEMPTS, window));
    }
    assert!(!limiter.allow("peer-a/friends", now, ROOM_AUTH_MAX_ATTEMPTS, window));
    assert!(limiter.allow(
        "peer-a/friends",
        now + window,
        ROOM_AUTH_MAX_ATTEMPTS,
        window
    ));
}

#[test]
fn private_message_requires_authenticated_sender_current_target_and_presence() {
    let sender = peer();
    let local = peer();
    let attacker = peer();
    let now = 1_000_000u64;
    let message = PrivateDirectMessage {
        id: Uuid::new_v4().to_string(),
        peer_id: sender.to_string(),
        target_peer_id: local.to_string(),
        nick: "alice".into(),
        nick_color: Some("#62E5FF".into()),
        text: "hello privately :)".into(),
        timestamp: now,
    };

    assert!(validate_private_message(
        &message,
        &sender,
        &local,
        Some("alice"),
        Some("#62E5FF"),
        now
    )
    .is_ok());
    assert!(validate_private_message(
        &message,
        &attacker,
        &local,
        Some("alice"),
        Some("#62E5FF"),
        now
    )
    .is_err());
    assert!(validate_private_message(
        &message,
        &sender,
        &attacker,
        Some("alice"),
        Some("#62E5FF"),
        now
    )
    .is_err());
    assert!(validate_private_message(
        &message,
        &sender,
        &local,
        Some("mallory"),
        Some("#62E5FF"),
        now
    )
    .is_err());

    let mut stale = message.clone();
    stale.timestamp = now - PRIVATE_MESSAGE_MAX_AGE_MS - 1;
    assert!(validate_private_message(
        &stale,
        &sender,
        &local,
        Some("alice"),
        Some("#62E5FF"),
        now
    )
    .is_err());

    let mut oversized = message;
    oversized.text = "x".repeat(4_001);
    assert!(validate_private_message(
        &oversized,
        &sender,
        &local,
        Some("alice"),
        Some("#62E5FF"),
        now
    )
    .is_err());
}

#[test]
fn private_rate_and_replay_guards_are_bounded() {
    let now = Instant::now();
    let mut limiter = WindowRateLimiter::default();
    let window = Duration::from_secs(PRIVATE_RATE_WINDOW_SECS);
    for _ in 0..PRIVATE_RATE_MAX_MESSAGES {
        assert!(limiter.allow("peer-a", now, PRIVATE_RATE_MAX_MESSAGES, window));
    }
    assert!(!limiter.allow("peer-a", now, PRIVATE_RATE_MAX_MESSAGES, window));

    let mut replay = ReplayCache::new(2);
    let ttl = Duration::from_secs(60);
    assert!(replay.accept("message-a", now, ttl));
    assert!(!replay.accept("message-a", now + Duration::from_secs(1), ttl));
    assert!(replay.accept("message-b", now + Duration::from_secs(1), ttl));
    assert!(replay.accept("message-c", now + Duration::from_secs(2), ttl));
    assert!(replay.accept("message-a", now + Duration::from_secs(3), ttl));
    assert!(replay.accept("message-z", now + ttl, ttl));
}
