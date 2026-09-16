use std::{
    collections::HashSet,
    net::IpAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

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
    status_interval: u64,
    health_file: Option<PathBuf>,
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

fn identity_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Konofix Chat")
        .join("node-identity.key")
}

fn load_or_create_identity() -> Result<identity::Keypair, String> {
    let path = identity_path();
    if let Ok(data) = std::fs::read(&path) {
        if let Ok(key) = identity::Keypair::from_protobuf_encoding(&data) {
            return Ok(key);
        }
    }

    let key = identity::Keypair::generate_ed25519();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let encoded = key.to_protobuf_encoding().map_err(|e| e.to_string())?;
    std::fs::write(&path, encoded).map_err(|e| e.to_string())?;
    Ok(key)
}

fn provider_key() -> kad::RecordKey {
    let bytes = WORLD_PROVIDER_KEY.as_bytes().to_vec();
    kad::RecordKey::new(&bytes)
}

fn print_help() {
    println!("Konofix Node {}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage:");
    println!("  konofix-node.exe [--port 45555] [--public-host HOST] [--status-interval 60] [--health-file PATH]");
    println!();
    println!("Options:");
    println!("  --port PORT              TCP and UDP/QUIC port (default: 45555)");
    println!("  --public-host HOST       Public IPv4, IPv6, or DNS name of this node");
    println!("  --public-ip IP           Alias for --public-host");
    println!("  --status-interval SEC    Print an operational status line every N seconds (default: 60, minimum: 10)");
    println!("  --health-file PATH       Atomically update a metadata-only JSON health snapshot");
    println!("  -h, --help               Show this help");
    println!();
    println!("Example:");
    println!("  konofix-node.exe --port 45555 --public-host 203.0.113.10 --status-interval 60 --health-file konofix-health.json");
}

fn parse_args() -> Result<Option<NodeArgs>, String> {
    let mut port = DEFAULT_PORT;
    let mut public_host = None;
    let mut status_interval = DEFAULT_STATUS_INTERVAL;
    let mut health_file = None;
    let mut args = std::env::args().skip(1);

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
                let path = PathBuf::from(raw.trim());
                if raw.trim().is_empty() {
                    return Err("Health file path cannot be empty.".into());
                }
                health_file = Some(path);
            }
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            other => return Err(format!("Unknown argument: {other}. Use --help.")),
        }
    }

    Ok(Some(NodeArgs {
        port,
        public_host,
        status_interval,
        health_file,
    }))
}

fn public_prefix(host: &str) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => format!("/ip4/{ip}"),
        Ok(IpAddr::V6(ip)) => format!("/ip6/{ip}"),
        Err(_) => format!("/dns/{host}"),
    }
}

fn is_non_public_ip(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn print_shareable_addresses(host: &str, port: u16, peer: PeerId) {
    let prefix = public_prefix(host);
    let tcp = format!("{prefix}/tcp/{port}/p2p/{peer}");
    let quic = format!("{prefix}/udp/{port}/quic-v1/p2p/{peer}");

    println!();
    println!("=== KONOFIX SHAREABLE ADDRESSES ===");
    println!("BOOTSTRAP TCP : {tcp}");
    println!("BOOTSTRAP QUIC: {quic}");
    println!("RECOMMENDED   : {tcp}");
    println!();
    println!("Paste RECOMMENDED into Konofix Chat -> Network settings -> Bootstrap.");
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

fn write_health_snapshot(
    path: &Path,
    local_peer: PeerId,
    started: Instant,
    connected_peers: usize,
    status: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
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
    let payload = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension("tmp");
    std::fs::write(&temp_path, payload).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp_path, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(args) = parse_args().map_err(std::io::Error::other)? else {
        return Ok(());
    };
    let port = args.port;
    let key = load_or_create_identity().map_err(std::io::Error::other)?;
    let local_peer = key.public().to_peer_id();

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
    println!("Transport: TCP + QUIC on port {port}");
    println!("Services: bootstrap + Kademlia DHT + AutoNAT + Circuit Relay + GossipSub");
    println!("Privacy: this node does not persist chat history or transferred files.");

    if let Some(host) = &args.public_host {
        if is_non_public_ip(host) {
            println!("WARNING: --public-host resolves to a non-public IP literal. Cross-network clients may not be able to reach it.");
        }
        print_shareable_addresses(host, port, local_peer);
    } else {
        println!();
        println!("TIP: start with --public-host <PUBLIC_IP_OR_DNS> to print ready-to-share bootstrap addresses.");
    }

    let started = Instant::now();
    let mut connected_peers = HashSet::<PeerId>::new();
    let mut status_tick = tokio::time::interval(Duration::from_secs(args.status_interval));
    status_tick.tick().await;

    if let Some(path) = &args.health_file {
        match write_health_snapshot(path, local_peer, started, connected_peers.len(), "running") {
            Ok(()) => println!("Health snapshot: {}", path.display()),
            Err(error) => eprintln!("WARNING: failed to write health snapshot {}: {error}", path.display()),
        }
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
