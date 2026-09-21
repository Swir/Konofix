use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use libp2p::PeerId;

use crate::{
    room_password_state::{ProtectedRoomState, RoomAuthError, RoomLockMetadata},
    secure_channels::{
        validate_private_message, PrivateDirectMessage, ReplayCache, RoomAccessGrant,
        WindowRateLimiter, PRIVATE_RATE_MAX_MESSAGES, PRIVATE_RATE_WINDOW_SECS,
        PRIVATE_REPLAY_MAX_ENTRIES, PRIVATE_REPLAY_TTL_SECS,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceIdentity {
    pub nick: String,
    pub nick_color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrivateMessageError {
    Validation(&'static str),
    RateLimited,
    Replay,
}

#[derive(Debug)]
pub struct SecureControlRuntime {
    protected_rooms: HashMap<String, ProtectedRoomState>,
    private_rate: WindowRateLimiter,
    private_replay: ReplayCache,
}

impl Default for SecureControlRuntime {
    fn default() -> Self {
        Self {
            protected_rooms: HashMap::new(),
            private_rate: WindowRateLimiter::default(),
            private_replay: ReplayCache::new(PRIVATE_REPLAY_MAX_ENTRIES),
        }
    }
}

impl SecureControlRuntime {
    pub fn create_room(
        &mut self,
        room_id: String,
        owner: PeerId,
        password: Option<&str>,
    ) -> Result<RoomLockMetadata, RoomAuthError> {
        if self.protected_rooms.contains_key(&room_id) {
            return Err(RoomAuthError::InvalidConfiguration(
                "Room security state already exists.".into(),
            ));
        }
        let room = ProtectedRoomState::new(room_id.clone(), owner, password)?;
        let metadata = room.metadata();
        self.protected_rooms.insert(room_id, room);
        Ok(metadata)
    }

    pub fn remove_room(&mut self, room_id: &str) {
        self.protected_rooms.remove(room_id);
    }

    pub fn room_metadata(&self, room_id: &str) -> Option<RoomLockMetadata> {
        self.protected_rooms
            .get(room_id)
            .map(ProtectedRoomState::metadata)
    }

    pub fn update_room_password(
        &mut self,
        room_id: &str,
        requester: &PeerId,
        password: Option<&str>,
    ) -> Result<RoomLockMetadata, RoomAuthError> {
        let room = self
            .protected_rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomAuthError::InvalidConfiguration("Unknown protected room.".into()))?;
        room.update_password(requester, password)?;
        Ok(room.metadata())
    }

    pub fn authorize_room_join(
        &mut self,
        room_id: &str,
        requester: &PeerId,
        password: Option<&str>,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Result<Option<RoomAccessGrant>, RoomAuthError> {
        let room = self
            .protected_rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomAuthError::InvalidConfiguration("Unknown protected room.".into()))?;
        room.authorize_join(requester, password, now_ms, monotonic_now)
    }

    pub fn room_authorized(&self, room_id: &str, peer: &PeerId, now_ms: u64) -> bool {
        self.protected_rooms
            .get(room_id)
            .is_some_and(|room| room.is_authorized(peer, now_ms))
    }

    pub fn accept_private_message(
        &mut self,
        message: PrivateDirectMessage,
        authenticated_source: &PeerId,
        local_peer: &PeerId,
        expected_presence: Option<&PresenceIdentity>,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Result<PrivateDirectMessage, PrivateMessageError> {
        validate_private_message(
            &message,
            authenticated_source,
            local_peer,
            expected_presence.map(|presence| presence.nick.as_str()),
            expected_presence.and_then(|presence| presence.nick_color.as_deref()),
            now_ms,
        )
        .map_err(PrivateMessageError::Validation)?;

        if !self.private_rate.allow(
            authenticated_source.to_string(),
            monotonic_now,
            PRIVATE_RATE_MAX_MESSAGES,
            Duration::from_secs(PRIVATE_RATE_WINDOW_SECS),
        ) {
            return Err(PrivateMessageError::RateLimited);
        }

        if !self.private_replay.accept(
            &message.id,
            monotonic_now,
            Duration::from_secs(PRIVATE_REPLAY_TTL_SECS),
        ) {
            return Err(PrivateMessageError::Replay);
        }

        Ok(message)
    }

    pub fn prune(&mut self, now_ms: u64, monotonic_now: Instant) {
        for room in self.protected_rooms.values_mut() {
            room.prune(now_ms, monotonic_now);
        }
        self.private_rate.prune(
            monotonic_now,
            Duration::from_secs(PRIVATE_RATE_WINDOW_SECS.saturating_mul(2)),
        );
    }
}
