use std::{
    collections::HashSet,
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use futures::StreamExt;
use libp2p::{
    autonat, gossipsub, identify, identity,
    kad::{self, store::MemoryStore},
    noise, ping, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, PeerId, StreamProtocol, SwarmBuilder,
};
use serde::Serialize;

const WORLD_TOPIC: &str = "konofix/world/v3";
const KAD_PROTOCOL: &str = "/konofix/kad/1.0.0";
const WORLD_PROVIDER_KEY: &str = "/konofix/world/providers/v1";
const DEFAULT_PORT: u16 = 45555;
const DEFAULT_STATUS_INTERVAL: u64 = 60;
const SOURCE_COMMIT: &str = env!("KONOFIX_SOURCE_COMMIT");

#[derive(Debug)]
struct NodeArgs {
    port: u16,
    public_host: Option<String>,
    allow_private_address: bool,
    status_interval: u64,
    health_file: Option<PathBuf>,
    identity_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicHostClassification {
    DnsName,
    GlobalIp,
    NonGlobalIp,
}

#[derive(Debug, Serialize)]
struct HealthSnapshot<'a> {
    schema: u8,
    status: &'a str,
    version: &'a str,
    source_commit: &'a str,
    peer_id: String,
    uptime_seconds: u64,
    connected_peers: usize,
    timestamp_unix: u64,
}

#[derive(NetworkBehaviour)]
struct NodeBehaviour {
    gossipsub: gossipsub::Behaviour,
    kad: kad::Behaviour<MemoryStore>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    autonat: autonat::Behaviour,
    relay: relay::Behaviour,
}

fn default_identity_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Konofix Chat")
        .join("node-identity.key")
}

#[cfg(unix)]
fn harden_identity_permissions(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        format!(
            "Failed to inspect identity file permissions {}: {error}",
            path.display()
        )
    })?;
    let mut permissions = metadata.permissions();
    let current_mode = permissions.mode();
    let protected_mode = current_mode & !0o077;
    if current_mode != protected_mode {
        permissions.set_mode(protected_mode);
        std::fs::set_permissions(path, permissions).map_err(|error| {
            format!(
                "Failed to restrict identity file permissions {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_identity_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn decode_identity(path: &Path, data: &[u8]) -> Result<identity::Keypair, String> {
    identity::Keypair::from_protobuf_encoding(data).map_err(|error| {
        format!(
            "Identity file {} is invalid; refusing to replace it because that would change the public Node Peer ID: {error}",
            path.display()
        )
    })
}

fn load_existing_identity(path: &Path) -> Result<identity::Keypair, String> {
    let data = std::fs::read(path)
        .map_err(|error| format!("Failed to read identity file {}: {error}", path.display()))?;
    harden_identity_permissions(path)?;
    decode_identity(path, &data)
}

fn load_identity_after_create_race(path: &Path) -> Result<identity::Keypair, String> {
    let mut last_error = None;
    for _ in 0..20 {
        match load_existing_identity(path) {
            Ok(key) => return Ok(key),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(format!(
        "Identity file {} appeared concurrently but could not be loaded safely: {}",
        path.display(),
        last_error.unwrap_or_else(|| "unknown identity load error".into())
    ))
}

fn load_or_create_identity(path: &Path) -> Result<identity::Keypair, String> {
    match std::fs::read(path) {
        Ok(data) => {
            harden_identity_permissions(path)?;
            return decode_identity(path, &data);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to read identity file {}: {error}",
                path.display()
            ))
        }
    }

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create identity directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let key = identity::Keypair::generate_ed25519();
    let encoded = key
        .to_protobuf_encoding()
        .map_err(|error| format!("Failed to encode generated Node identity: {error}"))?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return load_identity_after_create_race(path)
        }
        Err(error) => {
            return Err(format!(
                "Failed to create identity file {}: {error}",
                path.display()
            ))
        }
    };

    if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(format!(
            "Failed to persist identity file {}: {error}",
            path.display()
        ));
    }

    harden_identity_permissions(path)?;
    Ok(key)
}

fn lexically_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Failed to resolve current directory: {error}"))?
            .join(path)
    };

    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn comparable_path(path: &Path) -> Result<PathBuf, String> {
    let normalized = lexically_normalize_absolute(path)?;
    if normalized.exists() {
        return std::fs::canonicalize(&normalized).map_err(|error| {
            format!(
                "Failed to resolve state path {}: {error}",
                normalized.display()
            )
        });
    }

    // Resolve the nearest existing ancestor so aliases through directory symlinks/junctions
    // are still detected even when the final state file has not been created yet.
    let mut cursor = normalized.as_path();
    let mut suffix = Vec::new();
    while !cursor.exists() {
        let name = cursor.file_name().ok_or_else(|| {
            format!(
                "Could not resolve a parent for state path {}",
                normalized.display()
            )
        })?;
        suffix.push(name.to_os_string());
        cursor = cursor.parent().ok_or_else(|| {
            format!(
                "Could not resolve a parent for state path {}",
                normalized.display()
            )
        })?;
    }

    let mut resolved = std::fs::canonicalize(cursor).map_err(|error| {
        format!(
            "Failed to resolve state path ancestor {}: {error}",
            cursor.display()
        )
    })?;
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> Result<bool, String> {
    let left = comparable_path(left)?.to_string_lossy().to_lowercase();
    let right = comparable_path(right)?.to_string_lossy().to_lowercase();
    Ok(left == right)
}

#[cfg(not(windows))]
fn same_path(left: &Path, right: &Path) -> Result<bool, String> {
    Ok(comparable_path(left)? == comparable_path(right)?)
}

fn validate_state_paths(identity_path: &Path, health_path: Option<&Path>) -> Result<(), String> {
    let Some(health_path) = health_path else {
        return Ok(());
    };

    if same_path(identity_path, health_path)? {
        return Err(format!(
            "Identity and health files resolve to the same path ({}). Refusing to start because health telemetry could overwrite the persistent Node identity.",
            identity_path.display()
        ));
    }

    if let Ok(executable) = std::env::current_exe() {
        if same_path(health_path, &executable)? {
            return Err(format!(
                "Health file resolves to the running Konofix Node executable ({}). Refusing to start.",
                executable.display()
            ));
        }
        if same_path(identity_path, &executable)? {
            return Err(format!(
                "Identity file resolves to the running Konofix Node executable ({}). Refusing to start.",
                executable.display()
            ));
        }
    }

    Ok(())
}

fn provider_key() -> kad::RecordKey {
    let bytes = WORLD_PROVIDER_KEY.as_bytes().to_vec();
    kad::RecordKey::new(&bytes)
}

fn print_help() {
    println!("Konofix Node {}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage:");
    println!("  konofix-node.exe [--port 45555] [--public-host HOST] [--allow-private-address] [--status-interval 60] [--health-file PATH] [--identity-file PATH]");
    println!();
    println!("Options:");
    println!("  --port PORT              TCP and UDP/QUIC port (default: 45555)");
    println!("  --public-host HOST       Public IPv4, IPv6, or DNS name of this node");
    println!("  --public-ip IP           Alias for --public-host");
    println!("  --allow-private-address  Permit non-global IP literals for controlled lab testing only; never valid as public-node evidence");
    println!("  --status-interval SEC    Print an operational status line every N seconds (default: 60, minimum: 10)");
    println!("  --health-file PATH       Atomically update a metadata-only JSON health snapshot");
    println!("  --identity-file PATH     Explicit persistent Node identity file (recommended for public/community nodes)");
    println!("  -h, --help               Show this help");
    println!();
    println!("Example:");
    println!("  konofix-node.exe --port 45555 --public-host node.yourdomain.com --status-interval 60 --health-file C:\\Konofix\\health.json --identity-file C:\\Konofix\\node-identity.key");
}

fn parse_args_from<I>(args: I) -> Result<Option<NodeArgs>, String>
where
    I: IntoIterator<Item = String>,
{
    let mut port = DEFAULT_PORT;
    let mut public_host = None;
    let mut allow_private_address = false;
    let mut status_interval = DEFAULT_STATUS_INTERVAL;
    let mut health_file = None;
    let mut identity_file = None;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let raw = args.next().ok_or("Missing value after --port")?;
                port = raw
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid port: {raw}"))?;
                if port == 0 {
                    return Err("Port must be greater than 0.".into());
                }
            }
            "--public-host" | "--public-ip" => {
                let raw = args.next().ok_or("Missing public host value")?;
                let host = raw.trim().trim_matches(['[', ']']).to_string();
                if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) {
                    return Err(format!("Invalid public host: {raw}"));
                }
                public_host = Some(host);
            }
            "--allow-private-address" => {
                allow_private_address = true;
            }
            "--status-interval" => {
                let raw = args.next().ok_or("Missing value after --status-interval")?;
                status_interval = raw
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid status interval: {raw}"))?;
                if status_interval < 10 {
                    return Err("Status interval must be at least 10 seconds.".into());
                }
            }
            "--health-file" => {
                let raw = args.next().ok_or("Missing value after --health-file")?;
                if raw.trim().is_empty() {
                    return Err("Health file path cannot be empty.".into());
                }
                health_file = Some(PathBuf::from(raw.trim()));
            }
            "--identity-file" => {
                let raw = args.next().ok_or("Missing value after --identity-file")?;
                if raw.trim().is_empty() {
                    return Err("Identity file path cannot be empty.".into());
                }
                identity_file = Some(PathBuf::from(raw.trim()));
            }
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            other => return Err(format!("Unknown argument: {other}. Use --help.")),
        }
    }

    if let Some(host) = public_host.as_deref() {
        validate_public_host(host, allow_private_address)?;
    }

    Ok(Some(NodeArgs {
        port,
        public_host,
        allow_private_address,
        status_interval,
        health_file,
        identity_file,
    }))
}

fn parse_args() -> Result<Option<NodeArgs>, String> {
    parse_args_from(std::env::args().skip(1))
}

fn public_prefix(host: &str) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => format!("/ip4/{ip}"),
        Ok(IpAddr::V6(ip)) => format!("/ip6/{ip}"),
        Err(_) => format!("/dns/{host}"),
    }
}

fn is_globally_routable_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();

    if a == 0 || a == 10 || a == 127 || a == 224 || a >= 240 {
        return false;
    }
    if a == 100 && (64..=127).contains(&b) {
        return false;
    }
    if a == 169 && b == 254 {
        return false;
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && (b == 0 || b == 168) {
        return false;
    }
    if a == 192 && b == 88 && ip.octets()[2] == 99 {
        return false;
    }
    if a == 198 && (b == 18 || b == 19 || b == 51 && ip.octets()[2] == 100) {
        return false;
    }
    if a == 203 && b == 0 && ip.octets()[2] == 113 {
        return false;
    }
    if a >= 224 {
        return false;
    }

    true
}

fn is_globally_routable_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_globally_routable_ipv4(mapped);
    }

    let segments = ip.segments();
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }

    // Fail closed for IETF special-purpose space, documentation prefixes, and 6to4.
    if segments[0] == 0x2001 && segments[1] <= 0x01ff {
        return false;
    }
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    if segments[0] == 0x2002 {
        return false;
    }
    if segments[0] == 0x3fff && segments[1] <= 0x0fff {
        return false;
    }

    true
}

fn classify_public_host(host: &str) -> PublicHostClassification {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) if is_globally_routable_ipv4(ip) => PublicHostClassification::GlobalIp,
        Ok(IpAddr::V6(ip)) if is_globally_routable_ipv6(ip) => PublicHostClassification::GlobalIp,
        Ok(_) => PublicHostClassification::NonGlobalIp,
        Err(_) => PublicHostClassification::DnsName,
    }
}

fn validate_public_host(
    host: &str,
    allow_private_address: bool,
) -> Result<PublicHostClassification, String> {
    let classification = classify_public_host(host);
    if classification == PublicHostClassification::NonGlobalIp && !allow_private_address {
        return Err(format!(
            "Public host IP literal '{host}' is not globally routable under the Konofix public-node evidence policy. Refusing to print a shareable public bootstrap. Use --allow-private-address only for controlled lab testing; lab addresses are never valid public-node release evidence."
        ));
    }
    Ok(classification)
}

fn print_shareable_addresses(host: &str, port: u16, peer: PeerId, lab_only: bool) {
    let prefix = public_prefix(host);
    let tcp = format!("{prefix}/tcp/{port}/p2p/{peer}");
    let quic = format!("{prefix}/udp/{port}/quic-v1/p2p/{peer}");

    println!();
    if lab_only {
        println!("=== KONOFIX LAB-ONLY ADDRESSES ===");
        println!("EVIDENCE      : NOT VALID FOR PUBLIC-NODE RELEASE EVIDENCE");
    } else {
        println!("=== KONOFIX SHAREABLE ADDRESSES ===");
    }
    println!("BOOTSTRAP TCP : {tcp}");
    println!("BOOTSTRAP QUIC: {quic}");
    println!("RECOMMENDED   : {tcp}");
    println!();
    if lab_only {
        println!("Use these addresses only inside the controlled lab that explicitly enabled --allow-private-address.");
    } else {
        println!("Paste RECOMMENDED into Konofix Chat -> Network settings -> Bootstrap.");
    }
    println!("Alternatively set the environment variable:");
    println!("  KONOFIX_BOOTSTRAPS={tcp}");
    println!();
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unique_health_temp_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Health file path has no file name: {}", path.display()))?
        .to_string_lossy();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(path.with_file_name(format!("{file_name}.tmp-{}-{nonce}", std::process::id())))
}

fn write_health_snapshot(
    path: &Path,
    local_peer: PeerId,
    started: Instant,
    connected_peers: usize,
    status: &str,
) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create health directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let snapshot = HealthSnapshot {
        schema: 2,
        status,
        version: env!("CARGO_PKG_VERSION"),
        source_commit: SOURCE_COMMIT,
        peer_id: local_peer.to_string(),
        uptime_seconds: started.elapsed().as_secs(),
        connected_peers,
        timestamp_unix: unix_timestamp(),
    };
    let payload = serde_json::to_vec_pretty(&snapshot)
        .map_err(|error| format!("Failed to encode health snapshot: {error}"))?;
    let temp_path = unique_health_temp_path(path)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut temp_file = options.open(&temp_path).map_err(|error| {
        format!(
            "Failed to create temporary health snapshot {}: {error}",
            temp_path.display()
        )
    })?;

    if let Err(error) = temp_file
        .write_all(&payload)
        .and_then(|_| temp_file.sync_all())
    {
        drop(temp_file);
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "Failed to persist temporary health snapshot {}: {error}",
            temp_path.display()
        ));
    }
    drop(temp_file);

    #[cfg(windows)]
    if path.exists() {
        if let Err(error) = std::fs::remove_file(path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!(
                "Failed to replace existing health snapshot {}: {error}",
                path.display()
            ));
        }
    }

    if let Err(error) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "Failed to publish health snapshot {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(args) = parse_args().map_err(std::io::Error::other)? else {
        return Ok(());
    };
    let port = args.port;
    let identity_path = args
        .identity_file
        .clone()
        .unwrap_or_else(default_identity_path);

    validate_state_paths(&identity_path, args.health_file.as_deref())
        .map_err(std::io::Error::other)?;

    let key = load_or_create_identity(&identity_path).map_err(std::io::Error::other)?;
    let local_peer = key.public().to_peer_id();

    // Re-check after identity creation so aliases through symlinks/junctions or relative
    // components resolve against a real on-disk identity before any health write can occur.
    validate_state_paths(&identity_path, args.health_file.as_deref())
        .map_err(std::io::Error::other)?;

    let mut swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_dns()?
        .with_behaviour(|key| {
            let peer = key.public().to_peer_id();
            let gossipsub_cfg = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(2))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .build()
                .map_err(std::io::Error::other)?;
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub_cfg,
            )
            .map_err(std::io::Error::other)?;

            let mut kad_cfg = kad::Config::new(StreamProtocol::new(KAD_PROTOCOL));
            kad_cfg.set_periodic_bootstrap_interval(Some(Duration::from_secs(60)));
            kad_cfg.set_record_ttl(Some(Duration::from_secs(120)));
            kad_cfg.set_replication_interval(Some(Duration::from_secs(30)));
            kad_cfg.set_provider_record_ttl(Some(Duration::from_secs(180)));
            let kad = kad::Behaviour::with_config(peer, MemoryStore::new(peer), kad_cfg);

            let identify = identify::Behaviour::new(
                identify::Config::new("/konofix/4.0".into(), key.public())
                    .with_agent_version(format!("Konofix-Node/{}", env!("CARGO_PKG_VERSION")))
                    .with_interval(Duration::from_secs(30))
                    .with_push_listen_addr_updates(true),
            );

            Ok(NodeBehaviour {
                gossipsub,
                kad,
                identify,
                ping: ping::Behaviour::default(),
                autonat: autonat::Behaviour::new(peer, autonat::Config::default()),
                relay: relay::Behaviour::new(peer, relay::Config::default()),
            })
        })?
        .build();

    swarm.behaviour_mut().kad.set_mode(Some(kad::Mode::Server));
    let world = gossipsub::IdentTopic::new(WORLD_TOPIC);
    let _ = swarm.behaviour_mut().gossipsub.subscribe(&world);
    let _ = swarm.behaviour_mut().kad.start_providing(provider_key());

    swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{port}").parse()?)?;
    swarm.listen_on(format!("/ip4/0.0.0.0/udp/{port}/quic-v1").parse()?)?;
    let _ = swarm.listen_on(format!("/ip6/::/tcp/{port}").parse()?);
    let _ = swarm.listen_on(format!("/ip6/::/udp/{port}/quic-v1").parse()?);

    println!("Konofix Node {}", env!("CARGO_PKG_VERSION"));
    println!("Source commit: {SOURCE_COMMIT}");
    println!("Peer ID: {local_peer}");
    println!("Identity file: {}", identity_path.display());
    println!("Transport: TCP + QUIC on port {port}");
    println!("Services: bootstrap + Kademlia DHT + AutoNAT + Circuit Relay + GossipSub");
    println!("Privacy: this node does not persist chat history or transferred files.");

    if let Some(host) = &args.public_host {
        let classification = classify_public_host(host);
        let lab_only = classification == PublicHostClassification::NonGlobalIp;
        if lab_only {
            debug_assert!(args.allow_private_address);
            println!("LAB MODE: non-global --public-host accepted only because --allow-private-address was explicitly supplied.");
        } else if classification == PublicHostClassification::DnsName {
            println!("NOTE: DNS host syntax is accepted by the raw Node, but global reachability is not proven until deployment/readiness checks resolve and probe it.");
        }
        print_shareable_addresses(host, port, local_peer, lab_only);
    } else {
        println!();
        println!("TIP: start with --public-host <PUBLIC_IP_OR_DNS> to print ready-to-share bootstrap addresses.");
    }

    let started = Instant::now();
    let mut connected_peers = HashSet::<PeerId>::new();
    let mut status_tick = tokio::time::interval(Duration::from_secs(args.status_interval));
    status_tick.tick().await;

    if let Some(path) = &args.health_file {
        write_health_snapshot(path, local_peer, started, connected_peers.len(), "running")
            .map_err(std::io::Error::other)?;
        println!("Health snapshot: {}", path.display());
    }

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("\nStopping Konofix Node...");
                if let Some(path) = &args.health_file {
                    if let Err(error) = write_health_snapshot(path, local_peer, started, connected_peers.len(), "stopped") {
                        eprintln!("WARNING: failed to write final health snapshot {}: {error}", path.display());
                    }
                }
                break;
            }
            _ = status_tick.tick() => {
                println!(
                    "STATUS uptime={}s connected_peers={} peer_id={}",
                    started.elapsed().as_secs(),
                    connected_peers.len(),
                    local_peer
                );
                if let Some(path) = &args.health_file {
                    if let Err(error) = write_health_snapshot(path, local_peer, started, connected_peers.len(), "running") {
                        eprintln!("WARNING: failed to update health snapshot {}: {error}", path.display());
                    }
                }
            }
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        println!("LISTEN LOCAL: {address}/p2p/{local_peer}");
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        connected_peers.insert(peer_id);
                        println!("+ peer {peer_id}");
                    }
                    SwarmEvent::ConnectionClosed { peer_id, num_established, .. } if num_established == 0 => {
                        connected_peers.remove(&peer_id);
                        println!("- peer {peer_id}");
                    }
                    SwarmEvent::Behaviour(NodeBehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
                        for addr in info.listen_addrs {
                            swarm.behaviour_mut().kad.add_address(&peer_id, addr);
                        }
                    }
                    SwarmEvent::Behaviour(NodeBehaviourEvent::Kad(kad::Event::RoutingUpdated { peer, .. })) => {
                        println!("DHT: {peer}");
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "konofix-node-{label}-{}-{nonce}",
                std::process::id()
            ))
            .join("node-identity.key")
    }

    #[test]
    fn parses_explicit_identity_file() {
        let args = parse_args_from(vec![
            "--identity-file".to_string(),
            "C:\\Konofix\\node-identity.key".to_string(),
            "--port".to_string(),
            "46666".to_string(),
        ])
        .expect("arguments should parse")
        .expect("help was not requested");

        assert_eq!(args.port, 46666);
        assert_eq!(
            args.identity_file,
            Some(PathBuf::from("C:\\Konofix\\node-identity.key"))
        );
    }

    #[test]
    fn rejects_empty_identity_file() {
        let error = parse_args_from(vec!["--identity-file".to_string(), "   ".to_string()])
            .expect_err("empty identity path must fail");
        assert!(error.contains("Identity file path cannot be empty"));
    }

    #[test]
    fn public_host_classification_is_fail_closed_for_special_use_literals() {
        let public = [
            "8.8.8.8",
            "1.1.1.1",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "2a00:1450:4009:820::200e",
            "::ffff:8.8.8.8",
        ];
        for host in public {
            assert_eq!(
                classify_public_host(host),
                PublicHostClassification::GlobalIp,
                "expected public literal: {host}"
            );
        }

        let non_global = [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:192.168.1.1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:2::1",
            "2001:10::1",
            "2001:20::1",
            "2001:db8::1",
            "2002:c000:0204::1",
            "3fff::1",
        ];
        for host in non_global {
            assert_eq!(
                classify_public_host(host),
                PublicHostClassification::NonGlobalIp,
                "expected non-global literal: {host}"
            );
        }
    }

    #[test]
    fn non_global_public_host_requires_explicit_lab_override() {
        let error = parse_args_from(vec![
            "--public-host".to_string(),
            "100.64.0.1".to_string(),
        ])
        .expect_err("CGNAT must fail closed without lab override");
        assert!(error.contains("not globally routable"));
        assert!(error.contains("--allow-private-address"));

        let args = parse_args_from(vec![
            "--public-host".to_string(),
            "100.64.0.1".to_string(),
            "--allow-private-address".to_string(),
        ])
        .expect("explicit lab override should parse")
        .expect("help was not requested");
        assert!(args.allow_private_address);
        assert_eq!(args.public_host.as_deref(), Some("100.64.0.1"));
    }

    #[test]
    fn dns_public_host_remains_supported_without_claiming_global_reachability() {
        assert_eq!(
            classify_public_host("node.operator-domain.com"),
            PublicHostClassification::DnsName
        );
        let args = parse_args_from(vec![
            "--public-host".to_string(),
            "node.operator-domain.com".to_string(),
        ])
        .expect("DNS host syntax should remain accepted by raw Node")
        .expect("help was not requested");
        assert!(!args.allow_private_address);
    }

    #[test]
    fn persisted_identity_keeps_peer_id() {
        let path = unique_test_path("stable");
        let first = load_or_create_identity(&path).expect("identity should be created");
        let second = load_or_create_identity(&path).expect("identity should be loaded");
        assert_eq!(first.public().to_peer_id(), second.public().to_peer_id());
        let _ = std::fs::remove_dir_all(path.parent().expect("test path has parent"));
    }

    #[test]
    fn corrupted_identity_fails_closed_without_replacement() {
        let path = unique_test_path("corrupt");
        std::fs::create_dir_all(path.parent().expect("test path has parent"))
            .expect("test directory should be created");
        let original = b"not-a-valid-libp2p-key";
        std::fs::write(&path, original).expect("corrupt fixture should be written");

        let error = match load_or_create_identity(&path) {
            Ok(_) => panic!("corrupt identity must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("refusing to replace"));
        assert_eq!(
            std::fs::read(&path).expect("fixture should remain"),
            original
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("test path has parent"));
    }

    #[test]
    fn rejects_identity_health_path_collision() {
        let identity = unique_test_path("state-collision");
        std::fs::create_dir_all(identity.parent().expect("test path has parent"))
            .expect("test directory should be created");
        std::fs::write(&identity, b"placeholder").expect("fixture should be written");

        let error = validate_state_paths(&identity, Some(&identity))
            .expect_err("identity/health collision must fail closed");
        assert!(error.contains("same path"));
        let _ = std::fs::remove_dir_all(identity.parent().expect("test path has parent"));
    }

    #[test]
    fn rejects_lexically_aliased_identity_health_collision() {
        let identity = unique_test_path("state-alias");
        let dir = identity.parent().expect("test path has parent");
        std::fs::create_dir_all(dir).expect("test directory should be created");
        std::fs::write(&identity, b"placeholder").expect("fixture should be written");
        let health_alias = dir
            .join("not-created")
            .join("..")
            .join(identity.file_name().expect("identity has a file name"));

        let error = validate_state_paths(&identity, Some(&health_alias))
            .expect_err("lexical identity/health alias must fail closed");
        assert!(error.contains("same path"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn health_snapshot_uses_safe_unique_temp_and_replaces_existing_snapshot() {
        let identity = unique_test_path("health-write");
        let dir = identity.parent().expect("test path has parent");
        std::fs::create_dir_all(dir).expect("test directory should be created");
        let health = dir.join("node-health.json");
        let legacy_fixed_temp = health.with_extension("tmp");
        std::fs::write(&health, b"old-snapshot").expect("old snapshot should be written");
        std::fs::write(&legacy_fixed_temp, b"unrelated-state")
            .expect("legacy temp collision sentinel should be written");

        let key = identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        write_health_snapshot(&health, peer, Instant::now(), 3, "running")
            .expect("health snapshot should be replaced");

        let text = std::fs::read_to_string(&health).expect("health snapshot should be readable");
        let json: serde_json::Value =
            serde_json::from_str(&text).expect("health snapshot should be JSON");
        assert_eq!(json["schema"], 2);
        assert_eq!(json["status"], "running");
        assert_eq!(json["connected_peers"], 3);
        assert_eq!(json["peer_id"], peer.to_string());
        assert_eq!(
            std::fs::read(&legacy_fixed_temp).expect("unrelated state must survive"),
            b"unrelated-state"
        );

        let leftovers = std::fs::read_dir(dir)
            .expect("test directory should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0, "temporary health files must be cleaned up");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn created_identity_is_private_on_unix() {
        let path = unique_test_path("permissions");
        load_or_create_identity(&path).expect("identity should be created");
        let mode = std::fs::metadata(&path)
            .expect("identity metadata should exist")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode & 0o077, 0, "group/other access must be removed");
        let _ = std::fs::remove_dir_all(path.parent().expect("test path has parent"));
    }
}
