use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
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
use tauri::{AppHandle, Emitter, State};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const WORLD_TOPIC: &str = "konofix/world/v3";
const KAD_PROTOCOL: &str = "/konofix/kad/1.0.0";
const FILE_PROTOCOL: &str = "/konofix/file/1.0.0";
const WORLD_PROVIDER_KEY: &str = "/konofix/world/providers/v1";
const PRESENCE_TTL_SECS: u64 = 38;
const NICK_LEASE_SECS: u64 = 42;
const FILE_CHUNK_SIZE: usize = 256 * 1024;
const MAX_FILE_SIZE: u64 = 32 * 1024 * 1024 * 1024;
const MAX_TRANSFERS_PER_DIRECTION: usize = 4;
const MAX_PENDING_OFFERS_PER_PEER: usize = 1;
const PENDING_FILE_OFFER_TTL_SECS: u64 = 45;

// Production releases can ship community bootstrap peers here.
// They are only discovery entry points; chat/file payloads are not stored there.
const DEFAULT_BOOTSTRAPS: &[&str] = &[];

#[derive(Default)]
struct AppState {
    tx: Mutex<Option<mpsc::Sender<NetworkCommand>>>,
}

#[derive(Debug, Clone, Serialize)]
struct StartResult {
    peer_id: String,
    nick: String,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    id: String,
    kind: String,
    peer_id: Option<String>,
    nick: String,
    room: String,
    text: String,
    timestamp: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PeerInfo {
    peer_id: String,
    nick: String,
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
    expires_at: u128,
}

#[derive(Debug)]
struct PeerPresence {
    nick: String,
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
            let mut full = addr;
            full.push(libp2p::multiaddr::Protocol::P2p(peer.clone()));
            let _ = swarm.dial(full);
            added += 1;
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
    },
    Goodbye {
        peer_id: String,
    },
    NickClaim {
        peer_id: String,
        nick: String,
        canonical: String,
        expires_at: u128,
    },
    Chat(ChatMessage),
    RoomCreate(RoomInfo),
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
        WireEvent::Presence { peer_id, nick } => {
            peer_id.parse::<PeerId>().is_ok() && validate_nick(nick).is_ok()
        }
        WireEvent::Goodbye { peer_id } => peer_id.parse::<PeerId>().is_ok(),
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
}

#[derive(Debug, Clone, Copy)]
enum OutboundKind {
    Offer,
    Chunk,
    Complete,
    Cancel,
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

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn canonical_nick(raw: &str) -> String {
    raw.nfkc().flat_map(char::to_lowercase).collect::<String>()
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

fn bootstrap_sources(extra: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = DEFAULT_BOOTSTRAPS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if let Ok(env) = std::env::var("KONOFIX_BOOTSTRAPS") {
        out.extend(
            env.split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        );
    }
    out.extend(
        extra
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    );
    out.sort();
    out.dedup();
    out
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

fn unique_download_path(dir: &Path, file_name: &str) -> PathBuf {
    let safe = safe_filename(file_name);
    let original = Path::new(&safe);
    let stem = original
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("plik");
    let ext = original.extension().and_then(|v| v.to_str());

    for n in 0..10_000u32 {
        let candidate_name = if n == 0 {
            safe.clone()
        } else if let Some(ext) = ext {
            format!("{stem} ({n}).{ext}")
        } else {
            format!("{stem} ({n})")
        };
        let candidate = dir.join(candidate_name);
        let candidate_basename = candidate
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("file");
        if !candidate.exists()
            && !candidate
                .with_file_name(format!("{candidate_basename}.konofixpart"))
                .exists()
        {
            return candidate;
        }
    }
    dir.join(format!("{}-{}", Uuid::new_v4(), safe))
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

fn emit_transfer(app: &AppHandle, transfer: &FileTransferView) {
    let _ = app.emit("file-transfer", transfer.clone());
}

#[tauri::command]
async fn start_network(
    nick: String,
    bootstraps: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartResult, String> {
    let nick = validate_nick(&nick)?;
    if state.tx.lock().map_err(|_| "Błąd blokady stanu")?.is_some() {
        return Err("Sieć jest już uruchomiona.".into());
    }

    let (tx, rx) = mpsc::channel(128);
    *state.tx.lock().map_err(|_| "Błąd blokady stanu")? = Some(tx);

    let (ready_tx, ready_rx) = oneshot::channel();
    let nick_for_task = nick.clone();
    let bootstrap_list = bootstrap_sources(bootstraps.unwrap_or_default());
    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            network_task(nick_for_task, bootstrap_list, app.clone(), rx, ready_tx).await
        {
            let _ = app.emit("network-error", err);
        }
    });

    let ready_result = ready_rx
        .await
        .map_err(|_| "Nie udało się uruchomić warstwy P2P.".to_string())?;

    match ready_result {
        Ok(peer_id) => Ok(StartResult {
            peer_id,
            nick,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }),
        Err(err) => {
            let _ = state.tx.lock().map(|mut guard| guard.take());
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
    tx.send(NetworkCommand::CreateRoom { room: room.clone() })
        .await
        .map_err(|_| "Warstwa P2P została zatrzymana.".to_string())?;
    Ok(room)
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
    let tx = state.tx.lock().map_err(|_| "Błąd blokady stanu")?.take();
    if let Some(tx) = tx {
        let _ = tx.send(NetworkCommand::Stop).await;
    }
    Ok(())
}

fn add_bootstrap_to_swarm(swarm: &mut libp2p::Swarm<Behaviour>, raw: &str) -> Result<(), String> {
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
    let _ = swarm.dial(full_addr);
    Ok(())
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

fn publish_presence(
    swarm: &mut libp2p::Swarm<Behaviour>,
    topic: &gossipsub::IdentTopic,
    peer_id: &str,
    nick: &str,
) {
    publish(
        swarm,
        topic,
        &WireEvent::Presence {
            peer_id: peer_id.to_string(),
            nick: nick.to_string(),
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
    let expires_at = now_ms() + (NICK_LEASE_SECS as u128 * 1000);
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

fn check_nick_conflict(
    remote_peer: &str,
    remote_canonical: &str,
    remote_expires: u128,
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
    app: &AppHandle,
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
        listen_addresses: listen_addresses.to_vec(),
        detail: detail.into(),
    };
    let _ = app.emit("network-status", status);
}

async fn send_next_chunk(
    swarm: &mut libp2p::Swarm<Behaviour>,
    transfer_id: &str,
    outgoing: &mut HashMap<String, OutgoingTransfer>,
    outbound_requests: &mut HashMap<request_response::OutboundRequestId, OutboundMeta>,
    app: &AppHandle,
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
    bootstraps: Vec<String>,
    app: AppHandle,
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
            let message_id_fn = |message: &gossipsub::Message| {
                let mut h = DefaultHasher::new();
                message.data.hash(&mut h);
                gossipsub::MessageId::from(h.finish().to_string())
            };
            let gossipsub_config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(2))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .message_id_fn(message_id_fn)
                .build()
                .map_err(std::io::Error::other)?;
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
            let file_transfer = request_response::cbor::Behaviour::<FileRequest, FileResponse>::new(
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

    let mut peer_cache = load_peer_cache();
    let cached_dials = add_cached_peers_to_swarm(&mut swarm, &peer_cache);
    if cached_dials > 0 {
        let _ = app.emit(
            "network-log",
            format!("Załadowano {cached_dials} zapamiętanych adresów P2P."),
        );
    }

    let mut bootstrap_count = 0usize;
    for address in &bootstraps {
        match add_bootstrap_to_swarm(&mut swarm, address) {
            Ok(()) => {
                bootstrap_count += 1;
                if let Err(err) = try_listen_via_relay(&mut swarm, address) {
                    let _ = app.emit("network-log", format!("Relay rezerwacja: {err}"));
                }
            }
            Err(err) => {
                let _ = app.emit("network-warning", format!("Bootstrap pominięty: {err}"));
            }
        }
    }
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
    let mut listen_addresses: Vec<String> = Vec::new();
    let mut nat_status = "unknown".to_string();

    let mut outgoing: HashMap<String, OutgoingTransfer> = HashMap::new();
    let mut pending_incoming: HashMap<String, PendingIncomingOffer> = HashMap::new();
    let mut incoming: HashMap<String, IncomingTransfer> = HashMap::new();
    let mut outbound_requests: HashMap<request_response::OutboundRequestId, OutboundMeta> =
        HashMap::new();

    publish_presence(&mut swarm, &world, &peer_id, &nick);
    publish_nick_lease(&mut swarm, &world, local_peer, &nick, &canonical);

    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    let mut discovery = tokio::time::interval(Duration::from_secs(25));
    let mut cleanup = tokio::time::interval(Duration::from_secs(8));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    discovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                publish_presence(&mut swarm, &world, &peer_id, &nick);
                publish_nick_lease(&mut swarm, &world, local_peer, &nick, &canonical);
                swarm.behaviour_mut().kad.get_record(nick_record_key(&canonical));
            }
            _ = discovery.tick() => {
                let _ = swarm.behaviour_mut().kad.bootstrap();
                swarm.behaviour_mut().kad.get_providers(world_provider_key());
                save_peer_cache(&peer_cache);
                emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Odświeżono discovery");
            }
            _ = cleanup.tick() => {
                let stale: Vec<PeerId> = peers.iter()
                    .filter(|(_, p)| p.last_seen.elapsed() > Duration::from_secs(PRESENCE_TTL_SECS))
                    .map(|(id, _)| id.to_owned())
                    .collect();
                for id in stale {
                    peers.remove(&id);
                    let _ = app.emit("peer-offline", serde_json::json!({"peer_id": id.to_string()}));
                    let closed: Vec<String> = rooms.values()
                        .filter(|room| room.owner.as_deref() == Some(&id.to_string()))
                        .map(|room| room.id.clone())
                        .collect();
                    for room_id in closed {
                        rooms.remove(&room_id);
                        let _ = app.emit("room-closed", serde_json::json!({"room_id": room_id}));
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
                        let _ = app.emit(
                            "file-offer-expired",
                            serde_json::json!({
                                "transfer_id": transfer_id,
                                "peer_id": peer_id,
                            }),
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
                            room,
                            text,
                            timestamp: now_ms(),
                        };
                        let _ = app.emit("chat-message", msg.clone());
                        publish(&mut swarm, &world, &WireEvent::Chat(msg));
                    }
                    NetworkCommand::CreateRoom { mut room } => {
                        room.owner = Some(peer_id.clone());
                        rooms.insert(room.id.clone(), room.clone());
                        owned_rooms.insert(room.id.clone(), room.clone());
                        let _ = app.emit("room-created", room.clone());
                        publish(&mut swarm, &world, &WireEvent::RoomCreate(room));
                    }
                    NetworkCommand::AddBootstrap { address, reply } => {
                        let result = add_bootstrap_to_swarm(&mut swarm, &address);
                        if result.is_ok() {
                            bootstrap_count += 1;
                            let _ = try_listen_via_relay(&mut swarm, &address);
                            let _ = swarm.behaviour_mut().kad.bootstrap();
                            swarm.behaviour_mut().kad.get_providers(world_provider_key());
                        }
                        let _ = reply.send(result);
                        emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Zaktualizowano bootstrapy");
                    }
                    NetworkCommand::RefreshDiscovery => {
                        let _ = swarm.behaviour_mut().kad.bootstrap();
                        swarm.behaviour_mut().kad.get_providers(world_provider_key());
                        publish_presence(&mut swarm, &world, &peer_id, &nick);
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
                            let dir = download_directory()?;
                            tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Nie można utworzyć folderu Pobrane/Konofix Chat: {e}"))?;
                            let final_path = unique_download_path(&dir, &pending.file_name);
                            let final_basename = final_path.file_name().and_then(|v| v.to_str()).unwrap_or("file");
                            let temp_name = format!("{final_basename}.konofixpart");
                            let temp_path = final_path.with_file_name(temp_name);
                            let file = File::create(&temp_path).await.map_err(|e| format!("Nie można utworzyć pliku tymczasowego: {e}"))?;
                            let transfer = IncomingTransfer {
                                peer: pending.peer,
                                nick: pending.nick,
                                file_name: pending.file_name,
                                size: pending.size,
                                received: 0,
                                file,
                                hasher: Sha256::new(),
                                final_path,
                                temp_path: temp_path.clone(),
                            };
                            if swarm.behaviour_mut().file_transfer.send_response(pending.channel, FileResponse::Accepted).is_err() {
                                let _ = tokio::fs::remove_file(&temp_path).await;
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
                        save_peer_cache(&peer_cache);
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        break 'network;
                    }
                }
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let printable = format!("{address}/p2p/{peer_id}");
                    if !listen_addresses.contains(&printable) {
                        listen_addresses.push(printable);
                    }
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Nasłuchiwanie aktywne");
                }
                SwarmEvent::ConnectionEstablished { peer_id: remote, .. } => {
                    swarm.behaviour_mut().gossipsub.add_explicit_peer(&remote);
                    publish_presence(&mut swarm, &world, &peer_id, &nick);
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Połączono z peerem");
                }
                SwarmEvent::ConnectionClosed { peer_id: remote, num_established, .. } => {
                    if num_established == 0 {
                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&remote);
                    }
                    emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Połączenie z peerem zamknięte");
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                    for (id, addr) in list {
                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&id);
                        swarm.behaviour_mut().kad.add_address(&id, addr.clone());
                        swarm.behaviour_mut().file_transfer.add_address(&id, addr.clone());
                        remember_peer_address(&mut peer_cache, id, &addr);
                    }
                    publish_presence(&mut swarm, &world, &peer_id, &nick);
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                    for (id, addr) in list {
                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&id);
                        swarm.behaviour_mut().kad.remove_address(&id, &addr);
                        swarm.behaviour_mut().file_transfer.remove_address(&id, &addr);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id: remote, info, .. })) => {
                    for addr in info.listen_addrs {
                        swarm.behaviour_mut().kad.add_address(&remote, addr.clone());
                        swarm.behaviour_mut().file_transfer.add_address(&remote, addr.clone());
                        remember_peer_address(&mut peer_cache, remote.clone(), &addr);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Autonat(event)) => {
                    if let autonat::Event::StatusChanged { old: _, new } = event {
                        nat_status = format!("{new:?}").to_lowercase();
                        emit_status(&app, &mut swarm, bootstrap_count, &nat_status, &listen_addresses, "Zmieniono status NAT");
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Upnp(event)) => {
                    let _ = app.emit("network-log", format!("UPnP: {event:?}"));
                }
                SwarmEvent::Behaviour(BehaviourEvent::Dcutr(event)) => {
                    let _ = app.emit("network-log", format!("DCUtR: {event:?}"));
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
                                if check_nick_conflict(&lease.peer_id, &lease.canonical, lease.expires_at, local_peer, &canonical) {
                                    let _ = app.emit("nick-conflict", serde_json::json!({"nick": nick, "peer_id": lease.peer_id}));
                                    break 'network;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message { message, .. })) => {
                    let Some(authenticated_source) = message.source.as_ref() else {
                        let _ = app.emit("network-warning", "Dropped P2P event without an authenticated source Peer ID.");
                        continue;
                    };
                    if let Ok(event) = serde_json::from_slice::<WireEvent>(&message.data) {
                        if !wire_event_matches_source(&event, authenticated_source) {
                            let _ = app.emit(
                                "network-warning",
                                format!("Dropped P2P event with forged payload identity from {authenticated_source}."),
                            );
                            continue;
                        }
                        if !wire_event_is_well_formed(&event) {
                            let _ = app.emit(
                                "network-warning",
                                format!("Dropped malformed authenticated P2P event from {authenticated_source}."),
                            );
                            continue;
                        }
                        match event {
                            WireEvent::Presence { peer_id: remote_id, nick: remote_nick } => {
                                if remote_id != peer_id {
                                    let remote_canonical = canonical_nick(&remote_nick);
                                    if check_nick_conflict(&remote_id, &remote_canonical, now_ms() + 30_000, local_peer, &canonical) {
                                        let _ = app.emit("nick-conflict", serde_json::json!({"nick": nick, "peer_id": remote_id}));
                                        break 'network;
                                    }
                                    if let Ok(pid) = remote_id.parse::<PeerId>() {
                                        peers.insert(pid, PeerPresence { nick: remote_nick.clone(), last_seen: Instant::now() });
                                    }
                                    let _ = app.emit("peer-online", PeerInfo { peer_id: remote_id, nick: remote_nick });
                                }
                            }
                            WireEvent::Goodbye { peer_id: remote_id } => {
                                if let Ok(pid) = remote_id.parse::<PeerId>() {
                                    peers.remove(&pid);
                                }
                                let _ = app.emit("peer-offline", serde_json::json!({"peer_id": remote_id}));
                                let closed: Vec<String> = rooms.values()
                                    .filter(|r| r.owner.as_deref() == Some(&remote_id))
                                    .map(|r| r.id.clone()).collect();
                                for room_id in closed {
                                    rooms.remove(&room_id);
                                    let _ = app.emit("room-closed", serde_json::json!({"room_id": room_id}));
                                }
                            }
                            WireEvent::NickClaim { peer_id: remote_id, canonical: remote_canonical, expires_at, .. } => {
                                if check_nick_conflict(&remote_id, &remote_canonical, expires_at, local_peer, &canonical) {
                                    let _ = app.emit("nick-conflict", serde_json::json!({"nick": nick, "peer_id": remote_id}));
                                    break 'network;
                                }
                            }
                            WireEvent::Chat(msg) => {
                                if msg.peer_id.as_deref() != Some(&peer_id) {
                                    let _ = app.emit("chat-message", msg);
                                }
                            }
                            WireEvent::RoomCreate(room) => {
                                if room.owner.as_deref() != Some(&peer_id) {
                                    rooms.insert(room.id.clone(), room.clone());
                                    let _ = app.emit("room-created", room);
                                }
                            }
                            WireEvent::RoomClose { room_id, owner } => {
                                if rooms.get(&room_id).and_then(|r| r.owner.as_deref()) == Some(owner.as_str()) {
                                    rooms.remove(&room_id);
                                    let _ = app.emit("room-closed", serde_json::json!({"room_id": room_id}));
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
                                            let _ = app.emit("file-offer", FileOfferView {
                                                transfer_id,
                                                peer_id: peer.to_string(),
                                                nick: remote_nick,
                                                file_name: safe,
                                                size,
                                            });
                                        }
                                        FileRequest::Chunk { transfer_id, offset, data } => {
                                            let response = if data.len() > FILE_CHUNK_SIZE {
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
                                                let mut completed_view = file_view_incoming(&transfer_id, &transfer, "completed", Some(completed_path.clone()), None);
                                                let mut failed_view = file_view_incoming(&transfer_id, &transfer, "failed", None, None);
                                                let _ = transfer.file.flush().await;
                                                drop(transfer.file);
                                                if valid {
                                                    match tokio::fs::rename(&temp_path, &final_path_buf).await {
                                                        Ok(()) => {
                                                            completed_view.transferred = completed_view.size;
                                                            completed_view.progress = 100.0;
                                                            emit_transfer(&app, &completed_view);
                                                            FileResponse::Complete { verified: true, path: Some(completed_path) }
                                                        }
                                                        Err(e) => {
                                                            let _ = tokio::fs::remove_file(&temp_path).await;
                                                            failed_view.error = Some(format!("Nie można zapisać pliku: {e}"));
                                                            emit_transfer(&app, &failed_view);
                                                            FileResponse::Complete { verified: false, path: None }
                                                        }
                                                    }
                                                } else {
                                                    let _ = tokio::fs::remove_file(&temp_path).await;
                                                    failed_view.error = Some("Suma SHA-256 nie zgadza się lub rozmiar jest niepoprawny.".into());
                                                    emit_transfer(&app, &failed_view);
                                                    FileResponse::Complete { verified: false, path: None }
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

                                            if pending_matches { pending_incoming.remove(&transfer_id); }

                                            if incoming_matches {

                                                if let Some(transfer) = incoming.remove(&transfer_id) {

                                                    let _ = tokio::fs::remove_file(&transfer.temp_path).await;

                                                    emit_transfer(&app, &file_view_incoming(&transfer_id, &transfer, "cancelled", None, Some("Druga strona anulowała transfer.".into())));

                                                }

                                            }

                                            if outgoing_matches {

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
                            let _ = app.emit("network-warning", format!("Błąd odbioru pliku od {peer}: {error}"));
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
            room: "world".into(),
            text: "x".repeat(4001),
            timestamp: 1,
        });
        assert!(!wire_event_is_well_formed(&oversized_chat));
        assert!(!wire_event_is_well_formed(&WireEvent::Presence {
            peer_id: source_text.clone(),
            nick: "<script>".into()
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
