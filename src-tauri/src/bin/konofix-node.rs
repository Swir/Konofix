use std::{net::IpAddr, path::PathBuf, time::Duration};

use futures::StreamExt;
use libp2p::{
    autonat, gossipsub, identify, identity,
    kad::{self, store::MemoryStore},
    noise, ping, relay,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, PeerId, StreamProtocol, SwarmBuilder,
};

const WORLD_TOPIC: &str = "konofix/world/v3";
const KAD_PROTOCOL: &str = "/konofix/kad/1.0.0";
const WORLD_PROVIDER_KEY: &str = "/konofix/world/providers/v1";
const DEFAULT_PORT: u16 = 45555;

#[derive(Debug)]
struct NodeArgs {
    port: u16,
    public_host: Option<String>,
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
    println!("Użycie:");
    println!("  konofix-node.exe [--port 45555] [--public-host HOST]");
    println!();
    println!("Opcje:");
    println!("  --port PORT          Port TCP i UDP/QUIC (domyślnie 45555)");
    println!("  --public-host HOST   Publiczny IPv4, IPv6 lub DNS noda");
    println!("  --public-ip IP       Alias dla --public-host");
    println!("  -h, --help           Pokaż pomoc");
    println!();
    println!("Przykład:");
    println!("  konofix-node.exe --port 45555 --public-host 203.0.113.10");
}

fn parse_args() -> Result<Option<NodeArgs>, String> {
    let mut port = DEFAULT_PORT;
    let mut public_host = None;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let raw = args.next().ok_or("Brak wartości po --port")?;
                port = raw
                    .parse::<u16>()
                    .map_err(|_| format!("Nieprawidłowy port: {raw}"))?;
                if port == 0 {
                    return Err("Port musi być większy od 0.".into());
                }
            }
            "--public-host" | "--public-ip" => {
                let raw = args.next().ok_or("Brak wartości publicznego hosta")?;
                let host = raw.trim().trim_matches(['[', ']']).to_string();
                if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) {
                    return Err(format!("Nieprawidłowy publiczny host: {raw}"));
                }
                public_host = Some(host);
            }
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            other => return Err(format!("Nieznany argument: {other}. Użyj --help.")),
        }
    }

    Ok(Some(NodeArgs { port, public_host }))
}

fn public_prefix(host: &str) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => format!("/ip4/{ip}"),
        Ok(IpAddr::V6(ip)) => format!("/ip6/{ip}"),
        Err(_) => format!("/dns4/{host}"),
    }
}

fn print_shareable_addresses(host: &str, port: u16, peer: PeerId) {
    let prefix = public_prefix(host);
    let tcp = format!("{prefix}/tcp/{port}/p2p/{peer}");
    let quic = format!("{prefix}/udp/{port}/quic-v1/p2p/{peer}");

    println!();
    println!("=== GOTOWE ADRESY KONOFIX ===");
    println!("BOOTSTRAP TCP : {tcp}");
    println!("BOOTSTRAP QUIC: {quic}");
    println!("REKOMENDOWANY : {tcp}");
    println!();
    println!("Wklej REKOMENDOWANY adres w Konofix Chat -> Ustawienia sieci -> Bootstrap.");
    println!("Alternatywnie ustaw zmienną środowiskową:");
    println!("  KONOFIX_BOOTSTRAPS={tcp}");
    println!();
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
    println!("Peer ID: {local_peer}");
    println!("Port: {port} TCP/UDP");
    println!("Bootstrap + Kademlia DHT + Circuit Relay dla Konofix Chat.");
    println!("Node nie zapisuje historii czatu ani przesylanych plikow.");

    if let Some(host) = &args.public_host {
        print_shareable_addresses(host, port, local_peer);
    } else {
        println!();
        println!("TIP: uruchom z --public-host <PUBLICZNY_IP_LUB_DNS>, aby dostać gotowy adres bootstrap.");
    }

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("\nZatrzymywanie Konofix Node...");
                break;
            }
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        println!("LISTEN LOCAL: {address}/p2p/{local_peer}");
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        println!("+ peer {peer_id}");
                    }
                    SwarmEvent::ConnectionClosed { peer_id, num_established, .. } if num_established == 0 => {
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
