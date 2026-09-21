#[path = "../src/secure_channels.rs"]
mod secure_channels;
#[path = "../src/room_password_state.rs"]
mod room_password_state;

use std::time::{Duration, Instant};

use libp2p::PeerId;
use room_password_state::{ProtectedRoomState, RoomAuthError};
use secure_channels::{ROOM_AUTH_MAX_ATTEMPTS, ROOM_AUTH_WINDOW_SECS};

fn peer() -> PeerId {
    PeerId::random()
}

#[test]
fn protected_room_requires_correct_password_before_membership() {
    let owner = peer();
    let guest = peer();
    let now = Instant::now();
    let mut room = ProtectedRoomState::new("friends".into(), owner, Some("secret room")).unwrap();

    assert!(room.metadata().password_protected);
    assert!(!room.is_authorized(&guest, 1_000));
    assert_eq!(
        room.authorize_join(&guest, None, 1_000, now),
        Err(RoomAuthError::PasswordRequired)
    );
    assert_eq!(
        room.authorize_join(&guest, Some("wrong pass"), 1_000, now),
        Err(RoomAuthError::InvalidPassword)
    );
    let grant = room
        .authorize_join(&guest, Some("secret room"), 1_000, now)
        .unwrap()
        .expect("protected room should issue a grant");
    assert_eq!(grant.revision, room.metadata().auth_revision);
    assert!(room.is_authorized(&guest, 1_000));
}

#[test]
fn only_owner_can_change_password_and_change_revokes_stale_grants() {
    let owner = peer();
    let guest = peer();
    let attacker = peer();
    let now = Instant::now();
    let mut room = ProtectedRoomState::new("friends".into(), owner, Some("secret room")).unwrap();
    let old_revision = room.metadata().auth_revision;
    let old_grant = room
        .authorize_join(&guest, Some("secret room"), 10_000, now)
        .unwrap()
        .unwrap();

    assert_eq!(
        room.update_password(&attacker, Some("other secret")),
        Err(RoomAuthError::NotOwner)
    );
    assert_eq!(room.metadata().auth_revision, old_revision);
    assert!(room.is_authorized(&guest, 10_000));

    assert_eq!(room.update_password(&owner, Some("other secret")), Ok(true));
    assert_eq!(room.metadata().auth_revision, old_revision + 1);
    assert!(!room.is_authorized(&guest, 10_000));
    assert!(!room.accept_grant(old_grant, 10_000));
    assert_eq!(
        room.authorize_join(&guest, Some("secret room"), 10_000, now),
        Err(RoomAuthError::InvalidPassword)
    );
    assert!(room
        .authorize_join(&guest, Some("other secret"), 10_000, now)
        .unwrap()
        .is_some());
}

#[test]
fn removing_password_opens_room_and_invalidates_prior_revision() {
    let owner = peer();
    let guest = peer();
    let now = Instant::now();
    let mut room = ProtectedRoomState::new("friends".into(), owner, Some("secret room")).unwrap();
    let prior_revision = room.metadata().auth_revision;
    room.authorize_join(&guest, Some("secret room"), 50_000, now)
        .unwrap();

    assert_eq!(room.update_password(&owner, None), Ok(true));
    assert!(!room.metadata().password_protected);
    assert_eq!(room.metadata().auth_revision, prior_revision + 1);
    assert!(room.is_authorized(&guest, 50_000));
    assert_eq!(room.authorize_join(&guest, None, 50_000, now), Ok(None));
    assert_eq!(room.update_password(&owner, None), Ok(false));
}

#[test]
fn wrong_password_attempts_are_bounded_per_peer_and_room() {
    let owner = peer();
    let guest = peer();
    let now = Instant::now();
    let mut room = ProtectedRoomState::new("friends".into(), owner, Some("secret room")).unwrap();

    for _ in 0..ROOM_AUTH_MAX_ATTEMPTS {
        assert_eq!(
            room.authorize_join(&guest, Some("wrong pass"), 1_000, now),
            Err(RoomAuthError::InvalidPassword)
        );
    }
    assert_eq!(
        room.authorize_join(&guest, Some("secret room"), 1_000, now),
        Err(RoomAuthError::RateLimited)
    );
    assert!(room
        .authorize_join(
            &guest,
            Some("secret room"),
            1_000,
            now + Duration::from_secs(ROOM_AUTH_WINDOW_SECS),
        )
        .unwrap()
        .is_some());
}

#[test]
fn grants_expire_and_revoke_without_touching_other_peers() {
    let owner = peer();
    let alice = peer();
    let bob = peer();
    let now = Instant::now();
    let mut room = ProtectedRoomState::new("friends".into(), owner, Some("secret room")).unwrap();
    room.authorize_join(&alice, Some("secret room"), 1_000, now)
        .unwrap();
    room.authorize_join(&bob, Some("secret room"), 1_000, now)
        .unwrap();
    assert!(room.is_authorized(&alice, 1_000));
    assert!(room.is_authorized(&bob, 1_000));

    room.revoke_peer(&alice);
    assert!(!room.is_authorized(&alice, 1_000));
    assert!(room.is_authorized(&bob, 1_000));

    room.prune(u64::MAX / 2, now + Duration::from_secs(ROOM_AUTH_WINDOW_SECS * 3));
    assert!(!room.is_authorized(&bob, u64::MAX / 2));
}
