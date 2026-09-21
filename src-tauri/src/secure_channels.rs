use std::{
    collections::HashMap,
    fmt,
    time::{Duration, Instant},
};

use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const CONTROL_PROTOCOL: &str = "/konofix/control/1.0.0";
pub const MAX_CONTROL_REQUEST_WIRE_BYTES: u64 = 32 * 1024;
pub const MAX_CONTROL_RESPONSE_WIRE_BYTES: u64 = 8 * 1024;

pub const ROOM_PASSWORD_MIN_CHARS: usize = 6;
pub const ROOM_PASSWORD_MAX_CHARS: usize = 64;
pub const ROOM_PASSWORD_MAX_BYTES: usize = 256;
pub const ROOM_PASSWORD_KDF_ROUNDS: u32 = 210_000;
pub const ROOM_ACCESS_GRANT_TTL_SECS: u64 = 12 * 60 * 60;
pub const ROOM_AUTH_WINDOW_SECS: u64 = 30;
pub const ROOM_AUTH_MAX_ATTEMPTS: u32 = 5;

pub const PRIVATE_MESSAGE_MAX_CHARS: usize = 4_000;
pub const PRIVATE_MESSAGE_MAX_AGE_MS: u64 = 5 * 60 * 1_000;
pub const PRIVATE_MESSAGE_CLOCK_SKEW_MS: u64 = 60 * 1_000;
pub const PRIVATE_RATE_WINDOW_SECS: u64 = 10;
pub const PRIVATE_RATE_MAX_MESSAGES: u32 = 20;
pub const PRIVATE_REPLAY_TTL_SECS: u64 = 10 * 60;
pub const PRIVATE_REPLAY_MAX_ENTRIES: usize = 2_048;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

pub fn validate_room_password(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.chars().any(char::is_control) {
        return Err("Room password cannot contain control characters.".into());
    }
    let chars = raw.chars().count();
    if !(ROOM_PASSWORD_MIN_CHARS..=ROOM_PASSWORD_MAX_CHARS).contains(&chars) {
        return Err(format!(
            "Room password must contain {ROOM_PASSWORD_MIN_CHARS}-{ROOM_PASSWORD_MAX_CHARS} characters."
        ));
    }
    if raw.len() > ROOM_PASSWORD_MAX_BYTES {
        return Err(format!(
            "Room password exceeds the {ROOM_PASSWORD_MAX_BYTES}-byte limit."
        ));
    }
    Ok(Some(raw.to_string()))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

pub fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], rounds: u32) -> [u8; 32] {
    assert!(rounds > 0, "PBKDF2 rounds must be non-zero");
    let mut first_input = Vec::with_capacity(salt.len() + 4);
    first_input.extend_from_slice(salt);
    first_input.extend_from_slice(&1u32.to_be_bytes());

    let mut u = hmac_sha256(password, &first_input);
    let mut output = u;
    for _ in 1..rounds {
        u = hmac_sha256(password, &u);
        for index in 0..output.len() {
            output[index] ^= u[index];
        }
    }
    output
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

pub struct RoomPasswordVerifier {
    salt: [u8; 16],
    digest: [u8; 32],
    revision: u64,
}

impl fmt::Debug for RoomPasswordVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RoomPasswordVerifier")
            .field("revision", &self.revision)
            .field("salt", &"<redacted>")
            .field("digest", &"<redacted>")
            .finish()
    }
}

impl RoomPasswordVerifier {
    pub fn new(password: &str, revision: u64) -> Result<Self, String> {
        let Some(password) = validate_room_password(Some(password))? else {
            return Err("A protected room requires a non-empty password.".into());
        };
        let salt = *Uuid::new_v4().as_bytes();
        Ok(Self::from_validated_password_and_salt(
            &password,
            salt,
            revision,
            ROOM_PASSWORD_KDF_ROUNDS,
        ))
    }

    pub fn verify(&self, password: &str) -> bool {
        let Ok(Some(password)) = validate_room_password(Some(password)) else {
            return false;
        };
        let candidate =
            pbkdf2_hmac_sha256(password.as_bytes(), &self.salt, ROOM_PASSWORD_KDF_ROUNDS);
        constant_time_eq(&self.digest, &candidate)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    #[cfg(test)]
    fn from_validated_password_and_salt(
        password: &str,
        salt: [u8; 16],
        revision: u64,
        rounds: u32,
    ) -> Self {
        Self {
            salt,
            digest: pbkdf2_hmac_sha256(password.as_bytes(), &salt, rounds),
            revision,
        }
    }

    #[cfg(not(test))]
    fn from_validated_password_and_salt(
        password: &str,
        salt: [u8; 16],
        revision: u64,
        rounds: u32,
    ) -> Self {
        Self {
            salt,
            digest: pbkdf2_hmac_sha256(password.as_bytes(), &salt, rounds),
            revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoomAccessGrant {
    pub room_id: String,
    pub owner_peer_id: String,
    pub grantee_peer_id: String,
    pub revision: u64,
    pub expires_at: u64,
}

impl RoomAccessGrant {
    pub fn is_valid_for(
        &self,
        room_id: &str,
        owner: &PeerId,
        grantee: &PeerId,
        revision: u64,
        now_ms: u64,
    ) -> bool {
        let Ok(claimed_owner) = self.owner_peer_id.parse::<PeerId>() else {
            return false;
        };
        let Ok(claimed_grantee) = self.grantee_peer_id.parse::<PeerId>() else {
            return false;
        };
        self.room_id == room_id
            && claimed_owner == *owner
            && claimed_grantee == *grantee
            && claimed_owner.to_string() == self.owner_peer_id
            && claimed_grantee.to_string() == self.grantee_peer_id
            && self.revision == revision
            && self.expires_at > now_ms
            && self.expires_at
                <= now_ms.saturating_add(ROOM_ACCESS_GRANT_TTL_SECS.saturating_mul(1_000))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrivateDirectMessage {
    pub id: String,
    pub peer_id: String,
    pub target_peer_id: String,
    pub nick: String,
    #[serde(default)]
    pub nick_color: Option<String>,
    pub text: String,
    pub timestamp: u64,
}

pub fn validate_private_message(
    message: &PrivateDirectMessage,
    authenticated_source: &PeerId,
    local_peer: &PeerId,
    expected_nick: Option<&str>,
    expected_nick_color: Option<&str>,
    now_ms: u64,
) -> Result<(), &'static str> {
    if Uuid::parse_str(&message.id).is_err() {
        return Err("Invalid private message ID.");
    }
    let Ok(claimed_source) = message.peer_id.parse::<PeerId>() else {
        return Err("Invalid private sender identity.");
    };
    let Ok(claimed_target) = message.target_peer_id.parse::<PeerId>() else {
        return Err("Invalid private target identity.");
    };
    if claimed_source != *authenticated_source || claimed_source.to_string() != message.peer_id {
        return Err("Private sender identity does not match the authenticated peer.");
    }
    if claimed_target != *local_peer || claimed_target.to_string() != message.target_peer_id {
        return Err("Private message is addressed to another peer.");
    }
    if message.text.trim().is_empty() || message.text.chars().count() > PRIVATE_MESSAGE_MAX_CHARS {
        return Err("Private message text is empty or too long.");
    }
    if let Some(expected) = expected_nick {
        if message.nick != expected {
            return Err("Private sender nickname does not match current authenticated presence.");
        }
    }
    if let Some(expected) = expected_nick_color {
        if message.nick_color.as_deref() != Some(expected) {
            return Err("Private sender color does not match current authenticated presence.");
        }
    }
    if message.timestamp > now_ms.saturating_add(PRIVATE_MESSAGE_CLOCK_SKEW_MS) {
        return Err("Private message timestamp is too far in the future.");
    }
    if now_ms.saturating_sub(message.timestamp) > PRIVATE_MESSAGE_MAX_AGE_MS {
        return Err("Private message is stale.");
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    RoomJoin {
        request_id: String,
        room_id: String,
        password: SecretString,
    },
    PrivateMessage(PrivateDirectMessage),
}

impl fmt::Debug for ControlRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RoomJoin {
                request_id,
                room_id,
                ..
            } => formatter
                .debug_struct("RoomJoin")
                .field("request_id", request_id)
                .field("room_id", room_id)
                .field("password", &"<redacted>")
                .finish(),
            Self::PrivateMessage(message) => formatter
                .debug_struct("PrivateMessage")
                .field("id", &message.id)
                .field("peer_id", &message.peer_id)
                .field("target_peer_id", &message.target_peer_id)
                .field("text", &"<redacted>")
                .finish(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    RoomJoin {
        request_id: String,
        granted: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    PrivateAck {
        message_id: String,
        accepted: bool,
        #[serde(default)]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct RateWindow {
    started: Instant,
    count: u32,
}

#[derive(Debug, Default)]
pub struct WindowRateLimiter {
    windows: HashMap<String, RateWindow>,
}

impl WindowRateLimiter {
    pub fn allow(
        &mut self,
        key: impl Into<String>,
        now: Instant,
        limit: u32,
        window: Duration,
    ) -> bool {
        let key = key.into();
        let entry = self.windows.entry(key).or_insert(RateWindow {
            started: now,
            count: 0,
        });
        if now.saturating_duration_since(entry.started) >= window {
            entry.started = now;
            entry.count = 0;
        }
        if entry.count >= limit {
            return false;
        }
        entry.count = entry.count.saturating_add(1);
        true
    }

    pub fn prune(&mut self, now: Instant, max_age: Duration) {
        self.windows
            .retain(|_, window| now.saturating_duration_since(window.started) < max_age);
    }
}

#[derive(Debug)]
pub struct ReplayCache {
    entries: HashMap<String, Instant>,
    max_entries: usize,
}

impl ReplayCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max_entries: max_entries.max(1),
        }
    }

    pub fn accept(&mut self, id: &str, now: Instant, ttl: Duration) -> bool {
        self.entries
            .retain(|_, inserted| now.saturating_duration_since(*inserted) < ttl);
        if self.entries.contains_key(id) {
            return false;
        }
        if self.entries.len() >= self.max_entries {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, inserted)| **inserted)
                .map(|(id, _)| id.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(id.to_string(), now);
        true
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn pbkdf2_sha256_matches_public_test_vectors() {
        assert_eq!(
            hex::encode(pbkdf2_hmac_sha256(b"password", b"salt", 1)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex::encode(pbkdf2_hmac_sha256(b"password", b"salt", 2)),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        assert_eq!(
            hex::encode(pbkdf2_hmac_sha256(b"password", b"salt", 4096)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    #[test]
    fn verifier_accepts_exact_password_and_redacts_debug() {
        let salt = [7u8; 16];
        let verifier =
            RoomPasswordVerifier::from_validated_password_and_salt("correct horse", salt, 9, 2);
        assert_eq!(verifier.revision(), 9);
        assert_eq!(
            verifier.digest,
            pbkdf2_hmac_sha256(b"correct horse", &salt, 2)
        );
        let debug = format!("{verifier:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("correct horse"));
    }
}
