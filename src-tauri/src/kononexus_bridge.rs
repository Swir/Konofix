use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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

pub(crate) fn valid_knp_node_id(value: &str) -> bool {
    value.len() == 44
        && value.starts_with("knp1")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
    let envelope = KnpEnvelope {
        schema: KNP_APP_SCHEMA,
        payload: KnpPayload::Presence(KnpPresence {
            peer_id: peer_id.to_string(),
            nick: nick.to_string(),
            nick_color: Some(nick_color.to_string()),
            session_age_ms: Some(session_age_ms),
        }),
    };
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Failed to serialize KonoNexus application envelope: {error}"))?;
    if bytes.len() > MAX_KNP_APP_BYTES {
        return Err("KonoNexus application envelope exceeds the 16 KiB Konofix limit.".into());
    }
    Ok(bytes)
}

pub(crate) fn decode_presence(data: &[u8]) -> Result<KnpPresence, String> {
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
            presence
                .peer_id
                .parse::<PeerId>()
                .map_err(|_| "KonoNexus presence contains an invalid libp2p Peer ID.".to_string())?;
            Ok(presence)
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
                return Err("KonoNexus NodeID hint conflicts with an existing Peer ID binding.".into());
            }
        }
        if let Some(existing) = self.hints_by_peer.get(&peer_id) {
            if existing != knp_node_id {
                return Err("libp2p Peer ID hint conflicts with an existing KonoNexus NodeID.".into());
            }
        }
        if self.hints_by_knp.contains_key(knp_node_id) {
            return Ok(false);
        }
        if self.hints_by_knp.len() >= MAX_KNP_IDENTITY_HINTS {
            return Err("KonoNexus identity hint table is full.".into());
        }
        self.hints_by_knp
            .insert(knp_node_id.to_string(), peer_id);
        self.hints_by_peer
            .insert(peer_id, knp_node_id.to_string());
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
                    "Authenticated KonoNexus NodeID does not match its libp2p identity hint.".into(),
                )
            }
            None => {
                return Err(
                    "Authenticated KonoNexus source has no source-authenticated libp2p identity hint."
                        .into(),
                )
            }
        }
        match self.hints_by_peer.get(&peer_id) {
            Some(expected) if expected == knp_node_id => {}
            _ => {
                return Err(
                    "libp2p identity does not map back to the authenticated KonoNexus NodeID.".into(),
                )
            }
        }
        Ok(self.authenticated_knp.insert(knp_node_id.to_string()))
    }

    pub(crate) fn targets(&self, limit: usize) -> Vec<String> {
        let mut targets: Vec<String> = self.hints_by_knp.keys().cloned().collect();
        targets.sort();
        targets.truncate(limit.min(MAX_KNP_IDENTITY_HINTS));
        targets
    }

    pub(crate) fn authenticated_count(&self) -> usize {
        self.authenticated_knp.len()
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
    fn presence_envelope_round_trips_and_rejects_wrong_schema() {
        let peer = peer();
        let bytes = encode_presence(&peer.to_string(), "Alice", "#62E5FF", 1234).unwrap();
        let decoded = decode_presence(&bytes).unwrap();
        assert_eq!(decoded.peer_id, peer.to_string());
        assert_eq!(decoded.nick, "Alice");
        assert_eq!(decoded.nick_color.as_deref(), Some("#62E5FF"));
        assert_eq!(decoded.session_age_ms, Some(1234));

        let mut json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        json["schema"] = serde_json::json!(2);
        assert!(decode_presence(&serde_json::to_vec(&json).unwrap()).is_err());
    }

    #[test]
    fn oversized_or_malformed_envelopes_fail_closed() {
        assert!(decode_presence(&[]).is_err());
        assert!(decode_presence(&vec![b'x'; MAX_KNP_APP_BYTES + 1]).is_err());
        assert!(decode_presence(br#"{"schema":1,"payload":{"kind":"presence","peer_id":"bad"}}"#).is_err());
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
    }
}
