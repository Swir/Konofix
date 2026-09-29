use crate::secure_channels::{
    validate_private_message, validate_room_password, validate_voice_signal, ControlRequest,
    ControlResponse, PrivateDirectMessage, SecretString, VoiceScope, VoiceSignal,
};
use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

pub(crate) const KNP_APP_SCHEMA: u8 = 1;
pub(crate) const MAX_KNP_APP_BYTES: usize = 16 * 1024;
const MAX_KNP_IDENTITY_HINTS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct KnpEnvelope {
    schema: u8,
    payload: KnpPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum KnpPayload {
    Presence(KnpPresence),
    WorldChat(KnpWorldChat),
    PrivateMessage(PrivateDirectMessage),
    PrivateAck(KnpPrivateAck),
    PrivateVoice(VoiceSignal),
    VoiceAck(KnpVoiceAck),
    RoomJoin(KnpRoomJoin),
    RoomAck(KnpRoomAck),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpPresence {
    pub peer_id: String,
    pub nick: String,
    #[serde(default)]
    pub nick_color: Option<String>,
    #[serde(default)]
    pub session_age_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpWorldChat {
    pub id: String,
    pub peer_id: String,
    pub nick: String,
    #[serde(default)]
    pub nick_color: Option<String>,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpPrivateAck {
    pub message_id: String,
    pub accepted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpVoiceAck {
    pub signal_id: String,
    pub accepted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpRoomJoin {
    pub request_id: String,
    pub room_id: String,
    pub password: SecretString,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpRoomAck {
    pub request_id: String,
    pub granted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug)]
pub(crate) enum KnpPrivateControlMessage {
    Request(ControlRequest),
    Response(ControlResponse),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KnpApplicationMessage {
    Presence(KnpPresence),
    WorldChat(KnpWorldChat),
}

pub(crate) fn valid_knp_node_id(value: &str) -> bool {
    value.len() == 44
        && value.starts_with("knp1")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_private_identity(nick: &str, nick_color: Option<&str>) -> Result<(), String> {
    if !(3..=24).contains(&nick.chars().count()) || nick.chars().any(char::is_control) {
        return Err("KonoNexus private-control nickname is invalid.".into());
    }
    if nick_color.is_some_and(|color| color.len() > 16 || color.chars().any(char::is_control)) {
        return Err("KonoNexus private-control nickname color is invalid.".into());
    }
    Ok(())
}

fn validate_private_message_shape(message: &PrivateDirectMessage) -> Result<(), String> {
    let source = message
        .peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus private message sender Peer ID is invalid.".to_string())?;
    let target = message
        .target_peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus private message target Peer ID is invalid.".to_string())?;
    if source == target {
        return Err("KonoNexus private message cannot target its sender.".into());
    }
    validate_private_identity(&message.nick, message.nick_color.as_deref())?;
    validate_private_message(
        message,
        &source,
        &target,
        Some(message.nick.as_str()),
        message.nick_color.as_deref(),
        message.timestamp,
    )
    .map_err(str::to_string)
}

fn validate_private_voice_shape(signal: &VoiceSignal) -> Result<(), String> {
    if !matches!(&signal.scope, VoiceScope::Private) {
        return Err("KonoNexus private-control voice envelope cannot carry room voice.".into());
    }
    let source = signal
        .peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus private voice sender Peer ID is invalid.".to_string())?;
    let target = signal
        .target_peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus private voice target Peer ID is invalid.".to_string())?;
    if source == target {
        return Err("KonoNexus private voice cannot target its sender.".into());
    }
    validate_private_identity(&signal.nick, signal.nick_color.as_deref())?;
    validate_voice_signal(
        signal,
        &source,
        &target,
        Some(signal.nick.as_str()),
        signal.nick_color.as_deref(),
        signal.timestamp,
    )
    .map_err(str::to_string)
}

fn valid_room_control_id(room_id: &str) -> bool {
    !room_id.is_empty()
        && room_id != "world"
        && room_id.chars().count() <= 64
        && room_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_room_join_shape(join: &KnpRoomJoin) -> Result<(), String> {
    Uuid::parse_str(&join.request_id)
        .map_err(|_| "KonoNexus room-control request ID is invalid.".to_string())?;
    if !valid_room_control_id(&join.room_id) {
        return Err("KonoNexus room-control room ID is invalid.".into());
    }
    if validate_room_password(Some(join.password.expose()))?.is_none() {
        return Err("KonoNexus protected-room request requires a password.".into());
    }
    Ok(())
}

fn validate_ack(id: &str, accepted: bool, reason: Option<&str>) -> Result<(), String> {
    Uuid::parse_str(id)
        .map_err(|_| "KonoNexus private-control acknowledgement ID is invalid.".to_string())?;
    if accepted && reason.is_some() {
        return Err(
            "Accepted KonoNexus private-control acknowledgement cannot carry a reason.".into(),
        );
    }
    if reason.is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control)) {
        return Err("KonoNexus private-control acknowledgement reason is invalid.".into());
    }
    Ok(())
}

fn decode_envelope(data: &[u8]) -> Result<KnpEnvelope, String> {
    if data.is_empty() || data.len() > MAX_KNP_APP_BYTES {
        return Err("KonoNexus application envelope size is invalid.".into());
    }
    let envelope: KnpEnvelope = serde_json::from_slice(data)
        .map_err(|error| format!("Invalid KonoNexus application envelope: {error}"))?;
    if envelope.schema != KNP_APP_SCHEMA {
        return Err(format!(
            "Unsupported KonoNexus application envelope schema {}.",
            envelope.schema
        ));
    }
    Ok(envelope)
}

fn serialize(payload: KnpPayload) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(&KnpEnvelope {
        schema: KNP_APP_SCHEMA,
        payload,
    })
    .map_err(|error| format!("Failed to serialize KonoNexus application envelope: {error}"))?;
    if bytes.len() > MAX_KNP_APP_BYTES {
        return Err("KonoNexus application envelope exceeds the 16 KiB Konofix limit.".into());
    }
    Ok(bytes)
}

pub(crate) fn encode_presence(
    peer_id: &str,
    nick: &str,
    nick_color: &str,
    session_age_ms: u64,
) -> Result<Vec<u8>, String> {
    peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus presence contains an invalid libp2p Peer ID.".to_string())?;
    serialize(KnpPayload::Presence(KnpPresence {
        peer_id: peer_id.to_string(),
        nick: nick.to_string(),
        nick_color: Some(nick_color.to_string()),
        session_age_ms: Some(session_age_ms),
    }))
}

pub(crate) fn encode_world_chat(
    id: &str,
    peer_id: &str,
    nick: &str,
    nick_color: &str,
    text: &str,
    timestamp: u64,
) -> Result<Vec<u8>, String> {
    let chat = KnpWorldChat {
        id: id.to_string(),
        peer_id: peer_id.to_string(),
        nick: nick.to_string(),
        nick_color: Some(nick_color.to_string()),
        text: text.to_string(),
        timestamp,
    };
    validate_world_chat_shape(&chat)?;
    serialize(KnpPayload::WorldChat(chat))
}

fn validate_world_chat_shape(chat: &KnpWorldChat) -> Result<(), String> {
    Uuid::parse_str(&chat.id)
        .map_err(|_| "KonoNexus WORLD chat contains an invalid message ID.".to_string())?;
    chat.peer_id
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus WORLD chat contains an invalid libp2p Peer ID.".to_string())?;
    if chat.text.trim().is_empty() || chat.text.chars().count() > 4_000 {
        return Err("KonoNexus WORLD chat text length is invalid.".into());
    }
    if !(3..=24).contains(&chat.nick.chars().count()) {
        return Err("KonoNexus WORLD chat nickname length is invalid.".into());
    }
    if chat
        .nick_color
        .as_deref()
        .is_some_and(|color| color.len() > 16)
    {
        return Err("KonoNexus WORLD chat nickname color is too long.".into());
    }
    Ok(())
}

pub(crate) fn encode_private_control_request(request: &ControlRequest) -> Result<Vec<u8>, String> {
    match request {
        ControlRequest::PrivateMessage(message) => {
            validate_private_message_shape(message)?;
            serialize(KnpPayload::PrivateMessage(message.clone()))
        }
        ControlRequest::VoiceSignal(signal) => {
            validate_private_voice_shape(signal)?;
            serialize(KnpPayload::PrivateVoice(signal.clone()))
        }
        ControlRequest::RoomJoin { .. } => {
            Err("Room control is not part of the KonoNexus private-control slice.".into())
        }
    }
}

pub(crate) fn encode_private_control_response(
    response: &ControlResponse,
) -> Result<Vec<u8>, String> {
    match response {
        ControlResponse::PrivateAck {
            message_id,
            accepted,
            reason,
        } => {
            validate_ack(message_id, *accepted, reason.as_deref())?;
            serialize(KnpPayload::PrivateAck(KnpPrivateAck {
                message_id: message_id.clone(),
                accepted: *accepted,
                reason: reason.clone(),
            }))
        }
        ControlResponse::VoiceAck {
            signal_id,
            accepted,
            reason,
        } => {
            validate_ack(signal_id, *accepted, reason.as_deref())?;
            serialize(KnpPayload::VoiceAck(KnpVoiceAck {
                signal_id: signal_id.clone(),
                accepted: *accepted,
                reason: reason.clone(),
            }))
        }
        ControlResponse::RoomJoin { .. } => {
            Err("Room control is not part of the KonoNexus private-control slice.".into())
        }
    }
}

pub(crate) fn encode_room_control_request(request: &ControlRequest) -> Result<Vec<u8>, String> {
    let ControlRequest::RoomJoin {
        request_id,
        room_id,
        password,
    } = request
    else {
        return Err("Only protected-room join belongs to the KonoNexus room-control slice.".into());
    };
    let join = KnpRoomJoin {
        request_id: request_id.clone(),
        room_id: room_id.clone(),
        password: password.clone(),
    };
    validate_room_join_shape(&join)?;
    serialize(KnpPayload::RoomJoin(join))
}

pub(crate) fn encode_room_control_response(response: &ControlResponse) -> Result<Vec<u8>, String> {
    let ControlResponse::RoomJoin {
        request_id,
        granted,
        reason,
    } = response
    else {
        return Err(
            "Only protected-room acknowledgement belongs to KonoNexus room control.".into(),
        );
    };
    validate_ack(request_id, *granted, reason.as_deref())?;
    serialize(KnpPayload::RoomAck(KnpRoomAck {
        request_id: request_id.clone(),
        granted: *granted,
        reason: reason.clone(),
    }))
}

pub(crate) fn decode_room_control_message(data: &[u8]) -> Result<KnpPrivateControlMessage, String> {
    let envelope = decode_envelope(data)?;
    match envelope.payload {
        KnpPayload::RoomJoin(join) => {
            validate_room_join_shape(&join)?;
            Ok(KnpPrivateControlMessage::Request(
                ControlRequest::RoomJoin {
                    request_id: join.request_id,
                    room_id: join.room_id,
                    password: join.password,
                },
            ))
        }
        KnpPayload::RoomAck(ack) => {
            validate_ack(&ack.request_id, ack.granted, ack.reason.as_deref())?;
            Ok(KnpPrivateControlMessage::Response(
                ControlResponse::RoomJoin {
                    request_id: ack.request_id,
                    granted: ack.granted,
                    reason: ack.reason,
                },
            ))
        }
        KnpPayload::Presence(_)
        | KnpPayload::WorldChat(_)
        | KnpPayload::PrivateMessage(_)
        | KnpPayload::PrivateAck(_)
        | KnpPayload::PrivateVoice(_)
        | KnpPayload::VoiceAck(_) => Err("KonoNexus envelope is not room secure-control.".into()),
    }
}

pub(crate) fn decode_private_control_message(
    data: &[u8],
) -> Result<KnpPrivateControlMessage, String> {
    let envelope = decode_envelope(data)?;
    match envelope.payload {
        KnpPayload::PrivateMessage(message) => {
            validate_private_message_shape(&message)?;
            Ok(KnpPrivateControlMessage::Request(
                ControlRequest::PrivateMessage(message),
            ))
        }
        KnpPayload::PrivateAck(ack) => {
            validate_ack(&ack.message_id, ack.accepted, ack.reason.as_deref())?;
            Ok(KnpPrivateControlMessage::Response(
                ControlResponse::PrivateAck {
                    message_id: ack.message_id,
                    accepted: ack.accepted,
                    reason: ack.reason,
                },
            ))
        }
        KnpPayload::PrivateVoice(signal) => {
            validate_private_voice_shape(&signal)?;
            Ok(KnpPrivateControlMessage::Request(
                ControlRequest::VoiceSignal(signal),
            ))
        }
        KnpPayload::VoiceAck(ack) => {
            validate_ack(&ack.signal_id, ack.accepted, ack.reason.as_deref())?;
            Ok(KnpPrivateControlMessage::Response(
                ControlResponse::VoiceAck {
                    signal_id: ack.signal_id,
                    accepted: ack.accepted,
                    reason: ack.reason,
                },
            ))
        }
        KnpPayload::Presence(_)
        | KnpPayload::WorldChat(_)
        | KnpPayload::RoomJoin(_)
        | KnpPayload::RoomAck(_) => Err("KonoNexus envelope is not private secure-control.".into()),
    }
}

pub(crate) fn decode_application_message(data: &[u8]) -> Result<KnpApplicationMessage, String> {
    let envelope = decode_envelope(data)?;
    match envelope.payload {
        KnpPayload::Presence(presence) => {
            presence.peer_id.parse::<PeerId>().map_err(|_| {
                "KonoNexus presence contains an invalid libp2p Peer ID.".to_string()
            })?;
            Ok(KnpApplicationMessage::Presence(presence))
        }
        KnpPayload::WorldChat(chat) => {
            validate_world_chat_shape(&chat)?;
            Ok(KnpApplicationMessage::WorldChat(chat))
        }
        KnpPayload::PrivateMessage(_)
        | KnpPayload::PrivateAck(_)
        | KnpPayload::PrivateVoice(_)
        | KnpPayload::VoiceAck(_)
        | KnpPayload::RoomJoin(_)
        | KnpPayload::RoomAck(_) => {
            Err("KonoNexus secure-control requires a control decoder.".into())
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct KnpIdentityBindings {
    hints_by_knp: HashMap<String, PeerId>,
    hints_by_peer: HashMap<PeerId, String>,
    authenticated_knp: HashSet<String>,
}

impl KnpIdentityBindings {
    pub(crate) fn observe_legacy_hint(
        &mut self,
        knp_node_id: &str,
        peer_id: PeerId,
    ) -> Result<bool, String> {
        if !valid_knp_node_id(knp_node_id) {
            return Err("KonoNexus NodeID hint is malformed.".into());
        }
        if let Some(existing) = self.hints_by_knp.get(knp_node_id) {
            if existing != &peer_id {
                return Err(
                    "KonoNexus NodeID hint conflicts with an existing Peer ID binding.".into(),
                );
            }
        }
        if let Some(existing) = self.hints_by_peer.get(&peer_id) {
            if existing != knp_node_id {
                return Err(
                    "libp2p Peer ID hint conflicts with an existing KonoNexus NodeID.".into(),
                );
            }
        }
        if self.hints_by_knp.contains_key(knp_node_id) {
            return Ok(false);
        }
        if self.hints_by_knp.len() >= MAX_KNP_IDENTITY_HINTS {
            return Err("KonoNexus identity hint table is full.".into());
        }
        self.hints_by_knp.insert(knp_node_id.to_string(), peer_id);
        self.hints_by_peer.insert(peer_id, knp_node_id.to_string());
        Ok(true)
    }

    pub(crate) fn authenticate_source(
        &mut self,
        knp_node_id: &str,
        peer_id: PeerId,
    ) -> Result<bool, String> {
        if !valid_knp_node_id(knp_node_id) {
            return Err("Authenticated KonoNexus source NodeID is malformed.".into());
        }
        match self.hints_by_knp.get(knp_node_id) {
            Some(expected) if expected == &peer_id => {}
            Some(_) => {
                return Err(
                    "Authenticated KonoNexus NodeID does not match its libp2p identity hint."
                        .into(),
                )
            }
            None => return Err(
                "Authenticated KonoNexus source has no source-authenticated libp2p identity hint."
                    .into(),
            ),
        }
        match self.hints_by_peer.get(&peer_id) {
            Some(expected) if expected == knp_node_id => {}
            _ => {
                return Err(
                    "libp2p identity does not map back to the authenticated KonoNexus NodeID."
                        .into(),
                )
            }
        }
        Ok(self.authenticated_knp.insert(knp_node_id.to_string()))
    }

    pub(crate) fn is_authenticated_source(&self, knp_node_id: &str, peer_id: &PeerId) -> bool {
        self.authenticated_knp.contains(knp_node_id)
            && self.hints_by_knp.get(knp_node_id) == Some(peer_id)
            && self.hints_by_peer.get(peer_id).map(String::as_str) == Some(knp_node_id)
    }

    pub(crate) fn targets(&self, limit: usize) -> Vec<String> {
        let mut targets: Vec<String> = self.hints_by_knp.keys().cloned().collect();
        targets.sort();
        targets.truncate(limit.min(MAX_KNP_IDENTITY_HINTS));
        targets
    }

    pub(crate) fn authenticated_targets(&self, limit: usize) -> Vec<String> {
        let mut targets: Vec<String> = self.authenticated_knp.iter().cloned().collect();
        targets.sort();
        targets.truncate(limit.min(MAX_KNP_IDENTITY_HINTS));
        targets
    }

    pub(crate) fn authenticated_node_for_peer(&self, peer_id: &PeerId) -> Option<&str> {
        let knp_node_id = self.hints_by_peer.get(peer_id)?;
        self.authenticated_knp
            .contains(knp_node_id)
            .then_some(knp_node_id.as_str())
    }

    pub(crate) fn authenticated_peer_for_node(&self, knp_node_id: &str) -> Option<PeerId> {
        if !self.authenticated_knp.contains(knp_node_id) {
            return None;
        }
        self.hints_by_knp.get(knp_node_id).cloned()
    }

    pub(crate) fn authenticated_count(&self) -> usize {
        self.authenticated_knp.len()
    }
}

#[derive(Debug)]
pub(crate) struct BoundedMessageIds {
    capacity: usize,
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl BoundedMessageIds {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            order: VecDeque::new(),
            seen: HashSet::new(),
        }
    }

    pub(crate) fn observe(&mut self, id: &str) -> bool {
        if self.seen.contains(id) {
            return false;
        }
        while self.order.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        let owned = id.to_string();
        self.order.push_back(owned.clone());
        self.seen.insert(owned);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> PeerId {
        libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id()
    }

    fn node(hex: char) -> String {
        format!("knp1{}", hex.to_string().repeat(40))
    }

    #[test]
    fn node_id_validation_is_strict_and_lowercase() {
        assert!(valid_knp_node_id(&node('a')));
        assert!(!valid_knp_node_id("knp1deadbeef"));
        assert!(!valid_knp_node_id(&format!("knp1{}", "A".repeat(40))));
        assert!(!valid_knp_node_id(&format!("bad1{}", "a".repeat(40))));
    }

    #[test]
    fn application_envelopes_round_trip_and_reject_wrong_schema() {
        let peer = peer();
        let presence = encode_presence(&peer.to_string(), "Alice", "#62E5FF", 1234).unwrap();
        let decoded = decode_application_message(&presence).unwrap();
        let KnpApplicationMessage::Presence(decoded) = decoded else {
            panic!("wrong KonoNexus payload kind");
        };
        assert_eq!(decoded.peer_id, peer.to_string());
        assert_eq!(decoded.nick, "Alice");

        let chat_id = Uuid::new_v4().to_string();
        let chat = encode_world_chat(
            &chat_id,
            &peer.to_string(),
            "Alice",
            "#62E5FF",
            "hello WORLD",
            1234,
        )
        .unwrap();
        let decoded = decode_application_message(&chat).unwrap();
        let KnpApplicationMessage::WorldChat(decoded) = decoded else {
            panic!("wrong KonoNexus payload kind");
        };
        assert_eq!(decoded.id, chat_id);
        assert_eq!(decoded.text, "hello WORLD");

        let mut json: serde_json::Value = serde_json::from_slice(&chat).unwrap();
        json["schema"] = serde_json::json!(2);
        assert!(decode_application_message(&serde_json::to_vec(&json).unwrap()).is_err());
    }

    #[test]
    fn malformed_or_oversized_application_envelopes_fail_closed() {
        assert!(decode_application_message(&[]).is_err());
        assert!(decode_application_message(&vec![b'x'; MAX_KNP_APP_BYTES + 1]).is_err());
        assert!(decode_application_message(
            br#"{"schema":1,"payload":{"kind":"presence","peer_id":"bad"}}"#
        )
        .is_err());

        let peer = peer();
        let bad_chat = serde_json::json!({
            "schema": 1,
            "payload": {
                "kind": "world_chat",
                "id": "not-a-uuid",
                "peer_id": peer.to_string(),
                "nick": "Alice",
                "text": "hello",
                "timestamp": 1
            }
        });
        assert!(decode_application_message(&serde_json::to_vec(&bad_chat).unwrap()).is_err());
    }

    #[test]
    fn world_chat_requires_nonempty_bounded_text() {
        let peer = peer();
        let id = Uuid::new_v4().to_string();
        assert!(encode_world_chat(&id, &peer.to_string(), "Alice", "#62E5FF", "", 1).is_err());
        assert!(encode_world_chat(
            &id,
            &peer.to_string(),
            "Alice",
            "#62E5FF",
            &"x".repeat(4001),
            1
        )
        .is_err());
    }

    #[test]
    fn private_control_message_and_voice_round_trip_without_room_scope() {
        let local = peer();
        let remote = peer();
        let message = PrivateDirectMessage {
            id: Uuid::new_v4().to_string(),
            peer_id: local.to_string(),
            target_peer_id: remote.to_string(),
            nick: "Alice".into(),
            nick_color: Some("#62E5FF".into()),
            text: "private hello".into(),
            timestamp: 1234,
        };
        let request = ControlRequest::PrivateMessage(message.clone());
        let encoded = encode_private_control_request(&request).unwrap();
        let KnpPrivateControlMessage::Request(ControlRequest::PrivateMessage(decoded)) =
            decode_private_control_message(&encoded).unwrap()
        else {
            panic!("wrong private-control payload");
        };
        assert_eq!(decoded, message);
        assert!(decode_application_message(&encoded).is_err());

        let signal = VoiceSignal {
            id: Uuid::new_v4().to_string(),
            session_id: Uuid::new_v4().to_string(),
            peer_id: local.to_string(),
            target_peer_id: remote.to_string(),
            nick: "Alice".into(),
            nick_color: Some("#62E5FF".into()),
            scope: VoiceScope::Private,
            action: crate::secure_channels::VoiceSignalAction::Invite,
            sdp: None,
            candidate: None,
            room_intent: None,
            muted: None,
            timestamp: 1234,
        };
        let encoded =
            encode_private_control_request(&ControlRequest::VoiceSignal(signal.clone())).unwrap();
        let KnpPrivateControlMessage::Request(ControlRequest::VoiceSignal(decoded)) =
            decode_private_control_message(&encoded).unwrap()
        else {
            panic!("wrong private voice payload");
        };
        assert_eq!(decoded, signal);
    }

    #[test]
    fn private_control_rejects_room_voice_and_bounds_ack_reason() {
        let local = peer();
        let remote = peer();
        let room_signal = VoiceSignal {
            id: Uuid::new_v4().to_string(),
            session_id: Uuid::new_v4().to_string(),
            peer_id: local.to_string(),
            target_peer_id: remote.to_string(),
            nick: "Alice".into(),
            nick_color: Some("#62E5FF".into()),
            scope: VoiceScope::Room {
                room_id: "world".into(),
            },
            action: crate::secure_channels::VoiceSignalAction::Invite,
            sdp: None,
            candidate: None,
            room_intent: Some(crate::secure_channels::VoiceRoomIntent::Listen),
            muted: None,
            timestamp: 1234,
        };
        assert!(encode_private_control_request(&ControlRequest::VoiceSignal(room_signal)).is_err());

        let message_id = Uuid::new_v4().to_string();
        let accepted = ControlResponse::PrivateAck {
            message_id: message_id.clone(),
            accepted: true,
            reason: None,
        };
        let encoded = encode_private_control_response(&accepted).unwrap();
        let KnpPrivateControlMessage::Response(ControlResponse::PrivateAck {
            message_id: decoded_id,
            accepted: true,
            reason: None,
        }) = decode_private_control_message(&encoded).unwrap()
        else {
            panic!("wrong private acknowledgement payload");
        };
        assert_eq!(decoded_id, message_id);

        assert!(
            encode_private_control_response(&ControlResponse::PrivateAck {
                message_id,
                accepted: false,
                reason: Some("x".repeat(129)),
            })
            .is_err()
        );
    }

    #[test]
    fn protected_room_control_round_trips_and_redacts_password_debug() {
        let request_id = Uuid::new_v4().to_string();
        let request = ControlRequest::RoomJoin {
            request_id: request_id.clone(),
            room_id: "secret-room".into(),
            password: SecretString::new("correct horse".into()),
        };
        let encoded = encode_room_control_request(&request).unwrap();
        let decoded = decode_room_control_message(&encoded).unwrap();
        let KnpPrivateControlMessage::Request(ControlRequest::RoomJoin {
            request_id: decoded_id,
            room_id,
            password,
        }) = decoded
        else {
            panic!("wrong room-control request");
        };
        assert_eq!(decoded_id, request_id);
        assert_eq!(room_id, "secret-room");
        assert_eq!(password.expose(), "correct horse");
        assert!(!format!("{request:?}").contains("correct horse"));
        assert!(decode_application_message(&encoded).is_err());
        assert!(decode_private_control_message(&encoded).is_err());

        let response = ControlResponse::RoomJoin {
            request_id: request_id.clone(),
            granted: true,
            reason: None,
        };
        let encoded = encode_room_control_response(&response).unwrap();
        let KnpPrivateControlMessage::Response(ControlResponse::RoomJoin {
            request_id: decoded_id,
            granted: true,
            reason: None,
        }) = decode_room_control_message(&encoded).unwrap()
        else {
            panic!("wrong room-control acknowledgement");
        };
        assert_eq!(decoded_id, request_id);
    }

    #[test]
    fn room_control_rejects_world_invalid_password_and_unbounded_reason() {
        let request_id = Uuid::new_v4().to_string();
        for (room_id, password) in [
            ("world", "correct horse"),
            ("secret-room", "x"),
            ("bad room", "correct horse"),
        ] {
            let request = ControlRequest::RoomJoin {
                request_id: request_id.clone(),
                room_id: room_id.into(),
                password: SecretString::new(password.into()),
            };
            assert!(encode_room_control_request(&request).is_err());
        }

        assert!(encode_room_control_response(&ControlResponse::RoomJoin {
            request_id,
            granted: false,
            reason: Some("x".repeat(129)),
        })
        .is_err());
    }

    #[test]
    fn knp_source_requires_matching_authenticated_legacy_hint() {
        let peer_a = peer();
        let peer_b = peer();
        let node_a = node('a');
        let node_b = node('b');
        let mut bindings = KnpIdentityBindings::default();

        assert!(bindings.authenticate_source(&node_a, peer_a).is_err());
        assert!(bindings.observe_legacy_hint(&node_a, peer_a).unwrap());
        assert!(!bindings.observe_legacy_hint(&node_a, peer_a).unwrap());
        assert!(bindings.authenticate_source(&node_a, peer_b).is_err());
        assert!(bindings.authenticate_source(&node_a, peer_a).unwrap());
        assert!(bindings.is_authenticated_source(&node_a, &peer_a));
        assert_eq!(bindings.authenticated_targets(8), vec![node_a.clone()]);
        assert_eq!(
            bindings.authenticated_node_for_peer(&peer_a),
            Some(node_a.as_str())
        );
        assert_eq!(bindings.authenticated_peer_for_node(&node_a), Some(peer_a));
        assert!(!bindings.authenticate_source(&node_a, peer_a).unwrap());

        assert!(bindings.observe_legacy_hint(&node_a, peer_b).is_err());
        assert!(bindings.observe_legacy_hint(&node_b, peer_a).is_err());
        assert_eq!(bindings.authenticated_count(), 1);
    }

    #[test]
    fn target_snapshot_is_deterministic_and_bounded() {
        let mut bindings = KnpIdentityBindings::default();
        for (index, hex) in ['a', 'b', 'c'].into_iter().enumerate() {
            let mut node_id = node(hex);
            node_id.replace_range(43..44, &format!("{:x}", index));
            bindings.observe_legacy_hint(&node_id, peer()).unwrap();
        }
        let first = bindings.targets(2);
        let second = bindings.targets(2);
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        assert!(bindings.authenticated_targets(8).is_empty());
    }

    #[test]
    fn bounded_message_ids_suppress_cross_transport_duplicates_and_evict_oldest() {
        let mut ids = BoundedMessageIds::new(2);
        assert!(ids.observe("a"));
        assert!(!ids.observe("a"));
        assert!(ids.observe("b"));
        assert!(ids.observe("c"));
        assert!(ids.observe("a"));
        assert!(!ids.observe("c"));
    }
}
