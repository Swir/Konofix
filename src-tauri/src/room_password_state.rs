use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use libp2p::PeerId;

use crate::secure_channels::{
    validate_room_password, RoomAccessGrant, RoomPasswordVerifier, WindowRateLimiter,
    ROOM_ACCESS_GRANT_TTL_SECS, ROOM_AUTH_MAX_ATTEMPTS, ROOM_AUTH_WINDOW_SECS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomLockMetadata {
    pub password_protected: bool,
    pub auth_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomAuthError {
    NotOwner,
    PasswordRequired,
    InvalidPassword,
    RateLimited,
    InvalidConfiguration(String),
}

#[derive(Debug)]
pub struct ProtectedRoomState {
    room_id: String,
    owner: PeerId,
    revision: u64,
    verifier: Option<RoomPasswordVerifier>,
    grants: HashMap<PeerId, RoomAccessGrant>,
    attempts: WindowRateLimiter,
}

impl ProtectedRoomState {
    pub fn new(
        room_id: String,
        owner: PeerId,
        password: Option<&str>,
    ) -> Result<Self, RoomAuthError> {
        let validated =
            validate_room_password(password).map_err(RoomAuthError::InvalidConfiguration)?;
        let revision = 1;
        let verifier = match validated {
            Some(password) => Some(
                RoomPasswordVerifier::new(&password, revision)
                    .map_err(RoomAuthError::InvalidConfiguration)?,
            ),
            None => None,
        };
        Ok(Self {
            room_id,
            owner,
            revision,
            verifier,
            grants: HashMap::new(),
            attempts: WindowRateLimiter::default(),
        })
    }

    pub fn metadata(&self) -> RoomLockMetadata {
        RoomLockMetadata {
            password_protected: self.verifier.is_some(),
            auth_revision: self.revision,
        }
    }

    pub fn update_password(
        &mut self,
        requester: &PeerId,
        password: Option<&str>,
    ) -> Result<bool, RoomAuthError> {
        if requester != &self.owner {
            return Err(RoomAuthError::NotOwner);
        }
        let validated =
            validate_room_password(password).map_err(RoomAuthError::InvalidConfiguration)?;
        if validated.is_none() && self.verifier.is_none() {
            return Ok(false);
        }

        let next_revision = self.revision.checked_add(1).ok_or_else(|| {
            RoomAuthError::InvalidConfiguration("Room auth revision exhausted.".into())
        })?;
        let next_verifier = match validated {
            Some(password) => Some(
                RoomPasswordVerifier::new(&password, next_revision)
                    .map_err(RoomAuthError::InvalidConfiguration)?,
            ),
            None => None,
        };

        self.revision = next_revision;
        self.verifier = next_verifier;
        self.grants.clear();
        Ok(true)
    }

    pub fn authorize_join(
        &mut self,
        peer: &PeerId,
        password: Option<&str>,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Result<Option<RoomAccessGrant>, RoomAuthError> {
        if peer == &self.owner || self.verifier.is_none() {
            return Ok(None);
        }

        let key = format!("{}:{}", self.room_id, peer);
        if !self.attempts.allow(
            key,
            monotonic_now,
            ROOM_AUTH_MAX_ATTEMPTS,
            Duration::from_secs(ROOM_AUTH_WINDOW_SECS),
        ) {
            return Err(RoomAuthError::RateLimited);
        }

        let password = password.ok_or(RoomAuthError::PasswordRequired)?;
        let verifier = self.verifier.as_ref().expect("protected room has verifier");
        if !verifier.verify(password) {
            return Err(RoomAuthError::InvalidPassword);
        }

        let grant = RoomAccessGrant {
            room_id: self.room_id.clone(),
            owner_peer_id: self.owner.to_string(),
            grantee_peer_id: peer.to_string(),
            revision: self.revision,
            expires_at: now_ms.saturating_add(ROOM_ACCESS_GRANT_TTL_SECS.saturating_mul(1_000)),
        };
        self.grants.insert(*peer, grant.clone());
        Ok(Some(grant))
    }

    pub fn is_authorized(&self, peer: &PeerId, now_ms: u64) -> bool {
        if peer == &self.owner || self.verifier.is_none() {
            return true;
        }
        self.grants.get(peer).is_some_and(|grant| {
            grant.is_valid_for(&self.room_id, &self.owner, peer, self.revision, now_ms)
        })
    }

    pub fn accept_grant(&mut self, grant: RoomAccessGrant, now_ms: u64) -> bool {
        let Ok(grantee) = grant.grantee_peer_id.parse::<PeerId>() else {
            return false;
        };
        if !grant.is_valid_for(&self.room_id, &self.owner, &grantee, self.revision, now_ms) {
            return false;
        }
        self.grants.insert(grantee, grant);
        true
    }

    pub fn revoke_peer(&mut self, peer: &PeerId) {
        self.grants.remove(peer);
    }

    pub fn prune(&mut self, now_ms: u64, monotonic_now: Instant) {
        self.grants.retain(|peer, grant| {
            grant.is_valid_for(&self.room_id, &self.owner, peer, self.revision, now_ms)
        });
        self.attempts.prune(
            monotonic_now,
            Duration::from_secs(ROOM_AUTH_WINDOW_SECS.saturating_mul(2)),
        );
    }
}
