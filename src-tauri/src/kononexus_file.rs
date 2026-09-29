use crate::kononexus_bridge::valid_knp_node_id;
use libp2p::PeerId;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

pub(crate) const KNP_FILE_SCHEMA: u8 = 1;
pub(crate) const KNP_FILE_CHUNK_BYTES: usize = 48 * 1024;
pub(crate) const MAX_KNP_FILE_ENVELOPE_BYTES: usize = 224 * 1024;
pub(crate) const MAX_KNP_FILE_SIZE: u64 = 32 * 1024 * 1024 * 1024;
const MAX_KNP_FILE_NAME_BYTES: usize = 180;
const MAX_KNP_FILE_REASON_BYTES: usize = 256;
const MAX_KNP_FILE_ERROR_BYTES: usize = 512;
const MAX_KNP_FILE_ROOM_CHARS: usize = 64;
const DEFAULT_REPLAY_WINDOW: usize = 2_048;
const DEFAULT_PENDING_DELIVERIES: usize = 1_024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct KnpFileEnvelope {
    pub schema: u8,
    pub sender_peer_id: String,
    pub request_id: String,
    pub transfer_id: String,
    pub body: KnpFileBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum KnpFileBody {
    Offer {
        file_name: String,
        size: u64,
        #[serde(default)]
        room_id: Option<String>,
    },
    Accept,
    Reject {
        reason: String,
    },
    Chunk {
        offset: u64,
        data: Vec<u8>,
    },
    Ack {
        received: u64,
    },
    Complete {
        sha256: String,
    },
    Completed {
        verified: bool,
    },
    Cancel,
    Error {
        message: String,
    },
}

fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn validate_sender_peer_id(value: &str) -> Result<(), String> {
    let peer = value
        .parse::<PeerId>()
        .map_err(|_| "KonoNexus file envelope sender Peer ID is invalid.".to_string())?;
    if peer.to_string() != value {
        return Err("KonoNexus file envelope sender Peer ID is not canonical.".into());
    }
    Ok(())
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    if file_name.trim().is_empty()
        || file_name.len() > MAX_KNP_FILE_NAME_BYTES
        || matches!(file_name, "." | "..")
        || file_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err("KonoNexus file offer contains an unsafe file name.".into());
    }
    Ok(())
}

fn validate_room_id(room_id: Option<&str>) -> Result<(), String> {
    let Some(room_id) = room_id else {
        return Ok(());
    };
    if room_id.is_empty()
        || room_id == "world"
        || room_id.chars().count() > MAX_KNP_FILE_ROOM_CHARS
        || !room_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("KonoNexus file offer contains an invalid room scope.".into());
    }
    Ok(())
}

fn validate_bounded_text(
    value: &str,
    max_bytes: usize,
    field: &'static str,
) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(format!("KonoNexus file {field} is invalid."));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("KonoNexus file completion SHA-256 is invalid.".into());
    }
    Ok(())
}

fn validate_body(body: &KnpFileBody) -> Result<(), String> {
    match body {
        KnpFileBody::Offer {
            file_name,
            size,
            room_id,
        } => {
            validate_file_name(file_name)?;
            validate_room_id(room_id.as_deref())?;
            if *size > MAX_KNP_FILE_SIZE {
                return Err("KonoNexus file offer exceeds the 32 GiB limit.".into());
            }
        }
        KnpFileBody::Accept | KnpFileBody::Cancel => {}
        KnpFileBody::Reject { reason } => {
            validate_bounded_text(reason, MAX_KNP_FILE_REASON_BYTES, "rejection reason")?;
        }
        KnpFileBody::Chunk { offset, data } => {
            if data.is_empty() || data.len() > KNP_FILE_CHUNK_BYTES {
                return Err("KonoNexus file chunk size is invalid.".into());
            }
            let end = offset
                .checked_add(data.len() as u64)
                .ok_or_else(|| "KonoNexus file chunk offset overflow.".to_string())?;
            if end > MAX_KNP_FILE_SIZE {
                return Err("KonoNexus file chunk exceeds the file-size bound.".into());
            }
        }
        KnpFileBody::Ack { received } => {
            if *received > MAX_KNP_FILE_SIZE {
                return Err("KonoNexus file acknowledgement exceeds the file-size bound.".into());
            }
        }
        KnpFileBody::Complete { sha256 } => validate_sha256(sha256)?,
        KnpFileBody::Completed { .. } => {}
        KnpFileBody::Error { message } => {
            validate_bounded_text(message, MAX_KNP_FILE_ERROR_BYTES, "error message")?;
        }
    }
    Ok(())
}

pub(crate) fn validate_envelope(envelope: &KnpFileEnvelope) -> Result<(), String> {
    if envelope.schema != KNP_FILE_SCHEMA {
        return Err(format!(
            "Unsupported KonoNexus file envelope schema {}.",
            envelope.schema
        ));
    }
    validate_sender_peer_id(&envelope.sender_peer_id)?;
    if !valid_uuid(&envelope.request_id) {
        return Err("KonoNexus file request ID is invalid.".into());
    }
    if !valid_uuid(&envelope.transfer_id) {
        return Err("KonoNexus file transfer ID is invalid.".into());
    }
    validate_body(&envelope.body)
}

pub(crate) fn encode_file_message(
    sender_peer_id: &str,
    request_id: &str,
    transfer_id: &str,
    body: KnpFileBody,
) -> Result<Vec<u8>, String> {
    let envelope = KnpFileEnvelope {
        schema: KNP_FILE_SCHEMA,
        sender_peer_id: sender_peer_id.to_string(),
        request_id: request_id.to_string(),
        transfer_id: transfer_id.to_string(),
        body,
    };
    validate_envelope(&envelope)?;
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Failed to serialize KonoNexus file envelope: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_KNP_FILE_ENVELOPE_BYTES {
        return Err(format!(
            "KonoNexus file envelope exceeds the {}-byte Konofix bound.",
            MAX_KNP_FILE_ENVELOPE_BYTES
        ));
    }
    Ok(bytes)
}

pub(crate) fn decode_file_message(data: &[u8]) -> Result<KnpFileEnvelope, String> {
    if data.is_empty() || data.len() > MAX_KNP_FILE_ENVELOPE_BYTES {
        return Err("KonoNexus file envelope size is invalid.".into());
    }
    let envelope: KnpFileEnvelope = serde_json::from_slice(data)
        .map_err(|error| format!("Invalid KonoNexus file envelope: {error}"))?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

#[derive(Debug)]
pub(crate) struct KnpFileReplayGuard {
    capacity: usize,
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl Default for KnpFileReplayGuard {
    fn default() -> Self {
        Self::new(DEFAULT_REPLAY_WINDOW)
    }
}

impl KnpFileReplayGuard {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            seen: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    pub(crate) fn observe(&mut self, request_id: &str) -> bool {
        if self.seen.contains(request_id) {
            return false;
        }
        while self.order.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        let owned = request_id.to_string();
        self.seen.insert(owned.clone());
        self.order.push_back(owned);
        true
    }

    pub(crate) fn clear(&mut self) {
        self.seen.clear();
        self.order.clear();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KnpFileDeliveryState {
    Queued,
    TransportDelivered,
    Resolved,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KnpFileDelivery {
    pub transfer_id: String,
    pub peer_node_id: String,
    pub transport_message_id: u64,
    pub state: KnpFileDeliveryState,
}

#[derive(Debug)]
pub(crate) struct KnpFileDeliveryTracker {
    capacity: usize,
    by_request: HashMap<String, KnpFileDelivery>,
    by_transport: HashMap<(String, u64), String>,
}

impl Default for KnpFileDeliveryTracker {
    fn default() -> Self {
        Self::new(DEFAULT_PENDING_DELIVERIES)
    }
}

impl KnpFileDeliveryTracker {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            by_request: HashMap::new(),
            by_transport: HashMap::new(),
        }
    }

    pub(crate) fn queue(
        &mut self,
        request_id: &str,
        transfer_id: &str,
        peer_node_id: &str,
        transport_message_id: u64,
    ) -> Result<(), String> {
        if !valid_uuid(request_id) || !valid_uuid(transfer_id) {
            return Err("KonoNexus file delivery contains an invalid correlation ID.".into());
        }
        if !valid_knp_node_id(peer_node_id) {
            return Err("KonoNexus file delivery target NodeID is invalid.".into());
        }
        if self.by_request.contains_key(request_id) {
            return Err("KonoNexus file request ID is already pending.".into());
        }
        if self.by_request.len() >= self.capacity {
            return Err("KonoNexus file delivery tracker is full.".into());
        }
        let transport_key = (peer_node_id.to_string(), transport_message_id);
        if self.by_transport.contains_key(&transport_key) {
            return Err("KonoNexus file transport message ID is already pending.".into());
        }
        self.by_request.insert(
            request_id.to_string(),
            KnpFileDelivery {
                transfer_id: transfer_id.to_string(),
                peer_node_id: peer_node_id.to_string(),
                transport_message_id,
                state: KnpFileDeliveryState::Queued,
            },
        );
        self.by_transport
            .insert(transport_key, request_id.to_string());
        Ok(())
    }

    pub(crate) fn mark_transport_delivered(
        &mut self,
        peer_node_id: &str,
        transport_message_id: u64,
    ) -> Option<&KnpFileDelivery> {
        let request_id = self
            .by_transport
            .get(&(peer_node_id.to_string(), transport_message_id))?
            .clone();
        let delivery = self.by_request.get_mut(&request_id)?;
        delivery.state = KnpFileDeliveryState::TransportDelivered;
        self.by_request.get(&request_id)
    }

    pub(crate) fn mark_transport_failed(
        &mut self,
        peer_node_id: &str,
        transport_message_id: u64,
    ) -> Option<KnpFileDelivery> {
        let key = (peer_node_id.to_string(), transport_message_id);
        let request_id = self.by_transport.remove(&key)?;
        let mut delivery = self.by_request.remove(&request_id)?;
        delivery.state = KnpFileDeliveryState::Failed;
        Some(delivery)
    }

    pub(crate) fn resolve(&mut self, request_id: &str) -> Option<KnpFileDelivery> {
        let mut delivery = self.by_request.remove(request_id)?;
        self.by_transport.remove(&(
            delivery.peer_node_id.clone(),
            delivery.transport_message_id,
        ));
        delivery.state = KnpFileDeliveryState::Resolved;
        Some(delivery)
    }

    pub(crate) fn cancel_transfer(&mut self, transfer_id: &str) -> usize {
        let request_ids: Vec<String> = self
            .by_request
            .iter()
            .filter(|(_, delivery)| delivery.transfer_id == transfer_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        let count = request_ids.len();
        for request_id in request_ids {
            if let Some(mut delivery) = self.by_request.remove(&request_id) {
                self.by_transport.remove(&(
                    delivery.peer_node_id.clone(),
                    delivery.transport_message_id,
                ));
                delivery.state = KnpFileDeliveryState::Cancelled;
            }
        }
        count
    }

    pub(crate) fn shutdown(&mut self) -> Vec<String> {
        let mut transfers: Vec<String> = self
            .by_request
            .values()
            .map(|delivery| delivery.transfer_id.clone())
            .collect();
        transfers.sort();
        transfers.dedup();
        self.by_request.clear();
        self.by_transport.clear();
        transfers
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        self.by_request.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> String {
        libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id()
            .to_string()
    }

    fn node(hex: char) -> String {
        format!("knp1{}", hex.to_string().repeat(40))
    }

    fn ids() -> (String, String) {
        (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
    }

    #[test]
    fn file_offer_round_trips_with_identity_and_path_bounds() {
        let (request_id, transfer_id) = ids();
        let sender = peer();
        let bytes = encode_file_message(
            &sender,
            &request_id,
            &transfer_id,
            KnpFileBody::Offer {
                file_name: "photo.png".into(),
                size: 42,
                room_id: Some("friends_1".into()),
            },
        )
        .unwrap();
        let decoded = decode_file_message(&bytes).unwrap();
        assert_eq!(decoded.sender_peer_id, sender);
        assert_eq!(decoded.request_id, request_id);
        assert_eq!(decoded.transfer_id, transfer_id);

        for bad_name in ["../secret.txt", "..\\secret.txt", "C:secret.txt", ".", ""] {
            assert!(encode_file_message(
                &peer(),
                &Uuid::new_v4().to_string(),
                &Uuid::new_v4().to_string(),
                KnpFileBody::Offer {
                    file_name: bad_name.into(),
                    size: 1,
                    room_id: None,
                },
            )
            .is_err());
        }
    }

    #[test]
    fn file_chunk_stays_below_kononexus_message_ceiling() {
        let (request_id, transfer_id) = ids();
        let bytes = encode_file_message(
            &peer(),
            &request_id,
            &transfer_id,
            KnpFileBody::Chunk {
                offset: 0,
                data: vec![255; KNP_FILE_CHUNK_BYTES],
            },
        )
        .unwrap();
        assert!(bytes.len() <= MAX_KNP_FILE_ENVELOPE_BYTES);
        assert!(MAX_KNP_FILE_ENVELOPE_BYTES < 256 * 1024);

        assert!(encode_file_message(
            &peer(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            KnpFileBody::Chunk {
                offset: 0,
                data: vec![0; KNP_FILE_CHUNK_BYTES + 1],
            },
        )
        .is_err());
    }

    #[test]
    fn file_control_semantics_are_versioned_and_bounded() {
        let sender = peer();
        let transfer_id = Uuid::new_v4().to_string();
        for body in [
            KnpFileBody::Accept,
            KnpFileBody::Reject {
                reason: "declined".into(),
            },
            KnpFileBody::Ack { received: 123 },
            KnpFileBody::Complete {
                sha256: "a".repeat(64),
            },
            KnpFileBody::Completed { verified: true },
            KnpFileBody::Cancel,
            KnpFileBody::Error {
                message: "transfer unavailable".into(),
            },
        ] {
            let request_id = Uuid::new_v4().to_string();
            let encoded =
                encode_file_message(&sender, &request_id, &transfer_id, body.clone()).unwrap();
            assert_eq!(decode_file_message(&encoded).unwrap().body, body);
        }

        let encoded = encode_file_message(
            &sender,
            &Uuid::new_v4().to_string(),
            &transfer_id,
            KnpFileBody::Accept,
        )
        .unwrap();
        let mut json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        json["schema"] = serde_json::json!(2);
        assert!(decode_file_message(&serde_json::to_vec(&json).unwrap()).is_err());

        assert!(encode_file_message(
            &sender,
            &Uuid::new_v4().to_string(),
            &transfer_id,
            KnpFileBody::Reject {
                reason: "x".repeat(MAX_KNP_FILE_REASON_BYTES + 1),
            },
        )
        .is_err());
    }

    #[test]
    fn replay_guard_is_duplicate_safe_and_bounded() {
        let mut guard = KnpFileReplayGuard::new(2);
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let third = Uuid::new_v4().to_string();

        assert!(guard.observe(&first));
        assert!(!guard.observe(&first));
        assert!(guard.observe(&second));
        assert!(guard.observe(&third));
        assert!(guard.observe(&first));
        guard.clear();
        assert!(guard.observe(&third));
    }

    #[test]
    fn delivery_tracker_reports_transport_state_and_shutdown_cancels_pending() {
        let mut tracker = KnpFileDeliveryTracker::new(4);
        let request_a = Uuid::new_v4().to_string();
        let request_b = Uuid::new_v4().to_string();
        let transfer_a = Uuid::new_v4().to_string();
        let transfer_b = Uuid::new_v4().to_string();
        let node_a = node('a');
        let node_b = node('b');

        tracker
            .queue(&request_a, &transfer_a, &node_a, 7)
            .unwrap();
        tracker
            .queue(&request_b, &transfer_b, &node_b, 8)
            .unwrap();
        assert!(tracker.queue(&request_a, &transfer_a, &node_a, 9).is_err());

        let delivered = tracker.mark_transport_delivered(&node_a, 7).unwrap();
        assert_eq!(delivered.state, KnpFileDeliveryState::TransportDelivered);
        let resolved = tracker.resolve(&request_a).unwrap();
        assert_eq!(resolved.state, KnpFileDeliveryState::Resolved);

        let failed = tracker.mark_transport_failed(&node_b, 8).unwrap();
        assert_eq!(failed.state, KnpFileDeliveryState::Failed);
        assert_eq!(tracker.pending(), 0);

        tracker
            .queue(
                &Uuid::new_v4().to_string(),
                &transfer_a,
                &node_a,
                10,
            )
            .unwrap();
        tracker
            .queue(
                &Uuid::new_v4().to_string(),
                &transfer_b,
                &node_b,
                11,
            )
            .unwrap();
        let cancelled = tracker.shutdown();
        assert_eq!(cancelled.len(), 2);
        assert_eq!(tracker.pending(), 0);
    }

    #[test]
    fn delivery_tracker_cancellation_removes_only_matching_transfer() {
        let mut tracker = KnpFileDeliveryTracker::new(4);
        let transfer_a = Uuid::new_v4().to_string();
        let transfer_b = Uuid::new_v4().to_string();
        let node = node('c');
        tracker
            .queue(
                &Uuid::new_v4().to_string(),
                &transfer_a,
                &node,
                1,
            )
            .unwrap();
        tracker
            .queue(
                &Uuid::new_v4().to_string(),
                &transfer_b,
                &node,
                2,
            )
            .unwrap();

        assert_eq!(tracker.cancel_transfer(&transfer_a), 1);
        assert_eq!(tracker.pending(), 1);
        assert_eq!(tracker.shutdown(), vec![transfer_b]);
    }
}
