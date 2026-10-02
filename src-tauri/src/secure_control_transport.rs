use std::{
    fmt,
    time::{Duration, Instant},
};

use libp2p::{request_response, PeerId, StreamProtocol};
use uuid::Uuid;

use crate::{
    room_password_state::RoomAuthError,
    secure_channels::{
        validate_room_password, validate_voice_signal, ControlRequest, ControlResponse,
        PrivateDirectMessage, RoomAccessGrant, SecretString, VoiceRoomIntent, VoiceScope,
        VoiceSignal, VoiceSignalAction, CONTROL_PROTOCOL, MAX_CONTROL_REQUEST_WIRE_BYTES,
        MAX_CONTROL_RESPONSE_WIRE_BYTES, PRIVATE_MESSAGE_MAX_CHARS,
    },
    secure_control_runtime::{
        PresenceIdentity, PrivateMessageError, SecureControlRuntime, VoiceSignalError,
    },
};

pub const CONTROL_REQUEST_TIMEOUT_SECS: u64 = 20;

const REASON_INVALID_REQUEST: &str = "invalid_request";
const REASON_PASSWORD_REQUIRED: &str = "password_required";
const REASON_ACCESS_DENIED: &str = "access_denied";
const REASON_RATE_LIMITED: &str = "rate_limited";
const REASON_ROOM_UNAVAILABLE: &str = "room_unavailable";
const REASON_PRIVATE_REJECTED: &str = "private_rejected";
const REASON_REPLAY: &str = "replay_rejected";
const REASON_VOICE_REJECTED: &str = "voice_rejected";
const REASON_VOICE_INVITE_RATE_LIMITED: &str = "voice_invite_rate_limited";

pub fn control_codec() -> request_response::cbor::codec::Codec<ControlRequest, ControlResponse> {
    request_response::cbor::codec::Codec::default()
        .set_request_size_maximum(MAX_CONTROL_REQUEST_WIRE_BYTES)
        .set_response_size_maximum(MAX_CONTROL_RESPONSE_WIRE_BYTES)
}

pub fn control_behaviour() -> request_response::cbor::Behaviour<ControlRequest, ControlResponse> {
    let config = request_response::Config::default()
        .with_request_timeout(Duration::from_secs(CONTROL_REQUEST_TIMEOUT_SECS));
    request_response::cbor::Behaviour::with_codec(
        control_codec(),
        [(
            StreamProtocol::new(CONTROL_PROTOCOL),
            request_response::ProtocolSupport::Full,
        )],
        config,
    )
}

fn valid_room_id(room_id: &str) -> bool {
    !room_id.is_empty()
        && room_id != "world"
        && room_id.chars().count() <= 64
        && room_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn canonical_request_id(raw: &str) -> Option<String> {
    Uuid::parse_str(raw).ok().map(|value| value.to_string())
}

fn room_denial_reason(error: RoomAuthError) -> &'static str {
    match error {
        RoomAuthError::PasswordRequired => REASON_PASSWORD_REQUIRED,
        RoomAuthError::InvalidPassword | RoomAuthError::NotOwner => REASON_ACCESS_DENIED,
        RoomAuthError::RateLimited => REASON_RATE_LIMITED,
        RoomAuthError::InvalidConfiguration(_) => REASON_ROOM_UNAVAILABLE,
    }
}

fn private_denial_reason(error: PrivateMessageError) -> &'static str {
    match error {
        PrivateMessageError::Validation(_) => REASON_PRIVATE_REJECTED,
        PrivateMessageError::RateLimited => REASON_RATE_LIMITED,
        PrivateMessageError::Replay => REASON_REPLAY,
    }
}

fn voice_denial_reason(error: VoiceSignalError) -> &'static str {
    match error {
        VoiceSignalError::Validation(_) => REASON_VOICE_REJECTED,
        VoiceSignalError::RateLimited => REASON_RATE_LIMITED,
        VoiceSignalError::InviteRateLimited => REASON_VOICE_INVITE_RATE_LIMITED,
        VoiceSignalError::Replay => REASON_REPLAY,
    }
}

pub struct InboundControlOutcome {
    pub response: ControlResponse,
    pub room_grant: Option<RoomAccessGrant>,
    pub private_message: Option<PrivateDirectMessage>,
    pub voice_signal: Option<VoiceSignal>,
}

impl fmt::Debug for InboundControlOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let private_metadata = self.private_message.as_ref().map(|message| {
            (
                message.id.as_str(),
                message.peer_id.as_str(),
                message.target_peer_id.as_str(),
            )
        });
        formatter
            .debug_struct("InboundControlOutcome")
            .field("response", &self.response)
            .field("room_grant", &self.room_grant)
            .field("private_message", &private_metadata)
            .field(
                "voice_signal",
                &self.voice_signal.as_ref().map(|signal| {
                    (
                        signal.id.as_str(),
                        signal.session_id.as_str(),
                        signal.peer_id.as_str(),
                        signal.target_peer_id.as_str(),
                        &signal.scope,
                        &signal.action,
                    )
                }),
            )
            .finish()
    }
}

pub fn handle_inbound_control_request(
    runtime: &mut SecureControlRuntime,
    request: ControlRequest,
    authenticated_source: &PeerId,
    local_peer: &PeerId,
    expected_presence: Option<&PresenceIdentity>,
    now_ms: u64,
    monotonic_now: Instant,
) -> InboundControlOutcome {
    match request {
        ControlRequest::RoomJoin {
            request_id,
            room_id,
            password,
        } => {
            let Some(request_id) = canonical_request_id(&request_id) else {
                return InboundControlOutcome {
                    response: ControlResponse::RoomJoin {
                        request_id: Uuid::nil().to_string(),
                        granted: false,
                        reason: Some(REASON_INVALID_REQUEST.into()),
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: None,
                };
            };
            if !valid_room_id(&room_id) {
                return InboundControlOutcome {
                    response: ControlResponse::RoomJoin {
                        request_id,
                        granted: false,
                        reason: Some(REASON_INVALID_REQUEST.into()),
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: None,
                };
            }

            match runtime.authorize_room_join(
                &room_id,
                authenticated_source,
                Some(password.expose()),
                now_ms,
                monotonic_now,
            ) {
                Ok(grant) => InboundControlOutcome {
                    response: ControlResponse::RoomJoin {
                        request_id,
                        granted: true,
                        reason: None,
                    },
                    room_grant: grant,
                    private_message: None,
                    voice_signal: None,
                },
                Err(error) => InboundControlOutcome {
                    response: ControlResponse::RoomJoin {
                        request_id,
                        granted: false,
                        reason: Some(room_denial_reason(error).into()),
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: None,
                },
            }
        }
        ControlRequest::PrivateMessage(message) => {
            let response_id =
                canonical_request_id(&message.id).unwrap_or_else(|| Uuid::nil().to_string());
            match runtime.accept_private_message(
                message,
                authenticated_source,
                local_peer,
                expected_presence,
                now_ms,
                monotonic_now,
            ) {
                Ok(message) => InboundControlOutcome {
                    response: ControlResponse::PrivateAck {
                        message_id: response_id,
                        accepted: true,
                        reason: None,
                    },
                    room_grant: None,
                    private_message: Some(message),
                    voice_signal: None,
                },
                Err(error) => InboundControlOutcome {
                    response: ControlResponse::PrivateAck {
                        message_id: response_id,
                        accepted: false,
                        reason: Some(private_denial_reason(error).into()),
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: None,
                },
            }
        }
        ControlRequest::VoiceSignal(signal) => {
            let response_id =
                canonical_request_id(&signal.id).unwrap_or_else(|| Uuid::nil().to_string());
            match runtime.accept_voice_signal(
                signal,
                authenticated_source,
                local_peer,
                expected_presence,
                now_ms,
                monotonic_now,
            ) {
                Ok(signal) => InboundControlOutcome {
                    response: ControlResponse::VoiceAck {
                        signal_id: response_id,
                        accepted: true,
                        reason: None,
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: Some(signal),
                },
                Err(error) => InboundControlOutcome {
                    response: ControlResponse::VoiceAck {
                        signal_id: response_id,
                        accepted: false,
                        reason: Some(voice_denial_reason(error).into()),
                    },
                    room_grant: None,
                    private_message: None,
                    voice_signal: None,
                },
            }
        }
    }
}

pub fn room_join_request(room_id: &str, password: String) -> Result<ControlRequest, String> {
    if !valid_room_id(room_id) {
        return Err("Invalid protected room ID.".into());
    }
    let Some(password) = validate_room_password(Some(&password))? else {
        return Err("A protected room password is required.".into());
    };
    Ok(ControlRequest::RoomJoin {
        request_id: Uuid::new_v4().to_string(),
        room_id: room_id.to_string(),
        password: SecretString::new(password),
    })
}

pub fn voice_signal_request(
    local_peer: &PeerId,
    target_peer: &PeerId,
    nick: &str,
    nick_color: Option<String>,
    session_id: String,
    scope: VoiceScope,
    action: VoiceSignalAction,
    sdp: Option<String>,
    candidate: Option<String>,
    room_intent: Option<VoiceRoomIntent>,
    muted: Option<bool>,
    now_ms: u64,
) -> Result<ControlRequest, String> {
    if target_peer == local_peer {
        return Err("Voice signaling cannot target the local peer.".into());
    }
    let signal = VoiceSignal {
        id: Uuid::new_v4().to_string(),
        session_id,
        peer_id: local_peer.to_string(),
        target_peer_id: target_peer.to_string(),
        nick: nick.to_string(),
        nick_color: nick_color.clone(),
        scope,
        action,
        sdp,
        candidate,
        room_intent,
        muted,
        timestamp: now_ms,
    };
    validate_voice_signal(
        &signal,
        local_peer,
        target_peer,
        Some(nick),
        nick_color.as_deref(),
        now_ms,
    )
    .map_err(str::to_string)?;
    Ok(ControlRequest::VoiceSignal(signal))
}

pub fn private_message_request(
    local_peer: &PeerId,
    target_peer: &PeerId,
    nick: &str,
    nick_color: Option<String>,
    text: &str,
    now_ms: u64,
) -> Result<ControlRequest, String> {
    if target_peer == local_peer {
        return Err("Private messages cannot target the local peer.".into());
    }
    let text = text.trim();
    if text.is_empty() || text.chars().count() > PRIVATE_MESSAGE_MAX_CHARS {
        return Err(format!(
            "Private message must contain 1-{PRIVATE_MESSAGE_MAX_CHARS} characters."
        ));
    }
    Ok(ControlRequest::PrivateMessage(PrivateDirectMessage {
        id: Uuid::new_v4().to_string(),
        peer_id: local_peer.to_string(),
        target_peer_id: target_peer.to_string(),
        nick: nick.to_string(),
        nick_color,
        text: text.to_string(),
        timestamp: now_ms,
    }))
}
