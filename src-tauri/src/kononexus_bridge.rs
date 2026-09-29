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

pub(crate) fn decode_application_message(data: &[u8]) -> Result<KnpApplicationMessage, String> {
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
