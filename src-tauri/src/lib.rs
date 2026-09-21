use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::StreamExt;
use libp2p::{
    autonat, dcutr, gossipsub, identify,
    kad::{self, store::MemoryStore, GetRecordOk, Quorum, Record, RecordKey},
    mdns, noise, ping, relay, request_response,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, upnp, yamux, Multiaddr, PeerId, StreamProtocol, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

mod incoming_file;
#[cfg(test)]
mod messaging_runtime_tests;
mod room_membership;
mod room_membership_application;
mod room_membership_desktop;
mod room_membership_live;
mod room_membership_network;
mod room_membership_production;
mod room_membership_runtime;
mod room_membership_wire;

use incoming_file::{commit_reserved_file, reserve_incoming_file};
use room_membership_application::{ApplicationMembershipEffects, MembershipSnapshotPayload};
use room_membership_production::RoomMembershipProductionBridge;

const WORLD_TOPIC: &str = "konofix/world/v3";
const KAD_PROTOCOL: &str = "/konofix/kad/1.0.0";
const FILE_PROTOCOL: &str = "/konofix/file/1.0.0";
const WORLD_PROVIDER_KEY: &str = "/konofix/world/providers/v1";
const PRESENCE_TTL_SECS: u64 = 38;
const NICK_LEASE_SECS: u64 = 42;
const NICK_LEASE_CLOCK_SKEW_SECS: u64 = 5;
const FILE_CHUNK_SIZE: usize = 256 * 1024;
const MAX_FILE_OFFER_NAME_BYTES: usize = 4 * 1024;
// CBOR encodes Vec<u8> as an integer array: each byte can require two wire
// bytes. Include bounded metadata overhead without changing the v1 protocol.
const MAX_FILE_REQUEST_WIRE_BYTES: u64 = 2 * FILE_CHUNK_SIZE as u64 + 4096;
const MAX_FILE_RESPONSE_WIRE_BYTES: u64 = 16 * 1024;
const MAX_FILE_SIZE: u64 = 32 * 1024 * 1024 * 1024;
const MAX_TRANSFERS_PER_DIRECTION: usize = 4;
const MAX_PENDING_OFFERS_PER_PEER: usize = 1;
const PENDING_FILE_OFFER_TTL_SECS: u64 = 45;
const INCOMING_TRANSFER_IDLE_TTL_SECS: u64 = 120;
const MAX_ROOMS_TOTAL: usize = 256;
const MAX_ROOMS_PER_OWNER: usize = 16;
const DEFAULT_NICK_COLOR: &str = "#8FA0FF";
const ALLOWED_NICK_COLORS: &[&str] = &[
    "#8FA0FF", "#62E5FF", "#44E6A8", "#FFD166", "#FF8FAB", "#C77DFF", "#FF9F68", "#7AE582",
    "#5CC8FF", "#B8C0FF", "#F4A261", "#E879F9",
];
const MAX_BOOTSTRAP_SOURCES: usize = 32;
const BOOTSTRAP_RETRY_TICK_SECS: u64 = 5;
const BOOTSTRAP_RETRY_BASE_SECS: u64 = 3;
const BOOTSTRAP_RETRY_MAX_SECS: u64 = 60;
const BOOTSTRAP_PENDING_RETRY_SECS: u64 = 20;
const MAX_PARTICIPANT_RELAYS: usize = 3;
const BUILTIN_BOOTSTRAP_POOL_JSON: &str = include_str!("../bootstrap-pool.json");

#[derive(Debug, Deserialize)]
struct BootstrapPoolManifest {
    schema: u8,
    seeds: Vec<String>,
}

#[derive(Debug, Clone)]
struct BootstrapTarget {
    raw: String,
    peer_id: PeerId,
    full_addr: Multiaddr,
    connected: bool,
    failures: u32,
    next_attempt: Instant,
}

impl BootstrapTarget {
    fn new(raw: String, peer_id: PeerId, full_addr: Multiaddr, now: Instant) -> Self {
        Self {
            raw,
            peer_id,
            full_addr,
            connected: false,
            failures: 0,
            next_attempt: now,
        }
    }

    fn should_attempt(&self, now: Instant) -> bool {
        !self.connected && now >= self.next_attempt
    }

    fn mark_dial_started(&mut self, now: Instant) {
        self.next_attempt = now + Duration::from_secs(BOOTSTRAP_PENDING_RETRY_SECS);
    }

    fn mark_connected(&mut self) {
        self.connected = true;
        self.failures = 0;
    }

    fn mark_disconnected(&mut self, now: Instant) {
        self.connected = false;
        self.next_attempt = now + Duration::from_secs(BOOTSTRAP_RETRY_BASE_SECS);
    }

    fn mark_failure(&mut self, now: Instant) {
        self.connected = false;
        self.failures = self.failures.saturating_add(1);
        self.next_attempt = now + bootstrap_retry_delay(self.failures);
    }
}

fn bootstrap_retry_delay(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(5);
    let seconds = BOOTSTRAP_RETRY_BASE_SECS
        .saturating_mul(1u64 << shift)
        .min(BOOTSTRAP_RETRY_MAX_SECS);
    Duration::from_secs(seconds)
}

#[derive(Default)]
struct AppState {
    tx: Mutex<Option<mpsc::Sender<NetworkCommand>>>,
}

fn install_network_sender(
    state: &AppState,
    tx: mpsc::Sender<NetworkCommand>,
) -> Result<(), String> {
    let mut guard = state.tx.lock().map_err(|_| "Błąd blokady stanu")?;
    if guard.is_some() {
        return Err("Sieć jest już uruchomiona.".into());
    }
    *guard = Some(tx);
    Ok(())
}

fn clear_network_sender_if_current(
    state: &AppState,
    task_tx: &mpsc::Sender<NetworkCommand>,
) -> Result<bool, String> {
    let mut guard = state.tx.lock().map_err(|_| "Błąd blokady stanu")?;
    let owns_current_session = guard
        .as_ref()
        .is_some_and(|current| current.same_channel(task_tx));
    if owns_current_session {
        guard.take();
    }
    Ok(owns_current_session)
}

fn take_network_sender(state: &AppState) -> Result<Option<mpsc::Sender<NetworkCommand>>, String> {
    Ok(state.tx.lock().map_err(|_| "Błąd blokady stanu")?.take())
}

#[derive(Debug, Clone, Serialize)]
struct StartResult {
    peer_id: String,
    nick: String,
    nick_color: String,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    id: String,
    kind: String,
    peer_id: Option<String>,
    nick: String,
    #[serde(default)]
    nick_color: Option<String>,
    room: String,
    text: String,
    // Internally tagged Serde enums buffer integers as u64, not u128.
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PeerInfo {
    peer_id: String,
    nick: String,
    #[serde(default)]
    nick_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RoomInfo {
    id: String,
    title: String,
    owner: Option<String>,
    users: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NetworkStatus {
    phase: String,
    connected_peers: usize,
    dht_peers: usize,
    bootstrap_count: usize,
    nat: String,
    listen_addresses: Vec<String>,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NickLease {
    peer_id: String,
    nick: String,
    canonical: String,
    expires_at: u64,
}

#[derive(Debug)]
struct PeerPresence {
    nick: String,
    nick_color: String,
    last_seen: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PeerCacheFile {
    peers: HashMap<String, Vec<String>>,
}

fn peer_cache_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|base| base.join("Konofix Chat").join("peer-cache.json"))
}

fn load_peer_cache() -> PeerCacheFile {
    let Some(path) = peer_cache_path() else {
        return PeerCacheFile::default();
    };
    let Ok(data) = std::fs::read(path) else {
        return PeerCacheFile::default();
    };
    serde_json::from_slice(&data).unwrap_or_default()
}

fn save_peer_cache(cache: &PeerCacheFile) {
    let Some(path) = peer_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_vec_pretty(cache) {
        let _ = std::fs::write(path, data);
    }
}

fn remember_peer_address(cache: &mut PeerCacheFile, peer: PeerId, address: &Multiaddr) {
    if address
        .iter()
        .any(|p| matches!(p, libp2p::multiaddr::Protocol::Memory(_)))
    {
        return;
    }
    let entry = cache.peers.entry(peer.to_string()).or_default();
    let value = address.to_string();
    if !entry.contains(&value) {
        entry.push(value);
        if entry.len() > 8 {
            entry.remove(0);
        }
    }
    if cache.peers.len() > 128 {
        if let Some(key) = cache.peers.keys().next().cloned() {
            cache.peers.remove(&key);
        }
    }
}

fn address_for_peer(mut address: Multiaddr, peer: PeerId) -> Option<Multiaddr> {
    let terminal_peer = address.iter().last().and_then(|part| match part {
        libp2p::multiaddr::Protocol::P2p(existing) => Some(existing),
        _ => None,
    });
    match terminal_peer {
        Some(existing) => (existing == peer).then_some(address),
        _ => {
            address.push(libp2p::multiaddr::Protocol::P2p(peer));
            Some(address)
        }
    }
}

fn participant_relay_address(address: Multiaddr, peer: PeerId) -> Option<Multiaddr> {
    use libp2p::multiaddr::Protocol;
    if address.iter().any(|part| match part {
        Protocol::P2pCircuit | Protocol::Memory(_) => true,
        Protocol::Ip4(ip) => ip.is_unspecified() || ip.is_loopback() || ip.is_multicast(),
        Protocol::Ip6(ip) => ip.is_unspecified() || ip.is_loopback() || ip.is_multicast(),
        _ => false,
    }) {
        return None;
    }
    let mut address = address_for_peer(address, peer)?;
    address.push(Protocol::P2pCircuit);
    Some(address)
}

fn add_cached_peers_to_swarm(swarm: &mut libp2p::Swarm<Behaviour>, cache: &PeerCacheFile) -> usize {
    let mut added = 0usize;
    for (peer_raw, addresses) in &cache.peers {
        let Ok(peer) = peer_raw.parse::<PeerId>() else {
            continue;
        };
        for addr_raw in addresses {
            let Ok(addr) = addr_raw.parse::<Multiaddr>() else {
                continue;
            };
            swarm.behaviour_mut().kad.add_address(&peer, addr.clone());
            swarm
                .behaviour_mut()
                .file_transfer
                .add_address(&peer, addr.clone());
            if let Some(full) = address_for_peer(addr, peer) {
                let _ = swarm.dial(full);
                added += 1;
            }
        }
    }
    added
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireEvent {
    Presence {
        peer_id: String,
        nick: String,
        #[serde(default)]
        nick_color: Option<String>,
    },
    Goodbye {
        peer_id: String,
    },
    NickClaim {
        peer_id: String,
        nick: String,
        canonical: String,
        expires_at: u64,
    },
    Chat(ChatMessage),
    RoomCreate(RoomInfo),
    MembershipSnapshot(MembershipSnapshotPayload),
    RoomClose {
        room_id: String,
        owner: String,
    },
}

fn wire_event_claimed_peer_id(event: &WireEvent) -> Option<&str> {
    match event {
        WireEvent::Presence { peer_id, .. }
        | WireEvent::Goodbye { peer_id }
        | WireEvent::NickClaim { peer_id, .. } => Some(peer_id.as_str()),
        WireEvent::Chat(message) => message.peer_id.as_deref(),
        WireEvent::RoomCreate(room) => room.owner.as_deref(),
        WireEvent::MembershipSnapshot(snapshot) => Some(snapshot.peer_id.as_str()),
        WireEvent::RoomClose { owner, .. } => Some(owner.as_str()),
    }
}

fn wire_event_matches_source(event: &WireEvent, source: &PeerId) -> bool {
    let source = source.to_string();
    wire_event_claimed_peer_id(event)
        .map(|claimed| claimed == source.as_str())
        .unwrap_or(false)
}

fn valid_wire_room_id(room_id: &str) -> bool {
    !room_id.is_empty()
        && room_id.chars().count() <= 64
        && room_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn wire_event_is_well_formed(event: &WireEvent) -> bool {
    match event {
        WireEvent::Presence {
            peer_id,
            nick,
            nick_color,
        } => {
            peer_id.parse::<PeerId>().is_ok()
                && validate_nick(nick).is_ok()
                && optional_nick_color_is_valid(nick_color.as_deref())
        }
        WireEvent::Goodbye { peer_id } => peer_id.parse::<PeerId>().is_ok(),
        WireEvent::MembershipSnapshot(snapshot) => snapshot.is_well_formed(),
        WireEvent::NickClaim {
            peer_id,
            nick,
            canonical,
            expires_at,
        } => {
            peer_id.parse::<PeerId>().is_ok()
                && validate_nick(nick).is_ok()
                && canonical == &canonical_nick(nick)
                && *expires_at > 0
        }
        WireEvent::Chat(message) => {
            let Some(peer_id) = message.peer_id.as_deref() else {
                return false;
            };
            peer_id.parse::<PeerId>().is_ok()
                && Uuid::parse_str(&message.id).is_ok()
                && message.kind == "chat"
                && validate_nick(&message.nick).is_ok()
                && optional_nick_color_is_valid(message.nick_color.as_deref())
                && valid_wire_room_id(&message.room)
                && !message.text.trim().is_empty()
                && message.text.chars().count() <= 4000
        }
        WireEvent::RoomCreate(room) => {
            let Some(owner) = room.owner.as_deref() else {
                return false;
            };
            let Some(title) = room.title.strip_prefix("# ") else {
                return false;
            };
            owner.parse::<PeerId>().is_ok()
                && room.id != "world"
                && valid_wire_room_id(&room.id)
                && (3..=32).contains(&title.chars().count())
                && room.id == slug::slugify(title)
                && room.users.is_none_or(|users| users <= 100_000)
        }
        WireEvent::RoomClose { room_id, owner } => {
            owner.parse::<PeerId>().is_ok() && room_id != "world" && valid_wire_room_id(room_id)
        }
    }
}

fn room_create_admission(
    rooms: &HashMap<String, RoomInfo>,
    room: &RoomInfo,
) -> Result<(), &'static str> {
    let Some(owner) = room.owner.as_deref() else {
        return Err("Room owner is missing.");
    };

    if let Some(existing) = rooms.get(&room.id) {
        return if existing.owner.as_deref() == Some(owner) {
            Ok(())
        } else {
            Err("Room ID is already owned by another peer.")
        };
    }

    let owned_count = rooms
        .values()
        .filter(|candidate| candidate.owner.as_deref() == Some(owner))
        .count();
    if owned_count >= MAX_ROOMS_PER_OWNER {
        return Err("Room owner reached the active-room limit.");
    }
    if rooms.len() >= MAX_ROOMS_TOTAL {
        return Err("Global active-room limit reached.");
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum FileRequest {
    Offer {
        transfer_id: String,
        file_name: String,
        size: u64,
    },
    Chunk {
        transfer_id: String,
        offset: u64,
        data: Vec<u8>,
    },
    Complete {
        transfer_id: String,
        sha256: String,
    },
    Cancel {
        transfer_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum FileResponse {
    Accepted,
    Rejected {
        reason: String,
    },
    Ack {
        received: u64,
    },
    Complete {
        verified: bool,
        path: Option<String>,
    },
    Error {
        message: String,
    },
}

fn file_completion_response(verified: bool) -> FileResponse {
    FileResponse::Complete {
        verified,
        path: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileOfferView {
    transfer_id: String,
    peer_id: String,
    nick: String,
    file_name: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileTransferView {
    transfer_id: String,
    direction: String,
    peer_id: String,
    nick: String,
    file_name: String,
    size: u64,
    transferred: u64,
    progress: f64,
    status: String,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
struct OutgoingTransfer {
    peer: PeerId,
    nick: String,
    file_name: String,
    path: PathBuf,
    size: u64,
    sent: u64,
    file: Option<File>,
    hasher: Sha256,
}

#[derive(Debug)]
struct PendingIncomingOffer {
    peer: PeerId,
    nick: String,
    file_name: String,
    size: u64,
    created_at: Instant,
    channel: request_response::ResponseChannel<FileResponse>,
}

fn file_offer_capacity_error(
    pending_total: usize,
    incoming_total: usize,
    pending_from_peer: usize,
) -> Option<&'static str> {
    if pending_from_peer >= MAX_PENDING_OFFERS_PER_PEER {
        return Some("This peer already has a pending file offer.");
    }
    if pending_total.saturating_add(incoming_total) >= MAX_TRANSFERS_PER_DIRECTION {
        return Some("All incoming file-transfer slots are currently busy.");
    }
    None
}

fn pending_offer_is_expired(created_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(created_at) >= Duration::from_secs(PENDING_FILE_OFFER_TTL_SECS)
}

fn incoming_transfer_is_expired(last_activity: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_activity)
        >= Duration::from_secs(INCOMING_TRANSFER_IDLE_TTL_SECS)
}

#[derive(Debug)]
struct IncomingTransfer {
    peer: PeerId,
    nick: String,
    file_name: String,
    size: u64,
    received: u64,
    file: File,
    hasher: Sha256,
    final_path: PathBuf,
    temp_path: PathBuf,
    last_activity: Instant,
}

#[derive(Debug, Clone, Copy)]
enum OutboundKind {
    Offer,
    Chunk,
    Complete,
    Cancel,
}

fn file_response_matches_outbound_kind(kind: OutboundKind, response: &FileResponse) -> bool {
    match kind {
        OutboundKind::Offer => matches!(
            response,
            FileResponse::Accepted | FileResponse::Rejected { .. } | FileResponse::Error { .. }
        ),
        OutboundKind::Chunk => matches!(
            response,
            FileResponse::Ack { .. } | FileResponse::Rejected { .. } | FileResponse::Error { .. }
        ),
        OutboundKind::Complete => matches!(
            response,
            FileResponse::Complete { .. } | FileResponse::Error { .. }
        ),
        OutboundKind::Cancel => true,
    }
}

#[cfg(test)]
mod file_response_phase_tests {
    use super::*;

    fn variants() -> Vec<FileResponse> {
        vec![
            FileResponse::Accepted,
            FileResponse::Rejected {
                reason: "no".into(),
            },
            FileResponse::Ack { received: 1 },
            FileResponse::Complete {
                verified: true,
                path: None,
            },
            FileResponse::Error {
                message: "err".into(),
            },
        ]
    }

    #[test]
    fn non_cancel_phases_accept_only_documented_variants() {
        for response in variants() {
            assert_eq!(
                file_response_matches_outbound_kind(OutboundKind::Offer, &response),
                matches!(
                    &response,
                    FileResponse::Accepted
                        | FileResponse::Rejected { .. }
                        | FileResponse::Error { .. }
                )
            );
            assert_eq!(
                file_response_matches_outbound_kind(OutboundKind::Chunk, &response),
                matches!(
                    &response,
                    FileResponse::Ack { .. }
                        | FileResponse::Rejected { .. }
                        | FileResponse::Error { .. }
                )
            );
            assert_eq!(
                file_response_matches_outbound_kind(OutboundKind::Complete, &response),
                matches!(
                    &response,
                    FileResponse::Complete { .. } | FileResponse::Error { .. }
                )
            );
        }
    }

    #[test]
    fn cancellation_responses_are_terminally_ignored() {
        for response in variants() {
            assert!(file_response_matches_outbound_kind(
                OutboundKind::Cancel,
                &response
            ));
        }
    }
}

#[derive(Debug, Clone)]
struct OutboundMeta {
    transfer_id: String,
    kind: OutboundKind,
}

#[derive(Debug)]
enum NetworkCommand {
    SendMessage {
        room: String,
        text: String,
    },
    CreateRoom {
        room: RoomInfo,
        reply: oneshot::Sender<Result<RoomInfo, String>>,
    },
    EnterRoom {
        room_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    AddBootstrap {
        address: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RefreshDiscovery,
    OfferFile {
        peer_id: String,
        path: PathBuf,
        file_name: String,
        size: u64,
        reply: oneshot::Sender<Result<FileTransferView, String>>,
    },
    AcceptFile {
        transfer_id: String,
        reply: oneshot::Sender<Result<FileTransferView, String>>,
    },
    RejectFile {
        transfer_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    CancelFile {
        transfer_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Stop,
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
    kad: kad::Behaviour<MemoryStore>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    autonat: autonat::Behaviour,
    relay_client: relay::client::Behaviour,
    relay_server: relay::Behaviour,
    dcutr: dcutr::Behaviour,
    upnp: upnp::tokio::Behaviour,
    file_transfer: request_response::cbor::Behaviour<FileRequest, FileResponse>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn canonical_nick(raw: &str) -> String {
    raw.nfkc().flat_map(char::to_lowercase).collect::<String>()
}

fn normalize_nick_color(raw: Option<&str>) -> String {
    let candidate = raw
        .unwrap_or(DEFAULT_NICK_COLOR)
        .trim()
        .to_ascii_uppercase();
    if ALLOWED_NICK_COLORS.contains(&candidate.as_str()) {
        candidate
    } else {
        DEFAULT_NICK_COLOR.to_string()
    }
}

fn optional_nick_color_is_valid(raw: Option<&str>) -> bool {
    raw.is_none_or(|value| {
        let candidate = value.trim().to_ascii_uppercase();
        ALLOWED_NICK_COLORS.contains(&candidate.as_str())
    })
}

fn validate_nick(raw: &str) -> Result<String, String> {
    let nick = raw.nfkc().collect::<String>();
    let nick = nick.trim();
    if !(3..=24).contains(&nick.chars().count()) {
        return Err("Nick musi mieć 3–24 znaki.".into());
    }
    if !nick
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("Nick może zawierać litery, cyfry, _, - i kropkę.".into());
    }
    let canonical = canonical_nick(nick);
    if matches!(
        canonical.as_str(),
        "system" | "admin" | "administrator" | "moderator"
    ) {
        return Err("Ten nick jest zarezerwowany.".into());
    }
    Ok(nick.to_string())
}

fn nick_record_key(canonical: &str) -> RecordKey {
    let bytes = format!("/konofix/nick/{canonical}").into_bytes();
    RecordKey::new(&bytes)
}

fn world_provider_key() -> RecordKey {
    let bytes = WORLD_PROVIDER_KEY.as_bytes().to_vec();
    RecordKey::new(&bytes)
}

fn parse_builtin_bootstrap_pool() -> Result<Vec<String>, String> {
    let manifest: BootstrapPoolManifest = serde_json::from_str(BUILTIN_BOOTSTRAP_POOL_JSON)
        .map_err(|error| format!("Built-in bootstrap pool is invalid JSON: {error}"))?;
    if manifest.schema != 1 {
        return Err(format!(
            "Built-in bootstrap pool schema {} is unsupported.",
            manifest.schema
        ));
    }
    dedupe_bootstrap_sources(manifest.seeds)
}

fn dedupe_bootstrap_sources<I>(sources: I) -> Result<Vec<String>, String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in sources {
        let value = raw.trim().to_string();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        out.push(value);
        if out.len() > MAX_BOOTSTRAP_SOURCES {
            return Err(format!(
                "Too many bootstrap sources: maximum is {MAX_BOOTSTRAP_SOURCES}."
            ));
        }
    }
    Ok(out)
}

fn bootstrap_sources(extra: Vec<String>) -> Result<Vec<String>, String> {
    let mut combined = parse_builtin_bootstrap_pool()?;
    if let Ok(env) = std::env::var("KONOFIX_BOOTSTRAPS") {
        combined.extend(
            env.split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        );
    }
    combined.extend(extra);
    dedupe_bootstrap_sources(combined)
}

fn file_offer_name_error(file_name: &str) -> Option<&'static str> {
    if file_name.len() > MAX_FILE_OFFER_NAME_BYTES {
        Some("File name exceeds the 4096-byte protocol limit.")
    } else {
        None
    }
}

fn safe_filename(raw: &str) -> String {
    let mut name = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    name = name
        .trim()
        .trim_end_matches(|c| c == '.' || c == ' ')
        .to_string();
    if name.is_empty() || name == "." || name == ".." {
        name = "konofix-file.bin".into();
    }
    if name.chars().count() > 180 {
        name = name.chars().take(180).collect();
    }
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        name = format!("_{name}");
    }
    name
}

fn download_directory() -> Result<PathBuf, String> {
    let base = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Downloads")))
        .ok_or("Nie udało się znaleźć folderu Pobrane.")?;
    Ok(base.join("Konofix Chat"))
}

fn file_view_outgoing(
    id: &str,
    t: &OutgoingTransfer,
    status: &str,
    path: Option<String>,
    error: Option<String>,
) -> FileTransferView {
    FileTransferView {
        transfer_id: id.to_string(),
        direction: "outgoing".into(),
        peer_id: t.peer.to_string(),
        nick: t.nick.clone(),
        file_name: t.file_name.clone(),
        size: t.size,
        transferred: t.sent,
        progress: if t.size == 0 {
            100.0
        } else {
            (t.sent as f64 / t.size as f64) * 100.0
        },
        status: status.into(),
        path,
        error,
    }
}

fn file_view_incoming(
    id: &str,
    t: &IncomingTransfer,
    status: &str,
    path: Option<String>,
    error: Option<String>,
) -> FileTransferView {
    FileTransferView {
        transfer_id: id.to_string(),
        direction: "incoming".into(),
        peer_id: t.peer.to_string(),
        nick: t.nick.clone(),
        file_name: t.file_name.clone(),
        size: t.size,
        transferred: t.received,
        progress: if t.size == 0 {
            100.0
        } else {
            (t.received as f64 / t.size as f64) * 100.0
        },
        status: status.into(),
        path,
        error,
    }
}

// The same network loop serves the desktop and integration tests. Only event
// delivery and local storage locations differ; wire handling is never mocked.
trait NetworkRuntime: Send + Sync + 'static {
    fn emit_event<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;

    fn downloads(&self) -> Result<PathBuf, String> {
        download_directory()
    }

    fn load_peers(&self) -> PeerCacheFile {
        load_peer_cache()
    }

    fn save_peers(&self, cache: &PeerCacheFile) {
        save_peer_cache(cache);
    }
}

fn file_codec() -> request_response::cbor::codec::Codec<FileRequest, FileResponse> {
    request_response::cbor::codec::Codec::default()
        .set_request_size_maximum(MAX_FILE_REQUEST_WIRE_BYTES)
        .set_response_size_maximum(MAX_FILE_RESPONSE_WIRE_BYTES)
}

impl NetworkRuntime for AppHandle {
    fn emit_event<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        self.emit(event, payload).map_err(|error| error.to_string())
    }
}

fn emit_transfer(app: &impl NetworkRuntime, transfer: &FileTransferView) {
    let _ = app.emit_event("file-transfer", transfer.clone());
}

#[tauri::command]
async fn start_network(
    nick: String,
    nick_color: Option<String>,
    bootstraps: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartResult, String> {
    let nick = validate_nick(&nick)?;
    let nick_color = normalize_nick_color(nick_color.as_deref());
    let bootstrap_list = bootstrap_sources(bootstraps.unwrap_or_default())?;
    let (tx, rx) = mpsc::channel(128);
    install_network_sender(state.inner(), tx.clone())?;

    let task_tx = tx.clone();
    let startup_tx = tx;
    let (ready_tx, ready_rx) = oneshot::channel();
    let nick_for_task = nick.clone();
    tauri::async_runtime::spawn(async move {
        let task_result = network_task(
            nick_for_task,
            nick_color.clone(),
            bootstrap_list,
            app.clone(),
            rx,
            ready_tx,
        )
        .await;
        let app_state = app.state::<AppState>();
        let owned_session =
            clear_network_sender_if_current(app_state.inner(), &task_tx).unwrap_or(false);
        if let Err(err) = task_result {
            if owned_session {
                let _ = app.emit("network-error", err);
            }
        }
    });

    let ready_result = match ready_rx.await {
        Ok(result) => result,
        Err(_) => {
            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);
            return Err("Nie udało się uruchomić warstwy P2P.".to_string());
        }
    };

    match ready_result {
        Ok(peer_id) => Ok(StartResult {
            peer_id,
            nick,
            nick_color,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }),
        Err(err) => {
            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);
            Err(err)
        }
    }
}

#[tauri::command]
async fn send_message(
    room: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    if text.chars().count() > 4000 {
        return Err("Wiadomość jest za długa.".into());
    }
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    tx.send(NetworkCommand::SendMessage { room, text })
        .await
        .map_err(|_| "Warstwa P2P została zatrzymana.".into())
}

#[tauri::command]
async fn create_room(title: String, state: State<'_, AppState>) -> Result<RoomInfo, String> {
    let clean = title.trim();
    if !(3..=32).contains(&clean.chars().count()) {
        return Err("Nazwa pokoju musi mieć 3–32 znaki.".into());
    }
    let id = slug::slugify(clean);
    if id.is_empty() || id == "world" {
        return Err("Nieprawidłowa nazwa pokoju.".into());
    }
    let room = RoomInfo {
        id,
        title: format!("# {clean}"),
        owner: None,
        users: Some(1),
    };
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    let (reply, response) = oneshot::channel();
    tx.send(NetworkCommand::CreateRoom { room, reply })
        .await
        .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    response
        .await
        .map_err(|_| "Room creation interrupted.".to_string())?
}

#[tauri::command]
async fn enter_room(room_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "State lock failed.")?
        .clone()
        .ok_or("No P2P connection.")?;
    let (reply, response) = oneshot::channel();
    tx.send(NetworkCommand::EnterRoom { room_id, reply })
        .await
        .map_err(|_| "P2P network stopped.".to_string())?;
    response
        .await
        .map_err(|_| "Room switch interrupted.".to_string())?
}

#[tauri::command]
async fn add_bootstrap(address: String, state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Najpierw połącz się z siecią.")?;
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(NetworkCommand::AddBootstrap {
        address,
        reply: reply_tx,
    })
    .await
    .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Brak odpowiedzi warstwy P2P.".to_string())?
}

#[tauri::command]
async fn refresh_discovery(state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    tx.send(NetworkCommand::RefreshDiscovery)
        .await
        .map_err(|_| "Warstwa P2P została zatrzymana.".into())
}

#[tauri::command]
async fn offer_file(
    peer_id: String,
    state: State<'_, AppState>,
) -> Result<Option<FileTransferView>, String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Najpierw połącz się z siecią.")?;

    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Wyślij plik przez Konofix Chat")
            .pick_file()
    })
    .await
    .map_err(|e| format!("Błąd okna wyboru pliku: {e}"))?;
    let Some(path) = path else {
        return Ok(None);
    };

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Nie można odczytać pliku: {e}"))?;
    if !metadata.is_file() {
        return Err("Można wysyłać tylko pliki.".into());
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Err("Plik jest większy niż limit 32 GiB tej wersji.".into());
    }
    let file_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .map(safe_filename)
        .ok_or("Nieprawidłowa nazwa pliku.")?;

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(NetworkCommand::OfferFile {
        peer_id,
        path,
        file_name,
        size: metadata.len(),
        reply: reply_tx,
    })
    .await
    .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;

    let transfer = reply_rx
        .await
        .map_err(|_| "Brak odpowiedzi modułu transferu.".to_string())??;
    Ok(Some(transfer))
}

#[tauri::command]
async fn accept_file(
    transfer_id: String,
    state: State<'_, AppState>,
) -> Result<FileTransferView, String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(NetworkCommand::AcceptFile {
        transfer_id,
        reply: reply_tx,
    })
    .await
    .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Brak odpowiedzi modułu transferu.".to_string())?
}

#[tauri::command]
async fn reject_file(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(NetworkCommand::RejectFile {
        transfer_id,
        reply: reply_tx,
    })
    .await
    .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Brak odpowiedzi modułu transferu.".to_string())?
}

#[tauri::command]
async fn cancel_file(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .map_err(|_| "Błąd blokady stanu")?
        .clone()
        .ok_or("Brak połączenia P2P")?;
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(NetworkCommand::CancelFile {
        transfer_id,
        reply: reply_tx,
    })
    .await
    .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Brak odpowiedzi modułu transferu.".to_string())?
}

#[tauri::command]
async fn disconnect_network(state: State<'_, AppState>) -> Result<(), String> {
    let tx = take_network_sender(state.inner())?;
    if let Some(tx) = tx {
        let _ = tx.send(NetworkCommand::Stop).await;
    }
    Ok(())
}

fn register_bootstrap_target(
    swarm: &mut libp2p::Swarm<Behaviour>,
    raw: &str,
    now: Instant,
) -> Result<BootstrapTarget, String> {
    let mut addr: Multiaddr = raw
        .trim()
        .parse()
        .map_err(|e| format!("Nieprawidłowy adres bootstrap: {e}"))?;
    let peer_id = match addr.iter().last() {
        Some(libp2p::multiaddr::Protocol::P2p(peer)) => peer,
        _ => return Err("Adres bootstrap musi kończyć się /p2p/<PeerId>.".into()),
    };

    let full_addr = addr.clone();
    addr.pop();
    swarm
        .behaviour_mut()
        .kad
        .add_address(&peer_id, addr.clone());
    swarm
        .behaviour_mut()
        .autonat
        .add_server(peer_id.clone(), Some(addr.clone()));
    swarm
        .behaviour_mut()
        .file_transfer
        .add_address(&peer_id, addr);

    Ok(BootstrapTarget::new(
        raw.trim().to_string(),
        peer_id,
        full_addr,
        now,
    ))
}

fn attempt_bootstrap_target(
    swarm: &mut libp2p::Swarm<Behaviour>,
    target: &mut BootstrapTarget,
    now: Instant,
) -> Result<(), String> {
    match swarm.dial(target.full_addr.clone()) {
        Ok(_) => {
            target.mark_dial_started(now);
            Ok(())
        }
        Err(error) => {
            target.mark_failure(now);
            Err(format!("Bootstrap dial {} failed: {error}", target.raw))
        }
    }
}

fn mark_bootstrap_connected(targets: &mut [BootstrapTarget], peer_id: &PeerId) -> bool {
    let mut matched = false;
    for target in targets
        .iter_mut()
        .filter(|target| &target.peer_id == peer_id)
    {
        target.mark_connected();
        matched = true;
    }
    matched
}

fn mark_bootstrap_disconnected(
    targets: &mut [BootstrapTarget],
    peer_id: &PeerId,
    now: Instant,
) -> bool {
    let mut matched = false;
    for target in targets
        .iter_mut()
        .filter(|target| &target.peer_id == peer_id)
    {
        target.mark_disconnected(now);
        matched = true;
    }
    matched
}

fn mark_bootstrap_failed(targets: &mut [BootstrapTarget], peer_id: &PeerId, now: Instant) -> bool {
    let mut matched = false;
    for target in targets
        .iter_mut()
        .filter(|target| &target.peer_id == peer_id)
    {
        target.mark_failure(now);
        matched = true;
    }
    matched
}

fn try_listen_via_relay(swarm: &mut libp2p::Swarm<Behaviour>, raw: &str) -> Result<(), String> {
    let mut addr: Multiaddr = raw
        .trim()
        .parse()
        .map_err(|e| format!("Nieprawidłowy relay: {e}"))?;
    match addr.iter().last() {
        Some(libp2p::multiaddr::Protocol::P2p(_)) => {}
        _ => return Err("Adres relay musi kończyć się /p2p/<PeerId>.".into()),
    }
    addr.push(libp2p::multiaddr::Protocol::P2pCircuit);
    swarm
        .listen_on(addr)
        .map(|_| ())
        .map_err(|e| format!("Nie udało się utworzyć rezerwacji relay: {e}"))
}

fn publish(swarm: &mut libp2p::Swarm<Behaviour>, topic: &gossipsub::IdentTopic, event: &WireEvent) {
    if let Ok(data) = serde_json::to_vec(event) {
        let _ = swarm.behaviour_mut().gossipsub.publish(topic.clone(), data);
    }
}

fn apply_membership_effects(
    app: &impl NetworkRuntime,
    swarm: &mut libp2p::Swarm<Behaviour>,
    topic: &gossipsub::IdentTopic,
    rooms: &mut HashMap<String, RoomInfo>,
    effects: ApplicationMembershipEffects,
) {
    if let Some(snapshot) = effects.publish {
        publish(swarm, topic, &WireEvent::MembershipSnapshot(snapshot));
    }
    for count in effects.counts {
        if let Some(room) = rooms.get_mut(&count.room_id) {
            room.users = Some(count.users);
        }
        let _ = app.emit_event("room-user-count", count);
    }
}

fn membership_gossip_config() -> Result<gossipsub::Config, String> {
    // The default source + sequence-number ID lets repeated signed heartbeats
    // travel through the mesh. Content-only IDs suppress unchanged presence,
    // room announcements and resync snapshots until the duplicate cache expires.
    gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(2))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .build()
        .map_err(|error| error.to_string())
}

fn publish_presence(
    swarm: &mut libp2p::Swarm<Behaviour>,
    topic: &gossipsub::IdentTopic,
    peer_id: &str,
    nick: &str,
    nick_color: &str,
) {
    publish(
        swarm,
        topic,
        &WireEvent::Presence {
            peer_id: peer_id.to_string(),
            nick: nick.to_string(),
            nick_color: Some(nick_color.to_string()),
        },
    );
}

fn publish_nick_lease(
    swarm: &mut libp2p::Swarm<Behaviour>,
    topic: &gossipsub::IdentTopic,
    local_peer: PeerId,
    nick: &str,
    canonical: &str,
) {
    let expires_at = now_ms() + (NICK_LEASE_SECS as u64 * 1000);
    let lease = NickLease {
        peer_id: local_peer.to_string(),
        nick: nick.to_string(),
        canonical: canonical.to_string(),
        expires_at,
    };

    publish(
        swarm,
        topic,
        &WireEvent::NickClaim {
            peer_id: lease.peer_id.clone(),
            nick: lease.nick.clone(),
            canonical: lease.canonical.clone(),
            expires_at,
        },
    );

    if let Ok(value) = serde_json::to_vec(&lease) {
        let mut record = Record::new(nick_record_key(canonical), value);
        record.publisher = Some(local_peer);
        record.expires = Some(Instant::now() + Duration::from_secs(NICK_LEASE_SECS));
        let _ = swarm.behaviour_mut().kad.put_record(record, Quorum::One);
    }
}

fn nick_lease_hint_is_well_formed(lease: &NickLease, record_key: &RecordKey, now: u64) -> bool {
    let Ok(peer) = lease.peer_id.parse::<PeerId>() else {
        return false;
    };
    if peer.to_string() != lease.peer_id {
        return false;
    }
    let Ok(valid_nick) = validate_nick(&lease.nick) else {
        return false;
    };
    let expected_canonical = canonical_nick(&valid_nick);
    if lease.canonical != expected_canonical {
        return false;
    }
    let expected_key = nick_record_key(&expected_canonical);
    if record_key != &expected_key {
        return false;
    }
    let max_expires = now.saturating_add(
        (NICK_LEASE_SECS.saturating_add(NICK_LEASE_CLOCK_SKEW_SECS) as u64).saturating_mul(1000),
    );
    lease.expires_at > now && lease.expires_at <= max_expires
}

fn check_nick_conflict(
    remote_peer: &str,
    remote_canonical: &str,
    remote_expires: u64,
    local_peer: PeerId,
    local_canonical: &str,
) -> bool {
    if remote_expires <= now_ms()
        || remote_canonical != local_canonical
        || remote_peer == local_peer.to_string()
    {
        return false;
    }
    match remote_peer.parse::<PeerId>() {
        Ok(remote) => remote < local_peer,
        Err(_) => false,
    }
}

fn emit_status(
    app: &impl NetworkRuntime,
    swarm: &mut libp2p::Swarm<Behaviour>,
    bootstrap_count: usize,
    nat: &str,
    listen_addresses: &[String],
    detail: impl Into<String>,
) {
    let connected_peers = swarm.connected_peers().count();
    let dht_peers = swarm
        .behaviour_mut()
        .kad
        .kbuckets()
        .map(|b| b.num_entries())
        .sum();
    let status = NetworkStatus {
        phase: if connected_peers > 0 {
            "online".into()
        } else {
            "searching".into()
        },
        connected_peers,
        dht_peers,
        bootstrap_count,
        nat: nat.to_string(),
        listen_addresses: {
            let mut addresses = listen_addresses.to_vec();
            for address in swarm.external_addresses() {
                if let Some(address) = address_for_peer(address.clone(), *swarm.local_peer_id()) {
                    let address = address.to_string();
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
            }
            addresses
        },
        detail: detail.into(),
    };
    let _ = app.emit_event("network-status", status);
}

async fn send_next_chunk(
    swarm: &mut libp2p::Swarm<Behaviour>,
    transfer_id: &str,
    outgoing: &mut HashMap<String, OutgoingTransfer>,
    outbound_requests: &mut HashMap<request_response::OutboundRequestId, OutboundMeta>,
    app: &impl NetworkRuntime,
) -> Result<(), String> {
    let (peer, offset, data, complete_hash) = {
        let transfer = outgoing
            .get_mut(transfer_id)
            .ok_or("Transfer nie istnieje.")?;
        let file = transfer.file.as_mut().ok_or("Plik nie został otwarty.")?;
        let mut buf = vec![0u8; FILE_CHUNK_SIZE];
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Błąd odczytu pliku: {e}"))?;
        if n == 0 {
            let hash = hex::encode(transfer.hasher.clone().finalize());
            (transfer.peer, transfer.sent, Vec::new(), Some(hash))
        } else {
            buf.truncate(n);
            transfer.hasher.update(&buf);
            (transfer.peer, transfer.sent, buf, None)
        }
    };

    if let Some(sha256) = complete_hash {
        let request_id = swarm.behaviour_mut().file_transfer.send_request(
            &peer,
            FileRequest::Complete {
                transfer_id: transfer_id.to_string(),
                sha256,
            },
        );
        outbound_requests.insert(
            request_id,
            OutboundMeta {
                transfer_id: transfer_id.to_string(),
                kind: OutboundKind::Complete,
            },
        );
        if let Some(t) = outgoing.get(transfer_id) {
            emit_transfer(
                app,
                &file_view_outgoing(transfer_id, t, "verifying", None, None),
            );
        }
    } else {
        let request_id = swarm.behaviour_mut().file_transfer.send_request(
            &peer,
            FileRequest::Chunk {
                transfer_id: transfer_id.to_string(),
                offset,
                data,
            },
        );
        outbound_requests.insert(
            request_id,
            OutboundMeta {
                transfer_id: transfer_id.to_string(),
                kind: OutboundKind::Chunk,
            },
        );
    }
    Ok(())
}

async fn network_task(
    nick: String,
    nick_color: String,
    bootstraps: Vec<String>,
    app: impl NetworkRuntime,
    mut rx: mpsc::Receiver<NetworkCommand>,
    ready: oneshot::Sender<Result<String, String>>,
) -> Result<(), String> {
    let mut swarm = SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|e| e.to_string())?
        .with_quic()
        .with_dns()
        .map_err(|e| e.to_string())?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|e| e.to_string())?
        .with_behaviour(|key, relay_client| {
            let local_peer = key.public().to_peer_id();
            let gossipsub_config = membership_gossip_config().map_err(std::io::Error::other)?;
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub_config,
            )
            .map_err(std::io::Error::other)?;
            let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer)?;

            let mut kad_config = kad::Config::new(StreamProtocol::new(KAD_PROTOCOL));
            kad_config.set_periodic_bootstrap_interval(Some(Duration::from_secs(60)));
            kad_config.set_record_ttl(Some(Duration::from_secs(60)));
            kad_config.set_publication_interval(None);
            kad_config.set_replication_interval(Some(Duration::from_secs(20)));
            kad_config.set_provider_publication_interval(Some(Duration::from_secs(25)));
            kad_config.set_provider_record_ttl(Some(Duration::from_secs(75)));
            let kad =
                kad::Behaviour::with_config(local_peer, MemoryStore::new(local_peer), kad_config);

            let identify = identify::Behaviour::new(
                identify::Config::new("/konofix/4.0".into(), key.public())
                    .with_agent_version(format!("Konofix Chat/{}", env!("CARGO_PKG_VERSION")))
                    .with_interval(Duration::from_secs(30))
                    .with_push_listen_addr_updates(true),
            );

            let rr_cfg =
                request_response::Config::default().with_request_timeout(Duration::from_secs(300));
            let file_transfer =
                request_response::cbor::Behaviour::<FileRequest, FileResponse>::with_codec(
                    file_codec(),
                    [(
                        StreamProtocol::new(FILE_PROTOCOL),
                        request_response::ProtocolSupport::Full,
                    )],
                    rr_cfg,
                );

            Ok(Behaviour {
                gossipsub,
                mdns,
                kad,
                identify,
                ping: ping::Behaviour::default(),
                autonat: autonat::Behaviour::new(local_peer, autonat::Config::default()),
                relay_client,
                relay_server: relay::Behaviour::new(local_peer, relay::Config::default()),
                dcutr: dcutr::Behaviour::new(local_peer),
                upnp: upnp::tokio::Behaviour::default(),
                file_transfer,
            })
        })
        .map_err(|e| e.to_string())?
        .build();

    let local_peer = swarm.local_peer_id().to_owned();
    let peer_id = local_peer.to_string();
    let canonical = canonical_nick(&nick);
    let world = gossipsub::IdentTopic::new(WORLD_TOPIC);
    swarm
        .behaviour_mut()
        .gossipsub
        .subscribe(&world)
        .map_err(|e| e.to_string())?;

    swarm
        .listen_on(
            "/ip4/0.0.0.0/tcp/0"
                .parse()
                .map_err(|e: libp2p::multiaddr::Error| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    swarm
        .listen_on(
            "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .map_err(|e: libp2p::multiaddr::Error| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

    let mut peer_cache = app.load_peers();
    let cached_dials = add_cached_peers_to_swarm(&mut swarm, &peer_cache);
    if cached_dials > 0 {
        let _ = app.emit_event(
            "network-log",
            format!("Załadowano {cached_dials} zapamiętanych adresów P2P."),
        );
    }

    let mut bootstrap_targets = Vec::<BootstrapTarget>::new();
    let mut relay_bootstrap_peers = HashSet::<PeerId>::new();
    for address in &bootstraps {
        let now = Instant::now();
        match register_bootstrap_target(&mut swarm, address, now) {
            Ok(mut target) => {
                if relay_bootstrap_peers.insert(target.peer_id.clone()) {
                    if let Err(err) = try_listen_via_relay(&mut swarm, address) {
                        let _ = app.emit_event("network-log", format!("Relay rezerwacja: {err}"));
                    }
                }
                if let Err(err) = attempt_bootstrap_target(&mut swarm, &mut target, now) {
                    let _ = app.emit_event("network-log", err);
                }
                bootstrap_targets.push(target);
            }
            Err(err) => {
                let _ = app.emit_event("network-warning", format!("Bootstrap pominięty: {err}"));
            }
        }
    }
    let mut bootstrap_count = bootstrap_targets.len();
    if bootstrap_count > 0 {
        let _ = swarm.behaviour_mut().kad.bootstrap();
    }

    let _ = swarm
        .behaviour_mut()
        .kad
        .start_providing(world_provider_key());
    swarm
        .behaviour_mut()
        .kad
        .get_providers(world_provider_key());
    swarm
        .behaviour_mut()
        .kad
        .get_record(nick_record_key(&canonical));

    let _ = ready.send(Ok(peer_id.clone()));

    let mut peers: HashMap<PeerId, PeerPresence> = HashMap::new();
    let mut rooms: HashMap<String, RoomInfo> = HashMap::new();
    let mut owned_rooms: HashMap<String, RoomInfo> = HashMap::new();
    let mut membership = RoomMembershipProductionBridge::new(local_peer);
    let mut membership_seen: HashMap<PeerId, Instant> = HashMap::new();
    let mut participant_relays = HashMap::new();
    let mut listen_addresses: Vec<String> = Vec::new();
    let mut nat_status = "unknown".to_string();

    let mut outgoing: HashMap<String, OutgoingTransfer> = HashMap::new();
    let mut pending_incoming: HashMap<String, PendingIncomingOffer> = HashMap::new();
    let mut incoming: HashMap<String, IncomingTransfer> = HashMap::new();
    let mut outbound_requests: HashMap<request_response::OutboundRequestId, OutboundMeta> =
        HashMap::new();

    publish_presence(&mut swarm, &world, &peer_id, &nick, &nick_color);
    publish_nick_lease(&mut swarm, &world, local_peer, &nick, &canonical);

    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    let mut discovery = tokio::time::interval(Duration::from_secs(25));
    let mut bootstrap_retry = tokio::time::interval(Duration::from_secs(BOOTSTRAP_RETRY_TICK_SECS));
    let mut cleanup = tokio::time::interval(Duration::from_secs(8));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    discovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    bootstrap_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    bootstrap_retry.tick().await;

    emit_status(
        &app,
        &mut swarm,
        bootstrap_count,
        &nat_status,
        &listen_addresses,
        "Warstwa P2P uruchomiona",
    );

    'network: loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                publish_presence(&mut swarm, &world, &peer_id, &nick, &nick_color);
                publish_nick_lease(&mut swarm, &world, local_peer, &nick, &canonical);
                for room in owned_rooms.values() {
                    publish(&mut swarm, &world, &WireEvent::RoomCreate(room.clone()));
                }
                apply_membership_effects(&app, &mut swarm, &world, &mut rooms, membership.heartbeat());
                swarm.behaviour_mut().kad.get_record(nick_record_key(&canonical));
            }
            _ = discovery.tick() => {
                let _ = swarm.behaviour_mut().kad.bootstrap();
                swarm.behaviour_mut().kad.get_providers(world_provider_key());
                app.save_peers(&peer_cache);
                emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Odświeżono discovery");
            }
            _ = bootstrap_retry.tick() => {
                let now = Instant::now();
                let mut attempted = 0usize;
                for target in &mut bootstrap_targets {
                    if !target.should_attempt(now) {
                        continue;
                    }
                    attempted += 1;
                    if let Err(err) = attempt_bootstrap_target(&mut swarm, target, now) {
                        let _ = app.emit_event("network-log", err);
                    }
                }
                if attempted > 0 {
                    let _ = swarm.behaviour_mut().kad.bootstrap();
                    swarm.behaviour_mut().kad.get_providers(world_provider_key());
                    let _ = app.emit_event(
                        "network-log",
                        format!("Bootstrap failover: ponowiono {attempted} połączeń."),
                    );
                }
            }
            _ = cleanup.tick() => {
                let expired_memberships: Vec<PeerId> = membership_seen.iter()
                    .filter(|(_, seen)| seen.elapsed() > Duration::from_secs(PRESENCE_TTL_SECS))
                    .map(|(peer, _)| *peer).collect();
                for expired in expired_memberships {
                    membership_seen.remove(&expired);
                    apply_membership_effects(&app, &mut swarm, &world, &mut rooms, membership.presence_expired(&expired));
                }
                let stale: Vec<PeerId> = peers.iter()
                    .filter(|(_, p)| p.last_seen.elapsed() > Duration::from_secs(PRESENCE_TTL_SECS))
                    .map(|(id, _)| id.to_owned())
                    .collect();
                for id in stale {
                    peers.remove(&id);
                    apply_membership_effects(&app, &mut swarm, &world, &mut rooms, membership.presence_expired(&id));
                    let _ = app.emit_event("peer-offline", serde_json::json!({"peer_id": id.to_string()}));
                    let closed: Vec<String> = rooms.values()
                        .filter(|room| room.owner.as_deref() == Some(&id.to_string()))
                        .map(|room| room.id.clone())
                        .collect();
                    for room_id in closed {
                        if let Ok(effects) = membership.room_closed(&room_id) {
                            apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                        }
                        rooms.remove(&room_id);
                        let _ = app.emit_event("room-closed", serde_json::json!({"room_id": room_id}));
                    }
                }

                let now = Instant::now();
                let expired_offers: Vec<String> = pending_incoming
                    .iter()
                    .filter(|(_, offer)| pending_offer_is_expired(offer.created_at, now))
                    .map(|(id, _)| id.clone())
                    .collect();
                for transfer_id in expired_offers {
                    if let Some(offer) = pending_incoming.remove(&transfer_id) {
                        let peer_id = offer.peer.to_string();
                        let _ = swarm.behaviour_mut().file_transfer.send_response(
                            offer.channel,
                            FileResponse::Rejected {
                                reason: "File offer expired before it was accepted.".into(),
                            },
                        );
                        let _ = app.emit_event(
                            "file-offer-expired",
                            serde_json::json!({
                                "transfer_id": transfer_id,
                                "peer_id": peer_id,
                            }),
                        );
                    }
                }

                let expired_incoming: Vec<String> = incoming
                    .iter()
                    .filter(|(_, transfer)| incoming_transfer_is_expired(transfer.last_activity, now))
                    .map(|(id, _)| id.clone())
                    .collect();
                for transfer_id in expired_incoming {
                    if let Some(transfer) = incoming.remove(&transfer_id) {
                        let temp_path = transfer.temp_path.clone();
                        let _ = tokio::fs::remove_file(&temp_path).await;
                        emit_transfer(
                            &app,
                            &file_view_incoming(
                                &transfer_id,
                                &transfer,
                                "failed",
                                None,
                                Some(format!(
                                    "Transfer timed out after {INCOMING_TRANSFER_IDLE_TTL_SECS} seconds without file data."
                                )),
                            ),
                        );
                    }
                }
            }
            Some(cmd) = rx.recv() => {
                match cmd {
                    NetworkCommand::SendMessage { room, text } => {
                        let msg = ChatMessage {
                            id: Uuid::new_v4().to_string(),
                            kind: "chat".into(),
                            peer_id: Some(peer_id.clone()),
                            nick: nick.clone(),
                            nick_color: Some(nick_color.clone()),
                            room,
                            text,
                            timestamp: now_ms(),
                        };
                        let _ = app.emit_event("chat-message", msg.clone());
                        publish(&mut swarm, &world, &WireEvent::Chat(msg));
                    }
                    NetworkCommand::CreateRoom { mut room, reply } => {
                        room.owner = Some(peer_id.clone());
                        let result = room_create_admission(&rooms, &room)
                            .map_err(str::to_string)
                            .and_then(|()| membership.create_and_enter_local_room(&room.id)
                                .map_err(|error| format!("Room creation rejected: {error:?}")));
                        match result {
                            Ok(effects) => {
                                room.users = Some(membership.total_count(&room.id));
                                rooms.insert(room.id.clone(), room.clone());
                                owned_rooms.insert(room.id.clone(), room.clone());
                                let _ = app.emit_event("room-created", room.clone());
                                publish(&mut swarm, &world, &WireEvent::RoomCreate(room.clone()));
                                apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                                let _ = reply.send(Ok(room));
                            }
                            Err(reason) => {
                                let _ = reply.send(Err(reason));
                            }
                        }
                    }
                    NetworkCommand::EnterRoom { room_id, reply } => {
                        let result = if room_id == "world" {
                            membership.enter_world()
                        } else {
                            membership.enter_room(&room_id)
                        };
                        match result {
                            Ok(effects) => {
                                apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                                let _ = reply.send(Ok(()));
                            }
                            Err(error) => {
                                let _ = reply.send(Err(format!("Room switch rejected: {error:?}")));
                            }
                        }
                    }
                    NetworkCommand::AddBootstrap { address, reply } => {
                        let normalized = address.trim().to_string();
                        let result = if bootstrap_targets.iter().any(|target| target.raw == normalized) {
                            Ok(())
                        } else {
                            let now = Instant::now();
                            match register_bootstrap_target(&mut swarm, &normalized, now) {
                                Ok(mut target) => {
                                    if relay_bootstrap_peers.insert(target.peer_id.clone()) {
                                        let _ = try_listen_via_relay(&mut swarm, &normalized);
                                    }
                                    if let Err(err) =
                                        attempt_bootstrap_target(&mut swarm, &mut target, now)
                                    {
                                        let _ = app.emit_event("network-log", err);
                                    }
                                    bootstrap_targets.push(target);
                                    bootstrap_count = bootstrap_targets.len();
                                    let _ = swarm.behaviour_mut().kad.bootstrap();
                                    swarm.behaviour_mut().kad.get_providers(world_provider_key());
                                    Ok(())
                                }
                                Err(error) => Err(error),
                            }
                        };
                        let _ = reply.send(result);
                        emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Zaktualizowano bootstrapy");
                    }
                    NetworkCommand::RefreshDiscovery => {
                        let _ = swarm.behaviour_mut().kad.bootstrap();
                        swarm.behaviour_mut().kad.get_providers(world_provider_key());
                        publish_presence(&mut swarm, &world, &peer_id, &nick, &nick_color);
                    }
                    NetworkCommand::OfferFile { peer_id: target, path, file_name, size, reply } => {
                        let result = (|| -> Result<FileTransferView, String> {
                            if outgoing.len() >= MAX_TRANSFERS_PER_DIRECTION {
                                return Err("Masz już maksymalną liczbę aktywnych transferów wychodzących.".into());
                            }
                            let target_peer: PeerId = target.parse().map_err(|_| "Nieprawidłowy Peer ID odbiorcy.")?;
                            if target_peer == local_peer {
                                return Err("Nie możesz wysłać pliku do siebie.".into());
                            }
                            let target_nick = peers.get(&target_peer).map(|p| p.nick.clone()).unwrap_or_else(|| target.clone());
                            let transfer_id = Uuid::new_v4().to_string();
                            let transfer = OutgoingTransfer {
                                peer: target_peer.clone(),
                                nick: target_nick,
                                file_name: safe_filename(&file_name),
                                path,
                                size,
                                sent: 0,
                                file: None,
                                hasher: Sha256::new(),
                            };
                            let request_id = swarm.behaviour_mut().file_transfer.send_request(
                                &target_peer,
                                FileRequest::Offer {
                                    transfer_id: transfer_id.clone(),
                                    file_name: transfer.file_name.clone(),
                                    size,
                                },
                            );
                            outbound_requests.insert(request_id, OutboundMeta { transfer_id: transfer_id.clone(), kind: OutboundKind::Offer });
                            let view = file_view_outgoing(&transfer_id, &transfer, "waiting", None, None);
                            emit_transfer(&app, &view);
                            outgoing.insert(transfer_id, transfer);
                            Ok(view)
                        })();
                        let _ = reply.send(result);
                    }
                    NetworkCommand::AcceptFile { transfer_id, reply } => {
                        let result = async {
                            if incoming.len() >= MAX_TRANSFERS_PER_DIRECTION {
                                return Err("Masz już maksymalną liczbę aktywnych transferów przychodzących.".to_string());
                            }
                            let pending = pending_incoming.remove(&transfer_id).ok_or("Oferta pliku wygasła albo nie istnieje.")?;
                            let dir = app.downloads()?;
                            tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Nie można utworzyć folderu Pobrane/Konofix Chat: {e}"))?;
                            let reservation = reserve_incoming_file(&dir, &pending.file_name).await?;
                            let transfer = IncomingTransfer {
                                peer: pending.peer,
                                nick: pending.nick,
                                file_name: pending.file_name,
                                size: pending.size,
                                received: 0,
                                file: reservation.file,
                                hasher: Sha256::new(),
                                final_path: reservation.final_path,
                                temp_path: reservation.temp_path.clone(),
                                last_activity: Instant::now(),
                            };
                            if swarm.behaviour_mut().file_transfer.send_response(pending.channel, FileResponse::Accepted).is_err() {
                                let _ = tokio::fs::remove_file(&transfer.temp_path).await;
                                return Err("Nadawca rozłączył się zanim zaakceptowano plik.".to_string());
                            }
                            let view = file_view_incoming(&transfer_id, &transfer, "receiving", None, None);
                            emit_transfer(&app, &view);
                            incoming.insert(transfer_id.clone(), transfer);
                            Ok(view)
                        }.await;
                        let _ = reply.send(result);
                    }
                    NetworkCommand::RejectFile { transfer_id, reply } => {
                        let result = if let Some(pending) = pending_incoming.remove(&transfer_id) {
                            let _ = swarm.behaviour_mut().file_transfer.send_response(
                                pending.channel,
                                FileResponse::Rejected { reason: "Odbiorca odrzucił plik.".into() },
                            );
                            Ok(())
                        } else {
                            Err("Oferta pliku wygasła albo nie istnieje.".into())
                        };
                        let _ = reply.send(result);
                    }
                    NetworkCommand::CancelFile { transfer_id, reply } => {
                        let result = if let Some(transfer) = outgoing.remove(&transfer_id) {
                            outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);
                            let request_id = swarm.behaviour_mut().file_transfer.send_request(
                                &transfer.peer,
                                FileRequest::Cancel { transfer_id: transfer_id.clone() },
                            );
                            outbound_requests.insert(request_id, OutboundMeta { transfer_id: transfer_id.clone(), kind: OutboundKind::Cancel });
                            emit_transfer(&app, &file_view_outgoing(&transfer_id, &transfer, "cancelled", None, None));
                            Ok(())
                        } else if let Some(transfer) = incoming.remove(&transfer_id) {
                            let temp = transfer.temp_path.clone();
                            let peer = transfer.peer;
                            emit_transfer(&app, &file_view_incoming(&transfer_id, &transfer, "cancelled", None, None));
                            let _ = tokio::fs::remove_file(&temp).await;
                            let request_id = swarm.behaviour_mut().file_transfer.send_request(
                                &peer,
                                FileRequest::Cancel { transfer_id: transfer_id.clone() },
                            );
                            outbound_requests.insert(request_id, OutboundMeta { transfer_id: transfer_id.clone(), kind: OutboundKind::Cancel });
                            Ok(())
                        } else {
                            Err("Transfer nie istnieje.".into())
                        };
                        let _ = reply.send(result);
                    }
                    NetworkCommand::Stop => {
                        for room in owned_rooms.values() {
                            publish(&mut swarm, &world, &WireEvent::RoomClose { room_id: room.id.clone(), owner: peer_id.clone() });
                        }
                        publish(&mut swarm, &world, &WireEvent::Goodbye { peer_id: peer_id.clone() });
                        for (id, transfer) in incoming.drain() {
                            let _ = tokio::fs::remove_file(&transfer.temp_path).await;
                            emit_transfer(&app, &file_view_incoming(&id, &transfer, "cancelled", None, Some("Rozłączono z siecią".into())));
                        }
                        app.save_peers(&peer_cache);
                        // Poll the swarm to flush goodbye/room-close frames before shutdown.
                        let _ = tokio::time::timeout(Duration::from_millis(250), async {
                            loop { swarm.select_next_some().await; }
                        }).await;
                        break 'network;
                    }
                }
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let Some(address) = address_for_peer(address, local_peer) else { continue; };
                    let printable = address.to_string();
                    if !listen_addresses.contains(&printable) {
                        listen_addresses.push(printable);
                    }
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Nasłuchiwanie aktywne");
                }
                SwarmEvent::ConnectionEstablished { peer_id: remote, .. } => {
                    swarm.behaviour_mut().gossipsub.add_explicit_peer(&remote);
                    if mark_bootstrap_connected(&mut bootstrap_targets, &remote) {
                        let _ = app.emit_event(
                            "network-log",
                            format!("Bootstrap aktywny: {remote}"),
                        );
                    }
                    publish_presence(&mut swarm, &world, &peer_id, &nick, &nick_color);
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Połączono z peerem");
                }
                SwarmEvent::ConnectionClosed { peer_id: remote, num_established, .. } => {
                    apply_membership_effects(&app, &mut swarm, &world, &mut rooms, membership.connection_closed(&remote, num_established));
                    if num_established == 0 {
                        membership_seen.remove(&remote);
                        if let Some(listener) = participant_relays.remove(&remote) {
                            swarm.remove_listener(listener);
                        }
                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&remote);
                        if mark_bootstrap_disconnected(
                            &mut bootstrap_targets,
                            &remote,
                            Instant::now(),
                        ) {
                            let _ = app.emit_event(
                                "network-log",
                                format!("Bootstrap utracony: {remote}; failover zaplanowany."),
                            );
                        }

                        let pending_from_peer: Vec<String> = pending_incoming
                            .iter()
                            .filter(|(_, offer)| offer.peer == remote)
                            .map(|(id, _)| id.clone())
                            .collect();
                        for transfer_id in pending_from_peer {
                            if pending_incoming.remove(&transfer_id).is_some() {
                                let _ = app.emit_event(
                                    "file-offer-expired",
                                    serde_json::json!({
                                        "transfer_id": transfer_id,
                                        "peer_id": remote.to_string(),
                                    }),
                                );
                            }
                        }

                        let incoming_from_peer: Vec<String> = incoming
                            .iter()
                            .filter(|(_, transfer)| transfer.peer == remote)
                            .map(|(id, _)| id.clone())
                            .collect();
                        for transfer_id in incoming_from_peer {
                            if let Some(transfer) = incoming.remove(&transfer_id) {
                                let temp_path = transfer.temp_path.clone();
                                let _ = tokio::fs::remove_file(&temp_path).await;
                                emit_transfer(
                                    &app,
                                    &file_view_incoming(
                                        &transfer_id,
                                        &transfer,
                                        "failed",
                                        None,
                                        Some("Peer disconnected before the file transfer completed.".into()),
                                    ),
                                );
                            }
                        }

                let outgoing_from_peer: Vec<String> = outgoing
                    .iter()
                    .filter(|(_, candidate)| candidate.peer == remote)
                    .map(|(id, _)| id.clone())
                    .collect();
                outbound_requests.retain(|_, meta| !outgoing_from_peer.contains(&meta.transfer_id));
                for transfer_id in outgoing_from_peer {
                    if let Some(transfer) = outgoing.remove(&transfer_id) {
                        emit_transfer(
                            &app,
                            &file_view_outgoing(
                                &transfer_id,
                                &transfer,
                                "failed",
                                None,
                                Some("Peer disconnected before the outgoing file transfer completed.".into()),
                            ),
                        );
                    }
                }

                    }
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Połączenie z peerem zamknięte");
                }
                SwarmEvent::OutgoingConnectionError {
                    peer_id: Some(remote),
                    error,
                    ..
                } => {
                    if mark_bootstrap_failed(
                        &mut bootstrap_targets,
                        &remote,
                        Instant::now(),
                    ) {
                        let _ = app.emit_event(
                            "network-log",
                            format!("Bootstrap niedostępny {remote}: {error}; retry z backoff."),
                        );
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                    for (id, addr) in list {
                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&id);
                        swarm.behaviour_mut().kad.add_address(&id, addr.clone());
                        swarm.behaviour_mut().file_transfer.add_address(&id, addr.clone());
                        remember_peer_address(&mut peer_cache, id, &addr);
                        if !swarm.is_connected(&id) {
                            if let Some(address) = address_for_peer(addr, id) {
                                let _ = swarm.dial(address);
                            }
                        }
                    }
                    publish_presence(&mut swarm, &world, &peer_id, &nick, &nick_color);
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                    for (id, addr) in list {
                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&id);
                        swarm.behaviour_mut().kad.remove_address(&id, &addr);
                        swarm.behaviour_mut().file_transfer.remove_address(&id, &addr);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id: remote, info, .. })) => {
                    let offers_relay = info.protocol_version == "/konofix/4.0"
                        && info.protocols.iter().any(|protocol| protocol.as_ref() == "/libp2p/circuit/relay/0.2.0/hop");
                    for addr in info.listen_addrs {
                        swarm.behaviour_mut().kad.add_address(&remote, addr.clone());
                        swarm.behaviour_mut().file_transfer.add_address(&remote, addr.clone());
                        remember_peer_address(&mut peer_cache, remote.clone(), &addr);
                        if offers_relay
                            && participant_relays.len() < MAX_PARTICIPANT_RELAYS
                            && !participant_relays.contains_key(&remote)
                            && !relay_bootstrap_peers.contains(&remote)
                        {
                            if let Some(address) = participant_relay_address(addr, remote) {
                                if let Ok(listener) = swarm.listen_on(address) {
                                    participant_relays.insert(remote, listener);
                                }
                            }
                        }
                    }
                }
                SwarmEvent::ListenerClosed { listener_id, .. } => {
                    participant_relays.retain(|_, listener| *listener != listener_id);
                }
                SwarmEvent::ExpiredListenAddr { address, .. } => {
                    if let Some(address) = address_for_peer(address, local_peer) {
                        listen_addresses.retain(|current| current != &address.to_string());
                    }
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "P2P address expired");
                }
                SwarmEvent::Behaviour(BehaviourEvent::Autonat(event)) => {
                    if let autonat::Event::StatusChanged { old: _, new } = event {
                        nat_status = format!("{new:?}").to_lowercase();
                        emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Zmieniono status NAT");
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Upnp(event)) => {
                    let _ = app.emit_event("network-log", format!("UPnP: {event:?}"));
                }
                SwarmEvent::Behaviour(BehaviourEvent::Dcutr(event)) => {
                    let _ = app.emit_event("network-log", format!("DCUtR: {event:?}"));
                }
                SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed { result, .. })) => {
                    match result {
                        kad::QueryResult::GetProviders(Ok(ok)) => {
                            if let kad::GetProvidersOk::FoundProviders { providers, .. } = ok {
                                for provider in providers {
                                    if provider != local_peer {
                                        let _ = swarm.dial(provider);
                                    }
                                }
                            }
                        }
                        kad::QueryResult::GetRecord(Ok(GetRecordOk::FoundRecord(peer_record))) => {
                            if let Ok(lease) = serde_json::from_slice::<NickLease>(&peer_record.record.value) {
                                // Kademlia metadata and payload Peer IDs are not cryptographic proof of
                                // application-level nickname ownership. Unsigned DHT leases are hints only.
                                if !nick_lease_hint_is_well_formed(&lease, &peer_record.record.key, now_ms()) {
                                    let _ = app.emit_event(
                                        "network-warning",
                                        "Dropped malformed or unbounded DHT nickname hint.",
                                    );
                                }
                            }
                        }
                        _ => {}
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message { message, .. })) => {
                    let Some(authenticated_source) = message.source.as_ref() else {
                        let _ = app.emit_event("network-warning", "Dropped P2P event without an authenticated source Peer ID.");
                        continue;
                    };
                    if let Ok(event) = serde_json::from_slice::<WireEvent>(&message.data) {
                        if !wire_event_matches_source(&event, authenticated_source) {
                            let _ = app.emit_event(
                                "network-warning",
                                format!("Dropped P2P event with forged payload identity from {authenticated_source}."),
                            );
                            continue;
                        }
                        if !wire_event_is_well_formed(&event) {
                            let _ = app.emit_event(
                                "network-warning",
                                format!("Dropped malformed authenticated P2P event from {authenticated_source}."),
                            );
                            continue;
                        }
                        match event {
                            WireEvent::Presence { peer_id: remote_id, nick: remote_nick, nick_color: remote_color } => {
                                if remote_id != peer_id {
                                    let remote_canonical = canonical_nick(&remote_nick);
                                    if check_nick_conflict(&remote_id, &remote_canonical, now_ms() + 30_000, local_peer, &canonical) {
                                        let _ = app.emit_event("nick-conflict", serde_json::json!({"nick": nick, "peer_id": remote_id}));
                                        break 'network;
                                    }
                                    let remote_color = normalize_nick_color(remote_color.as_deref());
                                    if let Ok(pid) = remote_id.parse::<PeerId>() {
                                        peers.insert(pid, PeerPresence {
                                            nick: remote_nick.clone(),
                                            nick_color: remote_color.clone(),
                                            last_seen: Instant::now(),
                                        });
                                    }
                                    let _ = app.emit_event(
                                        "peer-online",
                                        PeerInfo {
                                            peer_id: remote_id,
                                            nick: remote_nick,
                                            nick_color: Some(remote_color),
                                        },
                                    );
                                }
                            }
                            WireEvent::Goodbye { peer_id: remote_id } => {
                                membership_seen.remove(authenticated_source);
                                apply_membership_effects(&app, &mut swarm, &world, &mut rooms, membership.authenticated_goodbye(authenticated_source));
                                if let Ok(pid) = remote_id.parse::<PeerId>() {
                                    peers.remove(&pid);
                                }
                                let _ = app.emit_event("peer-offline", serde_json::json!({"peer_id": remote_id}));
                                let closed: Vec<String> = rooms.values()
                                    .filter(|r| r.owner.as_deref() == Some(&remote_id))
                                    .map(|r| r.id.clone()).collect();
                                for room_id in closed {
                                    if let Ok(effects) = membership.room_closed(&room_id) {
                                        apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                                    }
                                    rooms.remove(&room_id);
                                    let _ = app.emit_event("room-closed", serde_json::json!({"room_id": room_id}));
                                }
                            }
                            WireEvent::NickClaim { peer_id: remote_id, canonical: remote_canonical, expires_at, .. } => {
                                if check_nick_conflict(&remote_id, &remote_canonical, expires_at, local_peer, &canonical) {
                                    let _ = app.emit_event("nick-conflict", serde_json::json!({"nick": nick, "peer_id": remote_id}));
                                    break 'network;
                                }
                            }
                            WireEvent::Chat(msg) => {
                                if msg.peer_id.as_deref() != Some(&peer_id) {
                                    let _ = app.emit_event("chat-message", msg);
                                }
                            }
                            WireEvent::MembershipSnapshot(snapshot) => {
                                if let Ok(effects) = membership.authenticated_snapshot(snapshot, authenticated_source) {
                                    membership_seen.insert(*authenticated_source, Instant::now());
                                    apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                                }
                            }
                            WireEvent::RoomCreate(mut room) => {
                                if room.owner.as_deref() != Some(&peer_id) {
                                    match room_create_admission(&rooms, &room) {
                                        Ok(()) => {
                                            if membership.announce_room(&room.id).is_err() {
                                                continue;
                                            }
                                            // Counts are derived from authenticated membership,
                                            // never from the room owner's advertised number.
                                            room.users = Some(membership.total_count(&room.id));
                                            rooms.insert(room.id.clone(), room.clone());
                                            let _ = app.emit_event("room-created", room);
                                        }
                                        Err(reason) => {
                                            let _ = app.emit_event(
                                                "network-warning",
                                                format!(
                                                    "Dropped room announcement from {authenticated_source}: {reason}"
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                            WireEvent::RoomClose { room_id, owner } => {
                                if rooms.get(&room_id).and_then(|r| r.owner.as_deref()) == Some(owner.as_str()) {
                                    if let Ok(effects) = membership.room_closed(&room_id) {
                                        apply_membership_effects(&app, &mut swarm, &world, &mut rooms, effects);
                                    }
                                    rooms.remove(&room_id);
                                    let _ = app.emit_event("room-closed", serde_json::json!({"room_id": room_id}));
                                }
                            }
                        }
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::FileTransfer(event)) => {
                    match event {
                        request_response::Event::Message { peer, message, .. } => {
                            match message {
                                request_response::Message::Request { request, channel, .. } => {
                                    match request {
                                        FileRequest::Offer { transfer_id, file_name, size } => {
                                            if Uuid::parse_str(&transfer_id).is_err() {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Rejected { reason: "Invalid transfer ID.".into() });
                                                continue;
                                            }
                                            if let Some(reason) = file_offer_name_error(&file_name) {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(
                                                    channel,
                                                    FileResponse::Rejected { reason: reason.into() },
                                                );
                                                continue;
                                            }
                                            if pending_incoming.contains_key(&transfer_id)
                                                || incoming.contains_key(&transfer_id)
                                                || outgoing.contains_key(&transfer_id)
                                            {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Rejected { reason: "Transfer ID is already active.".into() });
                                                continue;
                                            }
                                            if size > MAX_FILE_SIZE {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Rejected { reason: "Plik przekracza limit 32 GiB.".into() });
                                                continue;
                                            }
                                            let pending_from_peer = pending_incoming
                                                .values()
                                                .filter(|offer| offer.peer == peer)
                                                .count();
                                            if let Some(reason) = file_offer_capacity_error(
                                                pending_incoming.len(),
                                                incoming.len(),
                                                pending_from_peer,
                                            ) {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(
                                                    channel,
                                                    FileResponse::Rejected { reason: reason.into() },
                                                );
                                                continue;
                                            }
                                            let remote_nick = peers.get(&peer).map(|p| p.nick.clone()).unwrap_or_else(|| peer.to_string());
                                            let safe = safe_filename(&file_name);
                                            pending_incoming.insert(transfer_id.clone(), PendingIncomingOffer {
                                                peer: peer.clone(),
                                                nick: remote_nick.clone(),
                                                file_name: safe.clone(),
                                                size,
                                                created_at: Instant::now(),
                                                channel,
                                            });
                                            let _ = app.emit_event("file-offer", FileOfferView {
                                                transfer_id,
                                                peer_id: peer.to_string(),
                                                nick: remote_nick,
                                                file_name: safe,
                                                size,
                                            });
                                        }
                                        FileRequest::Chunk { transfer_id, offset, data } => {
                                            let response = if data.is_empty() {
                                                FileResponse::Error { message: "Empty file chunks are not allowed.".into() }
                                            } else if data.len() > FILE_CHUNK_SIZE {
                                                FileResponse::Error { message: "Zbyt duży fragment pliku.".into() }
                                            } else if let Some(transfer) = incoming.get_mut(&transfer_id) {
                                                if transfer.peer != peer {
                                                    FileResponse::Error { message: "Nieprawidłowy nadawca transferu.".into() }
                                                } else if offset != transfer.received {
                                                    FileResponse::Error { message: format!("Nieprawidłowy offset: oczekiwano {}, otrzymano {offset}", transfer.received) }
                                                } else if transfer.received.saturating_add(data.len() as u64) > transfer.size {
                                                    FileResponse::Error { message: "Transfer przekroczył zadeklarowany rozmiar pliku.".into() }
                                                } else {
                                                    match transfer.file.write_all(&data).await {
                                                        Ok(()) => {
                                                            transfer.hasher.update(&data);
                                                            transfer.received += data.len() as u64;
                                                            transfer.last_activity = Instant::now();
                                                            emit_transfer(&app, &file_view_incoming(&transfer_id, transfer, "receiving", None, None));
                                                            FileResponse::Ack { received: transfer.received }
                                                        }
                                                        Err(e) => FileResponse::Error { message: format!("Błąd zapisu: {e}") },
                                                    }
                                                }
                                            } else {
                                                FileResponse::Error { message: "Transfer nie został zaakceptowany lub już wygasł.".into() }
                                            };
                                            let _ = swarm.behaviour_mut().file_transfer.send_response(channel, response);
                                        }
                                        FileRequest::Complete { transfer_id, sha256 } => {
                                            let sender_mismatch = incoming
                                                .get(&transfer_id)
                                                .map(|transfer| transfer.peer != peer)
                                                .unwrap_or(false);
                                            let hash_format_valid = sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit());
                                            let response = if sender_mismatch {
                                                FileResponse::Error { message: "Transfer sender identity mismatch.".into() }
                                            } else if !hash_format_valid {
                                                FileResponse::Error { message: "Invalid SHA-256 digest format.".into() }
                                            } else if let Some(mut transfer) = incoming.remove(&transfer_id) {
                                                let local_hash = hex::encode(transfer.hasher.clone().finalize());
                                                let valid = transfer.received == transfer.size && local_hash.eq_ignore_ascii_case(&sha256);
                                                let temp_path = transfer.temp_path.clone();
                                                let final_path_buf = transfer.final_path.clone();
                                                let completed_path = final_path_buf.to_string_lossy().to_string();
                                                let mut completed_view = file_view_incoming(&transfer_id, &transfer, "completed", Some(completed_path), None);
                                                let mut failed_view = file_view_incoming(&transfer_id, &transfer, "failed", None, None);
                                                let durability_result: std::io::Result<()> = if valid {
                                                    async {
                                                        transfer.file.flush().await?;
                                                        transfer.file.sync_all().await
                                                    }
                                                    .await
                                                } else {
                                                    Ok(())
                                                };
                                                drop(transfer.file);
                                                if valid {
                                                    if let Err(error) = durability_result {
                                                        let _ = tokio::fs::remove_file(&temp_path).await;
                                                        failed_view.error = Some(format!("Nie można utrwalić odebranego pliku przed finalizacją: {error}"));
                                                        emit_transfer(&app, &failed_view);
                                                        file_completion_response(false)
                                                    } else {
                                                        match commit_reserved_file(&temp_path, &final_path_buf).await {
                                                            Ok(()) => {
                                                                completed_view.transferred = completed_view.size;
                                                                completed_view.progress = 100.0;
                                                                emit_transfer(&app, &completed_view);
                                                                file_completion_response(true)
                                                            }
                                                            Err(error) => {
                                                                let _ = tokio::fs::remove_file(&temp_path).await;
                                                                failed_view.error = Some(error);
                                                                emit_transfer(&app, &failed_view);
                                                                file_completion_response(false)
                                                            }
                                                        }
                                                    }
                                                } else {
                                                    let _ = tokio::fs::remove_file(&temp_path).await;
                                                    failed_view.error = Some("Suma SHA-256 nie zgadza się lub rozmiar jest niepoprawny.".into());
                                                    emit_transfer(&app, &failed_view);
                                                    file_completion_response(false)
                                                }
                                            } else {
                                                FileResponse::Error { message: "Transfer nie istnieje.".into() }
                                            };
                                            let _ = swarm.behaviour_mut().file_transfer.send_response(channel, response);
                                        }
                                        FileRequest::Cancel { transfer_id } => {
                                            let pending_matches = pending_incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);
                                            let incoming_matches = incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);
                                            let outgoing_matches = outgoing.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);
                                            let matched = pending_matches || incoming_matches || outgoing_matches;
                                            if pending_matches {
                                                pending_incoming.remove(&transfer_id);
                                                let _ = app.emit_event(
                                                    "file-offer-cancelled",
                                                    serde_json::json!({
                                                        "transfer_id": transfer_id.clone(),
                                                        "peer_id": peer.to_string(),
                                                    }),
                                                );
                                            }
                                            if incoming_matches {
                                                if let Some(transfer) = incoming.remove(&transfer_id) {
                                                    let _ = tokio::fs::remove_file(&transfer.temp_path).await;
                                                    emit_transfer(&app, &file_view_incoming(&transfer_id, &transfer, "cancelled", None, Some("Druga strona anulowała transfer.".into())));
                                                }
                                            }
                                            if outgoing_matches {
                                                outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);
                                                if let Some(transfer) = outgoing.remove(&transfer_id) {
                                                    emit_transfer(&app, &file_view_outgoing(&transfer_id, &transfer, "cancelled", None, Some("Druga strona anulowała transfer.".into())));
                                                }
                                            }
                                            let response = if matched {
                                                FileResponse::Ack { received: 0 }
                                            } else {
                                                FileResponse::Error { message: "Transfer not found for requesting peer.".into() }
                                            };
                                            let _ = swarm.behaviour_mut().file_transfer.send_response(channel, response);
                                        }
                                    }
                                }
                                request_response::Message::Response { request_id, response } => {
                                    let Some(meta) = outbound_requests.remove(&request_id) else { continue; };
                                    if !file_response_matches_outbound_kind(meta.kind, &response) {
                                        if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                            emit_transfer(
                                                &app,
                                                &file_view_outgoing(
                                                    &meta.transfer_id,
                                                    &transfer,
                                                    "failed",
                                                    None,
                                                    Some("Nieoczekiwana odpowiedź P2P dla bieżącego etapu transferu.".into()),
                                                ),
                                            );
                                        }
                                        continue;
                                    }
                                    match meta.kind {
                                        OutboundKind::Offer => {
                                            match response {
                                                FileResponse::Accepted => {
                                                    let path = outgoing.get(&meta.transfer_id).map(|t| t.path.clone());
                                                    if let Some(path) = path {
                                                        match File::open(&path).await {
                                                            Ok(file) => {
                                                                if let Some(transfer) = outgoing.get_mut(&meta.transfer_id) {
                                                                    transfer.file = Some(file);
                                                                    transfer.sent = 0;
                                                                    transfer.hasher = Sha256::new();
                                                                    emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, transfer, "sending", None, None));
                                                                }
                                                            }
                                                            Err(e) => {
                                                                if let Some(failed) = outgoing.remove(&meta.transfer_id) {
                                                                    emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &failed, "failed", None, Some(format!("Nie można otworzyć pliku: {e}"))));
                                                                }
                                                                continue;
                                                            }
                                                        }
                                                    }
                                                    if let Err(e) = send_next_chunk(&mut swarm, &meta.transfer_id, &mut outgoing, &mut outbound_requests, &app).await {
                                                        if let Some(failed) = outgoing.remove(&meta.transfer_id) {
                                                            emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &failed, "failed", None, Some(e)));
                                                        }
                                                    }
                                                }
                                                FileResponse::Rejected { reason } => {
                                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "rejected", None, Some(reason)));
                                                    }
                                                }
                                                FileResponse::Error { message } => {
                                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "failed", None, Some(message)));
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                        OutboundKind::Chunk => {
                                            match response {
                                                FileResponse::Ack { received } => {
                                                    let invalid = outgoing.get(&meta.transfer_id)
                                                        .map(|transfer| received < transfer.sent || received > transfer.size)
                                                        .unwrap_or(true);
                                                    if invalid {
                                                        if let Some(failed) = outgoing.remove(&meta.transfer_id) {
                                                            emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &failed, "failed", None, Some("Odbiorca zwrócił nieprawidłowy postęp transferu.".into())));
                                                        }
                                                        continue;
                                                    }
                                                    if let Some(transfer) = outgoing.get_mut(&meta.transfer_id) {
                                                        transfer.sent = received;
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, transfer, "sending", None, None));
                                                    }
                                                    if let Err(e) = send_next_chunk(&mut swarm, &meta.transfer_id, &mut outgoing, &mut outbound_requests, &app).await {
                                                        if let Some(failed) = outgoing.remove(&meta.transfer_id) {
                                                            emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &failed, "failed", None, Some(e)));
                                                        }
                                                    }
                                                }
                                                FileResponse::Error { message } | FileResponse::Rejected { reason: message } => {
                                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "failed", None, Some(message)));
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                        OutboundKind::Complete => {
                                            match response {
                                                FileResponse::Complete { verified: true, .. } => {
                                                    if let Some(mut transfer) = outgoing.remove(&meta.transfer_id) {
                                                        transfer.sent = transfer.size;
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "completed", None, None));
                                                    }
                                                }
                                                FileResponse::Complete { verified: false, .. } => {
                                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "failed", None, Some("Odbiorca nie potwierdził sumy SHA-256.".into())));
                                                    }
                                                }
                                                FileResponse::Error { message } => {
                                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "failed", None, Some(message)));
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                        OutboundKind::Cancel => {}
                                    }
                                }
                            }
                        }
                        request_response::Event::OutboundFailure { request_id, error, .. } => {
                            if let Some(meta) = outbound_requests.remove(&request_id) {
                                if !matches!(meta.kind, OutboundKind::Cancel) {
                                    if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                        emit_transfer(&app, &file_view_outgoing(&meta.transfer_id, &transfer, "failed", None, Some(format!("Błąd P2P: {error}"))));
                                    }
                                }
                            }
                        }
                        request_response::Event::InboundFailure { peer, error, .. } => {
                            let _ = app.emit_event("network-warning", format!("Błąd odbioru pliku od {peer}: {error}"));
                        }
                        request_response::Event::ResponseSent { .. } => {}
                    }
                }
                _ => {}
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn open_github() -> Result<(), String> {
    const URL: &str = "https://github.com/Swir/Konofix";
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", URL])
            .spawn()
            .map_err(|e| format!("Nie można otworzyć GitHuba: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("Otwórz w przeglądarce: {URL}"))
    }
}

#[cfg(test)]
mod bootstrap_failover_tests {
    use super::*;

    #[test]
    fn bootstrap_pool_manifest_and_retry_are_bounded() {
        let manifest =
            parse_builtin_bootstrap_pool().expect("built-in bootstrap pool should parse");
        assert!(manifest.len() <= MAX_BOOTSTRAP_SOURCES);

        assert_eq!(bootstrap_retry_delay(1), Duration::from_secs(3));
        assert_eq!(bootstrap_retry_delay(2), Duration::from_secs(6));
        assert_eq!(bootstrap_retry_delay(3), Duration::from_secs(12));
        assert_eq!(bootstrap_retry_delay(10), Duration::from_secs(60));
    }

    #[test]
    fn bootstrap_source_dedupe_preserves_priority_order() {
        let values = dedupe_bootstrap_sources(vec![
            " /dns/a.example/tcp/45555/p2p/peer-a ".to_string(),
            "/dns/b.example/tcp/45555/p2p/peer-b".to_string(),
            "/dns/a.example/tcp/45555/p2p/peer-a".to_string(),
            "   ".to_string(),
        ])
        .expect("source list should be accepted");
        assert_eq!(
            values,
            vec![
                "/dns/a.example/tcp/45555/p2p/peer-a".to_string(),
                "/dns/b.example/tcp/45555/p2p/peer-b".to_string(),
            ]
        );
    }

    #[test]
    fn bootstrap_target_schedules_disconnect_and_backoff() {
        let key = libp2p::identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        let address: Multiaddr = format!("/ip4/127.0.0.1/tcp/45555/p2p/{peer}")
            .parse()
            .expect("test multiaddr should parse");
        let now = Instant::now();
        let mut target = BootstrapTarget::new(address.to_string(), peer, address, now);

        assert!(target.should_attempt(now));
        target.mark_dial_started(now);
        assert!(!target.should_attempt(now + Duration::from_secs(19)));
        assert!(target.should_attempt(now + Duration::from_secs(20)));

        target.mark_connected();
        assert!(!target.should_attempt(now + Duration::from_secs(120)));

        target.mark_disconnected(now);
        assert!(!target.should_attempt(now + Duration::from_secs(2)));
        assert!(target.should_attempt(now + Duration::from_secs(3)));

        target.mark_failure(now);
        assert_eq!(target.failures, 1);
        assert!(!target.should_attempt(now + Duration::from_secs(2)));
        assert!(target.should_attempt(now + Duration::from_secs(3)));
    }
}

#[cfg(test)]
mod participant_network_tests {
    use super::*;

    #[test]
    fn remembered_addresses_bind_one_terminal_peer_identity() {
        let peer = PeerId::random();
        let other = PeerId::random();
        let base: Multiaddr = "/ip4/192.168.1.5/tcp/45555".parse().unwrap();
        let full = address_for_peer(base.clone(), peer).unwrap();
        assert_eq!(address_for_peer(full.clone(), peer), Some(full.clone()));
        assert!(address_for_peer(full, other).is_none());
        let relay = participant_relay_address(base, peer).unwrap();
        assert!(participant_relay_address(relay, other).is_none());
        for address in [
            "/ip4/127.0.0.1/tcp/1",
            "/ip4/0.0.0.0/tcp/1",
            "/ip6/::1/tcp/1",
        ] {
            assert!(participant_relay_address(address.parse().unwrap(), peer).is_none());
        }
    }

    #[test]
    fn membership_wire_roundtrip_enforces_source_and_frame_shape() {
        let peer = PeerId::random();
        let event = WireEvent::MembershipSnapshot(MembershipSnapshotPayload {
            peer_id: peer.to_string(),
            revision: 1,
            rooms: vec!["alpha".into()],
        });
        let encoded = serde_json::to_vec(&event).unwrap();
        let decoded: WireEvent = serde_json::from_slice(&encoded).unwrap();
        assert!(wire_event_matches_source(&decoded, &peer));
        assert!(!wire_event_matches_source(&decoded, &PeerId::random()));
        assert!(wire_event_is_well_formed(&decoded));
        let malformed = WireEvent::MembershipSnapshot(MembershipSnapshotPayload {
            peer_id: peer.to_string(),
            revision: 0,
            rooms: vec!["alpha".into()],
        });
        assert!(!wire_event_is_well_formed(&malformed));
    }

    fn gossip_peer() -> libp2p::Swarm<gossipsub::Behaviour> {
        SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|key| {
                gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    membership_gossip_config().unwrap(),
                )
                .unwrap()
            })
            .unwrap()
            .build()
    }

    #[tokio::test]
    async fn identical_signed_resyncs_cross_a_real_peer_connection() {
        let mut sender = gossip_peer();
        let mut receiver = gossip_peer();
        let source = *sender.local_peer_id();
        let topic = gossipsub::IdentTopic::new(WORLD_TOPIC);
        sender.behaviour_mut().subscribe(&topic).unwrap();
        receiver.behaviour_mut().subscribe(&topic).unwrap();
        sender
            .behaviour_mut()
            .add_explicit_peer(receiver.local_peer_id());
        receiver.behaviour_mut().add_explicit_peer(&source);
        sender
            .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
        let mut membership = RoomMembershipProductionBridge::new(*receiver.local_peer_id());
        membership.announce_room("alpha").unwrap();
        let payload =
            serde_json::to_vec(&WireEvent::MembershipSnapshot(MembershipSnapshotPayload {
                peer_id: source.to_string(),
                revision: 7,
                rooms: vec!["alpha".into()],
            }))
            .unwrap();
        let mut received = 0;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                tokio::select! {
                    event = sender.select_next_some() => {
                        if let SwarmEvent::NewListenAddr { address, .. } = event {
                            receiver.dial(address_for_peer(address, source).unwrap()).unwrap();
                        }
                    }
                    event = receiver.select_next_some() => {
                        if let SwarmEvent::Behaviour(gossipsub::Event::Message { message, .. }) = event {
                            assert_eq!(message.source, Some(source));
                            let event: WireEvent = serde_json::from_slice(&message.data).unwrap();
                            assert!(wire_event_matches_source(&event, &source));
                            assert!(wire_event_is_well_formed(&event));
                            let WireEvent::MembershipSnapshot(snapshot) = event else { panic!("wrong event") };
                            let effects = membership.authenticated_snapshot(snapshot, &source).unwrap();
                            assert_eq!(effects.counts.len(), usize::from(received == 0));
                            assert_eq!(membership.total_count("alpha"), 1);
                            received += 1;
                            if received == 2 { break; }
                        }
                    }
                    _ = tick.tick() => {
                        let _ = sender.behaviour_mut().publish(topic.clone(), payload.clone());
                    }
                }
            }
        }).await.expect("fresh signed resyncs must not be content-deduplicated");
    }
}

#[cfg(test)]
mod room_admission_tests {
    use super::*;

    fn room(id: &str, owner: &str) -> RoomInfo {
        RoomInfo {
            id: id.to_string(),
            title: format!("# {id}"),
            owner: Some(owner.to_string()),
            users: Some(1),
        }
    }

    #[test]
    fn foreign_owner_cannot_take_over_existing_room_id() {
        let mut rooms = HashMap::new();
        rooms.insert("alpha".into(), room("alpha", "peer-a"));

        assert!(room_create_admission(&rooms, &room("alpha", "peer-b")).is_err());
    }

    #[test]
    fn same_owner_refresh_is_idempotent_even_at_owner_limit() {
        let mut rooms = HashMap::new();
        for index in 0..MAX_ROOMS_PER_OWNER {
            let id = format!("room-{index}");
            rooms.insert(id.clone(), room(&id, "peer-a"));
        }

        assert!(room_create_admission(&rooms, &room("room-0", "peer-a")).is_ok());
    }

    #[test]
    fn owner_room_limit_rejects_unbounded_announcements() {
        let mut rooms = HashMap::new();
        for index in 0..MAX_ROOMS_PER_OWNER {
            let id = format!("room-{index}");
            rooms.insert(id.clone(), room(&id, "peer-a"));
        }

        assert!(room_create_admission(&rooms, &room("overflow", "peer-a")).is_err());
    }

    #[test]
    fn global_room_limit_rejects_additional_unique_owner() {
        let mut rooms = HashMap::new();
        for index in 0..MAX_ROOMS_TOTAL {
            let id = format!("room-{index}");
            let owner = format!("peer-{index}");
            rooms.insert(id.clone(), room(&id, &owner));
        }

        assert!(room_create_admission(&rooms, &room("overflow", "new-peer")).is_err());
    }
}

#[cfg(test)]
mod network_session_state_tests {
    use super::*;

    #[test]
    fn a_task_can_clear_only_the_sender_it_owns() {
        let state = AppState::default();
        let (first_tx, _first_rx) = mpsc::channel(1);
        let (second_tx, _second_rx) = mpsc::channel(1);

        install_network_sender(&state, first_tx.clone()).expect("first session should install");
        assert!(!clear_network_sender_if_current(&state, &second_tx)
            .expect("foreign cleanup should be observable"));
        let stored = state
            .tx
            .lock()
            .expect("state lock")
            .as_ref()
            .expect("first session should remain")
            .clone();
        assert!(stored.same_channel(&first_tx));

        assert!(clear_network_sender_if_current(&state, &first_tx)
            .expect("owning cleanup should succeed"));
        assert!(state.tx.lock().expect("state lock").is_none());
    }

    #[test]
    fn overlapping_start_is_rejected_and_cleanup_allows_reconnect() {
        let state = AppState::default();
        let (first_tx, _first_rx) = mpsc::channel(1);
        let (second_tx, _second_rx) = mpsc::channel(1);

        install_network_sender(&state, first_tx.clone()).expect("first session should install");
        assert!(install_network_sender(&state, second_tx.clone()).is_err());
        assert!(clear_network_sender_if_current(&state, &first_tx).expect("cleanup should work"));
        install_network_sender(&state, second_tx.clone()).expect("reconnect should install");

        let stored = state
            .tx
            .lock()
            .expect("state lock")
            .as_ref()
            .expect("second session should be active")
            .clone();
        assert!(stored.same_channel(&second_tx));
    }

    #[test]
    fn owned_clean_exit_cleanup_allows_reconnect() {
        let state = AppState::default();
        let (first_tx, _first_rx) = mpsc::channel(1);
        let (second_tx, _second_rx) = mpsc::channel(1);

        install_network_sender(&state, first_tx.clone()).expect("first session should install");
        assert!(clear_network_sender_if_current(&state, &first_tx)
            .expect("clean owner exit should release its session"));
        install_network_sender(&state, second_tx.clone())
            .expect("clean exit should permit immediate reconnect");

        let stored = state
            .tx
            .lock()
            .expect("state lock")
            .as_ref()
            .expect("replacement session should be active")
            .clone();
        assert!(stored.same_channel(&second_tx));
    }

    #[test]
    fn explicit_sender_take_is_idempotent() {
        let state = AppState::default();
        let (tx, _rx) = mpsc::channel(1);
        install_network_sender(&state, tx).expect("session should install");
        assert!(take_network_sender(&state)
            .expect("first take should work")
            .is_some());
        assert!(take_network_sender(&state)
            .expect("second take should work")
            .is_none());
    }
}

#[cfg(test)]
mod file_offer_admission_tests {
    use super::*;

    #[test]
    fn one_peer_cannot_reserve_multiple_pending_slots() {
        assert_eq!(
            file_offer_capacity_error(1, 0, MAX_PENDING_OFFERS_PER_PEER),
            Some("This peer already has a pending file offer.")
        );
    }

    #[test]
    fn global_incoming_capacity_is_still_enforced() {
        assert_eq!(
            file_offer_capacity_error(MAX_TRANSFERS_PER_DIRECTION - 1, 1, 0),
            Some("All incoming file-transfer slots are currently busy.")
        );
        assert_eq!(file_offer_capacity_error(0, 0, 0), None);
    }

    #[test]
    fn inbound_offer_name_limit_is_measured_in_encoded_utf8_bytes() {
        let ascii_at_limit = "a".repeat(MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&ascii_at_limit), None);
        assert_eq!(
            file_offer_name_error(&(ascii_at_limit + "a")),
            Some("File name exceeds the 4096-byte protocol limit.")
        );

        let two_byte_at_limit = "é".repeat(MAX_FILE_OFFER_NAME_BYTES / "é".len());
        assert_eq!(two_byte_at_limit.len(), MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&two_byte_at_limit), None);
        assert!(file_offer_name_error(&(two_byte_at_limit + "é")).is_some());

        let four_byte_at_limit = "🧪".repeat(MAX_FILE_OFFER_NAME_BYTES / "🧪".len());
        assert_eq!(four_byte_at_limit.len(), MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&four_byte_at_limit), None);
        assert!(file_offer_name_error(&(four_byte_at_limit + "🧪")).is_some());
    }

    #[tokio::test]
    async fn request_codec_limit_rejects_oversized_encoded_frames() {
        use futures::io::Cursor;
        use request_response::Codec;

        let protocol = StreamProtocol::new(FILE_PROTOCOL);
        let mut codec = file_codec();
        let mut encoded = Cursor::new(Vec::new());
        codec
            .write_request(
                &protocol,
                &mut encoded,
                FileRequest::Offer {
                    transfer_id: Uuid::new_v4().to_string(),
                    file_name: "a".repeat(MAX_FILE_REQUEST_WIRE_BYTES as usize + 1),
                    size: 0,
                },
            )
            .await
            .unwrap();
        assert!(encoded.get_ref().len() as u64 > MAX_FILE_REQUEST_WIRE_BYTES);
        encoded.set_position(0);
        assert!(codec.read_request(&protocol, &mut encoded).await.is_err());
    }

    #[test]
    fn response_codec_limit_and_completion_ack_preserve_privacy() {
        assert_eq!(MAX_FILE_RESPONSE_WIRE_BYTES, 16 * 1024);
        assert!(MAX_FILE_RESPONSE_WIRE_BYTES < 1024 * 1024);
        for verified in [false, true] {
            match file_completion_response(verified) {
                FileResponse::Complete {
                    verified: actual,
                    path,
                } => {
                    assert_eq!(actual, verified);
                    assert!(
                        path.is_none(),
                        "wire completion must not expose receiver-local paths"
                    );
                }
                _ => unreachable!("completion helper must return FileResponse::Complete"),
            }
        }
    }

    #[test]
    fn pending_offer_ttl_expires_only_after_the_boundary() {
        let now = Instant::now();
        let fresh = now
            .checked_sub(Duration::from_secs(PENDING_FILE_OFFER_TTL_SECS - 1))
            .expect("test Instant must support short subtraction");
        let expired = now
            .checked_sub(Duration::from_secs(PENDING_FILE_OFFER_TTL_SECS))
            .expect("test Instant must support short subtraction");
        assert!(!pending_offer_is_expired(fresh, now));
        assert!(pending_offer_is_expired(expired, now));
    }

    #[test]
    fn accepted_transfer_ttl_expires_only_after_the_boundary() {
        let now = Instant::now();
        let fresh = now
            .checked_sub(Duration::from_secs(INCOMING_TRANSFER_IDLE_TTL_SECS - 1))
            .expect("test Instant must support short subtraction");
        let expired = now
            .checked_sub(Duration::from_secs(INCOMING_TRANSFER_IDLE_TTL_SECS))
            .expect("test Instant must support short subtraction");
        assert!(!incoming_transfer_is_expired(fresh, now));
        assert!(incoming_transfer_is_expired(expired, now));
    }
}

#[cfg(test)]
mod nickname_color_tests {
    use super::*;

    #[test]
    fn palette_accepts_only_reviewed_colors_and_normalizes_case() {
        for color in ALLOWED_NICK_COLORS {
            assert_eq!(normalize_nick_color(Some(color)), *color);
            assert!(optional_nick_color_is_valid(Some(color)));
        }
        assert_eq!(normalize_nick_color(Some("#8fa0ff")), "#8FA0FF");
        assert_eq!(normalize_nick_color(Some("#ffffff")), DEFAULT_NICK_COLOR);
        assert!(!optional_nick_color_is_valid(Some("#ffffff")));
        assert!(optional_nick_color_is_valid(None));
    }
}

#[cfg(test)]
mod nickname_lease_hint_tests {
    use super::*;

    fn test_peer() -> PeerId {
        libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id()
    }

    fn lease(peer: PeerId, nick: &str, expires_at: u64) -> NickLease {
        NickLease {
            peer_id: peer.to_string(),
            nick: nick.to_string(),
            canonical: canonical_nick(nick),
            expires_at,
        }
    }

    #[test]
    fn live_hint_requires_matching_key_identity_and_canonical_nick() {
        let now = 1_000_000u64;
        let lease = lease(test_peer(), "Alice", now + (NICK_LEASE_SECS as u64 * 1000));
        let key = nick_record_key(&lease.canonical);
        assert!(nick_lease_hint_is_well_formed(&lease, &key, now));

        let wrong_key = nick_record_key("mallory");
        assert!(!nick_lease_hint_is_well_formed(&lease, &wrong_key, now));

        let mut wrong_canonical = lease.clone();
        wrong_canonical.canonical = "mallory".into();
        assert!(!nick_lease_hint_is_well_formed(&wrong_canonical, &key, now));

        let mut invalid_peer = lease.clone();
        invalid_peer.peer_id = "not-a-peer-id".into();
        assert!(!nick_lease_hint_is_well_formed(&invalid_peer, &key, now));
    }

    #[test]
    fn hint_expiration_is_fail_closed_and_bounded() {
        let now = 2_000_000u64;
        let expired = lease(test_peer(), "Alice", now);
        let key = nick_record_key(&expired.canonical);
        assert!(!nick_lease_hint_is_well_formed(&expired, &key, now));

        let too_far = lease(
            test_peer(),
            "Alice",
            now + ((NICK_LEASE_SECS + NICK_LEASE_CLOCK_SKEW_SECS + 1) as u64 * 1000),
        );
        assert!(!nick_lease_hint_is_well_formed(&too_far, &key, now));
    }
}

#[cfg(test)]
mod authenticated_event_tests {
    use super::*;

    fn test_peer() -> PeerId {
        libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id()
    }

    #[test]
    fn malformed_authenticated_wire_events_are_rejected() {
        let source = test_peer();
        let source_text = source.to_string();
        let valid_chat = WireEvent::Chat(ChatMessage {
            id: Uuid::new_v4().to_string(),
            kind: "chat".into(),
            peer_id: Some(source_text.clone()),
            nick: "alice".into(),
            nick_color: Some(DEFAULT_NICK_COLOR.into()),
            room: "world".into(),
            text: "hello".into(),
            timestamp: 1,
        });
        assert!(wire_event_is_well_formed(&valid_chat));
        let oversized_chat = WireEvent::Chat(ChatMessage {
            id: Uuid::new_v4().to_string(),
            kind: "chat".into(),
            peer_id: Some(source_text.clone()),
            nick: "alice".into(),
            nick_color: Some(DEFAULT_NICK_COLOR.into()),
            room: "world".into(),
            text: "x".repeat(4001),
            timestamp: 1,
        });
        assert!(!wire_event_is_well_formed(&oversized_chat));
        assert!(!wire_event_is_well_formed(&WireEvent::Presence {
            peer_id: source_text.clone(),
            nick: "<script>".into(),
            nick_color: Some(DEFAULT_NICK_COLOR.into()),
        }));
        assert!(!wire_event_is_well_formed(&WireEvent::Presence {
            peer_id: source_text.clone(),
            nick: "alice".into(),
            nick_color: Some("#FFFFFF".into()),
        }));
        assert!(!wire_event_is_well_formed(&WireEvent::NickClaim {
            peer_id: source_text.clone(),
            nick: "Alice".into(),
            canonical: "mallory".into(),
            expires_at: 1
        }));
        assert!(!wire_event_is_well_formed(&WireEvent::RoomCreate(
            RoomInfo {
                id: "world".into(),
                title: "# world".into(),
                owner: Some(source_text.clone()),
                users: Some(1)
            }
        )));
        assert!(!wire_event_is_well_formed(&WireEvent::RoomCreate(
            RoomInfo {
                id: "different-room".into(),
                title: "# valid room".into(),
                owner: Some(source_text.clone()),
                users: Some(1)
            }
        )));
        assert!(!wire_event_is_well_formed(&WireEvent::RoomClose {
            room_id: "world".into(),
            owner: source_text
        }));
    }

    #[test]
    fn wire_event_payload_identity_must_match_authenticated_source() {
        let source = test_peer();
        let attacker = test_peer();
        let source_text = source.to_string();
        let events = vec![
            WireEvent::Presence {
                peer_id: source_text.clone(),
                nick: "alice".into(),
                nick_color: Some(DEFAULT_NICK_COLOR.into()),
            },
            WireEvent::Goodbye {
                peer_id: source_text.clone(),
            },
            WireEvent::NickClaim {
                peer_id: source_text.clone(),
                nick: "alice".into(),
                canonical: "alice".into(),
                expires_at: 1,
            },
            WireEvent::Chat(ChatMessage {
                id: "message".into(),
                kind: "chat".into(),
                peer_id: Some(source_text.clone()),
                nick: "alice".into(),
                room: "world".into(),
                text: "hello".into(),
                timestamp: 1,
            }),
            WireEvent::RoomCreate(RoomInfo {
                id: "room".into(),
                title: "# room".into(),
                owner: Some(source_text.clone()),
                users: Some(1),
            }),
            WireEvent::RoomClose {
                room_id: "room".into(),
                owner: source_text.clone(),
            },
        ];
        for event in events {
            assert!(wire_event_matches_source(&event, &source));
            assert!(!wire_event_matches_source(&event, &attacker));
        }
        let missing_chat_identity = WireEvent::Chat(ChatMessage {
            id: "message".into(),
            kind: "chat".into(),
            peer_id: None,
            nick: "alice".into(),
            nick_color: Some(DEFAULT_NICK_COLOR.into()),
            room: "world".into(),
            text: "hello".into(),
            timestamp: 1,
        });
        assert!(!wire_event_matches_source(&missing_chat_identity, &source));
        let missing_room_owner = WireEvent::RoomCreate(RoomInfo {
            id: "room".into(),
            title: "# room".into(),
            owner: None,
            users: Some(1),
        });
        assert!(!wire_event_matches_source(&missing_room_owner, &source));
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_network,
            send_message,
            create_room,
            enter_room,
            add_bootstrap,
            refresh_discovery,
            offer_file,
            accept_file,
            reject_file,
            cancel_file,
            disconnect_network,
            open_github
        ])
        .run(tauri::generate_context!())
        .expect("error while running Konofix Chat");
}
