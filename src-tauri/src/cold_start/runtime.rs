//! Isolated Amino client swarm. Never joins chat, never treats IPFS nodes as relays.
use super::{
    is_circuit, provider_key, public_endpoint,
    transport::{DialBudget, PublicTransport},
    AdmissionTime, Advertisement, Cache, Request, AD_PROTOCOL, MAX_WIRE_BYTES, WORLD_NAMESPACE,
};
use futures::StreamExt;
use libp2p::{
    autonat, connection_limits,
    core::{muxing::StreamMuxerBox, transport::Boxed, upgrade},
    dns, identify, identity,
    kad::{
        self,
        store::{MemoryStore, MemoryStoreConfig},
    },
    noise, ping, request_response,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm, Transport,
};
use std::{
    collections::{HashMap, HashSet},
    num::NonZeroUsize,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const AMINO: &str = "/ipfs/kad/1.0.0";
// Official IPFS public utilities, best effort. They are discovery, not Konofix relays.
pub const SEEDS: [&str; 3] = [
    "/dnsaddr/sg1.bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/dnsaddr/sv15.bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/am6.bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

#[derive(NetworkBehaviour)]
pub struct DiscoveryBehaviour {
    // Derive invokes siblings in declaration order. Reject before ads can
    // register a handler for a connection the swarm will never establish.
    limits: connection_limits::Behaviour,
    kad: kad::Behaviour<MemoryStore>,
    ads: request_response::cbor::Behaviour<Request, Option<Advertisement>>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    autonat: autonat::Behaviour,
}

pub fn ad_behaviour(
    support: request_response::ProtocolSupport,
) -> request_response::cbor::Behaviour<Request, Option<Advertisement>> {
    request_response::cbor::Behaviour::with_codec(
        request_response::cbor::codec::Codec::default()
            .set_request_size_maximum(128)
            .set_response_size_maximum(MAX_WIRE_BYTES),
        [(StreamProtocol::new(AD_PROTOCOL), support)],
        request_response::Config::default()
            .with_request_timeout(Duration::from_secs(5))
            .with_max_concurrent_streams(4),
    )
}

fn behaviour(key: &identity::Keypair) -> DiscoveryBehaviour {
    let peer = key.public().to_peer_id();
    let mut config = kad::Config::new(StreamProtocol::new(AMINO));
    config
        .set_query_timeout(Duration::from_secs(15))
        .set_parallelism(NonZeroUsize::new(2).unwrap())
        .set_periodic_bootstrap_interval(None)
        .set_provider_publication_interval(None)
        .set_publication_interval(None)
        .set_replication_interval(None);
    let store = MemoryStore::with_config(
        peer,
        MemoryStoreConfig {
            max_records: 0,
            max_value_bytes: 0,
            max_providers_per_key: 8,
            max_provided_keys: 1,
        },
    );
    let mut kad = kad::Behaviour::with_config(peer, store, config);
    kad.set_mode(Some(kad::Mode::Client));
    DiscoveryBehaviour {
        kad,
        ads: ad_behaviour(request_response::ProtocolSupport::Outbound),
        identify: identify::Behaviour::new(
            identify::Config::new("/konofix/cold-start/2".into(), key.public())
                .with_interval(Duration::from_secs(300)),
        ),
        ping: ping::Behaviour::default(),
        autonat: autonat::Behaviour::new(
            peer,
            autonat::Config {
                use_connected: false,
                throttle_clients_global_max: 0,
                boot_delay: Duration::from_secs(5),
                retry_interval: Duration::from_secs(60),
                ..Default::default()
            },
        ),
        limits: connection_limits::Behaviour::new(
            connection_limits::ConnectionLimits::default()
                .with_max_established(Some(16))
                .with_max_established_per_peer(Some(1))
                .with_max_pending_outgoing(Some(4))
                .with_max_pending_incoming(Some(0)),
        ),
    }
}

fn transport(
    key: &identity::Keypair,
    budget: DialBudget,
) -> Result<Boxed<(PeerId, StreamMuxerBox)>, String> {
    // The filter is INSIDE DNS: every resolved candidate is checked immediately
    // before dialing, including indirections from otherwise trusted bootstrap TXT.
    let tcp = tcp::tokio::Transport::new(tcp::Config::default())
        .upgrade(upgrade::Version::V1Lazy)
        .authenticate(noise::Config::new(key).map_err(|e| e.to_string())?)
        .multiplex(yamux::Config::default())
        .timeout(Duration::from_secs(8))
        .map(|(peer, mux), _| (peer, StreamMuxerBox::new(mux)))
        .boxed();
    let quic = libp2p::quic::tokio::Transport::new(libp2p::quic::Config::new(key))
        .map(|(peer, mux), _| (peer, StreamMuxerBox::new(mux)))
        .boxed();
    let combined = tcp.or_transport(quic).map(|either, _| either.into_inner());
    Ok(PublicTransport::seed_ingress(
        dns::tokio::Transport::system(PublicTransport::new(combined, budget.clone()))
            .map_err(|e| e.to_string())?,
        budget,
    )
    .boxed())
}

struct Pending {
    peer: PeerId,
    request: Request,
    generation: u64,
    deadline: Instant,
}
pub enum Event {
    Candidate(Candidate),
    PublicProbe { server: PeerId, address: Multiaddr },
}

pub struct Candidate {
    pub peer: PeerId,
    pub endpoints: Vec<Multiaddr>,
    pub relay_opt_in: bool,
}

pub struct Discovery {
    swarm: Swarm<DiscoveryBehaviour>,
    key: identity::Keypair,
    budget: DialBudget,
    cache: Cache,
    pending: HashMap<request_response::OutboundRequestId, Pending>,
    attempted: Vec<PeerId>,
    query: Option<kad::QueryId>,
    next_lookup: Instant,
    next_publish: Instant,
    published: bool,
    publication: Option<kad::QueryId>,
    advertised: Vec<Multiaddr>,
    retry_publish: Instant,
    probe_servers: HashSet<PeerId>,
    native_ports: Vec<Multiaddr>,
    observed_hosts: Vec<Multiaddr>,
    probe_candidates: Vec<Multiaddr>,
    pub status: &'static str,
    #[cfg(test)]
    isolated_test: bool,
}
impl Discovery {
    pub fn new(key: identity::Keypair) -> Result<Self, String> {
        let budget = DialBudget::new();
        let swarm = Self::new_swarm(&key, budget.clone())?;
        let now = Instant::now();
        Ok(Self {
            swarm,
            key,
            budget,
            cache: Cache::new(),
            pending: HashMap::new(),
            attempted: Vec::new(),
            query: None,
            next_lookup: now,
            next_publish: now,
            published: false,
            publication: None,
            advertised: Vec::new(),
            retry_publish: now,
            probe_servers: HashSet::new(),
            native_ports: Vec::new(),
            observed_hosts: Vec::new(),
            probe_candidates: Vec::new(),
            status: "searching",
            #[cfg(test)]
            isolated_test: false,
        })
    }
    /// Native application tests exercise this adapter without any public sockets,
    /// including after interface recovery rebuilds it. Not compiled in releases.
    #[cfg(test)]
    pub fn isolated_for_test(key: identity::Keypair) -> Result<Self, String> {
        let mut client = Self::new(key)?;
        client.isolated_test = true;
        client.swarm = client.replacement_swarm()?;
        Ok(client)
    }
    fn replacement_swarm(&self) -> Result<Swarm<DiscoveryBehaviour>, String> {
        #[cfg(test)]
        if self.isolated_test {
            let tcp = tcp::tokio::Transport::new(tcp::Config::default())
                .upgrade(upgrade::Version::V1Lazy)
                .authenticate(noise::Config::new(&self.key).map_err(|e| e.to_string())?)
                .multiplex(yamux::Config::default())
                .map(|(peer, mux), _| (peer, StreamMuxerBox::new(mux)));
            return Ok(Swarm::new(
                PublicTransport::loopback(tcp, self.budget.clone()).boxed(),
                behaviour(&self.key),
                self.key.public().to_peer_id(),
                libp2p::swarm::Config::with_tokio_executor(),
            ));
        }
        Self::new_swarm(&self.key, self.budget.clone())
    }
    fn new_swarm(
        key: &identity::Keypair,
        budget: DialBudget,
    ) -> Result<Swarm<DiscoveryBehaviour>, String> {
        let mut swarm = Swarm::new(
            transport(key, budget)?,
            behaviour(key),
            key.public().to_peer_id(),
            libp2p::swarm::Config::with_tokio_executor()
                .with_idle_connection_timeout(Duration::from_secs(15)),
        );
        for raw in SEEDS {
            let address: Multiaddr = raw
                .parse()
                .map_err(|e| format!("Invalid pinned bootstrap: {e}"))?;
            if let Some(libp2p::multiaddr::Protocol::P2p(peer)) = address.iter().last() {
                swarm
                    .behaviour_mut()
                    .kad
                    .add_address(&peer, address.clone());
            }
        }
        Ok(swarm)
    }
    pub fn network_changed(&mut self) -> Result<(), String> {
        self.cache
            .network_changed()
            .map_err(|e| format!("Cache generation exhausted: {e:?}"))?;
        self.pending.clear();
        self.attempted.clear();
        self.query = None;
        // Drop old sockets, queries and resolver configuration. Keep identity,
        // anti-replay tombstones and global dial budget across interface churn.
        self.swarm = self.replacement_swarm()?;
        self.published = false;
        self.publication = None;
        self.advertised.clear();
        self.probe_candidates.clear();
        self.native_ports.clear();
        self.observed_hosts.clear();
        self.probe_servers.clear();
        self.next_lookup = Instant::now();
        self.status = "network-changed";
        Ok(())
    }
    pub fn native_listeners(&mut self, addresses: impl Iterator<Item = Multiaddr>) {
        // Wildcard listeners yield one address per interface. Bound distinct
        // transport/port pairs so duplicate TCP interfaces cannot crowd out QUIC.
        let mut ports = HashSet::new();
        self.native_ports = addresses
            .filter(|a| !is_circuit(a))
            .filter(|a| {
                super::reachability::port(a).is_some_and(|port| port.1 != 0 && ports.insert(port))
            })
            .take(4)
            .collect();
        self.refresh_probe_candidates();
    }
    fn refresh_probe_candidates(&mut self) {
        for host in &self.observed_hosts {
            for native in &self.native_ports {
                let mut candidate = host.clone();
                for p in native.iter().skip(1) {
                    candidate.push(p);
                }
                if !matches!(
                    candidate.iter().last(),
                    Some(libp2p::multiaddr::Protocol::P2p(_))
                ) {
                    candidate.push(libp2p::multiaddr::Protocol::P2p(
                        *self.swarm.local_peer_id(),
                    ));
                }
                if public_endpoint(&candidate.to_string(), *self.swarm.local_peer_id()).is_some()
                    && self.probe_candidates.len() < 8
                    && !self.probe_candidates.contains(&candidate)
                {
                    self.probe_candidates.push(candidate.clone());
                    self.swarm.behaviour_mut().autonat.probe_address(candidate);
                }
            }
        }
    }
    pub fn tick(&mut self, unix: u64) {
        let now = Instant::now();
        self.cache.expire(unix, now);
        if self.status == "verified-participant" && !self.cache.has_accepted() {
            self.status = "no-verified-participant";
        }
        self.pending.retain(|_, p| p.deadline > now);
        if now >= self.next_lookup && self.query.is_none() {
            self.attempted.clear();
            self.query = Some(
                self.swarm
                    .behaviour_mut()
                    .kad
                    .get_providers(provider_key(WORLD_NAMESPACE)),
            );
            self.next_lookup = now + Duration::from_secs(300);
            self.status = "searching";
        }
    }
    /// Publish native, independently confirmed direct endpoints only. A NATed
    /// client can discover participants without publishing its own provider record.
    pub fn publish(&mut self, endpoints: &[Multiaddr], publicly_reachable: bool) {
        let now = Instant::now();
        let peer = *self.swarm.local_peer_id();
        let mut addresses: Vec<_> = endpoints
            .iter()
            .filter(|a| {
                publicly_reachable
                    && !is_circuit(a)
                    && public_endpoint(&a.to_string(), peer).is_some()
            })
            .take(4)
            .cloned()
            .collect();
        addresses.sort();
        addresses.dedup();
        if addresses != self.advertised {
            if let Some(id) = self.publication.take() {
                if let Some(mut query) = self.swarm.behaviour_mut().kad.query_mut(&id) {
                    query.finish();
                }
            }
            self.swarm
                .behaviour_mut()
                .kad
                .stop_providing(&provider_key(WORLD_NAMESPACE));
            for address in &self.advertised {
                self.swarm.remove_external_address(address);
            }
            for address in &addresses {
                self.swarm.add_external_address(address.clone());
            }
            self.advertised = addresses;
            self.published = false;
        }
        if self.advertised.is_empty()
            || self.publication.is_some()
            || now < self.retry_publish
            || (self.published && now < self.next_publish)
        {
            return;
        }
        self.retry_publish = now + Duration::from_secs(300);
        if let Ok(id) = self
            .swarm
            .behaviour_mut()
            .kad
            .start_providing(provider_key(WORLD_NAMESPACE))
        {
            self.publication = Some(id);
        }
    }
    pub fn contains(&self, peer: &PeerId) -> bool {
        self.cache.get(peer).is_some()
    }
    pub async fn next(&mut self) -> Option<Event> {
        let event = self.swarm.select_next_some().await;
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        match event {
            SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Kad(
                kad::Event::OutboundQueryProgressed {
                    id,
                    result,
                    step,
                    stats,
                    ..
                },
            )) => {
                if self.publication == Some(id) {
                    if let kad::QueryResult::StartProviding(result) = &result {
                        self.publication = None;
                        self.published = result.is_ok();
                        if self.published {
                            self.next_publish = Instant::now() + Duration::from_secs(22 * 3600);
                        }
                    }
                }
                if self.query == Some(id) {
                    if let kad::QueryResult::GetProviders(Ok(
                        kad::GetProvidersOk::FoundProviders { providers, .. },
                    )) = result
                    {
                        for peer in providers {
                            if peer == *self.swarm.local_peer_id()
                                || self.attempted.contains(&peer)
                                || self.attempted.len() >= 8
                                || self.pending.len() >= 4
                            {
                                continue;
                            }
                            self.attempted.push(peer);
                            let request = Request::fresh();
                            let id = self
                                .swarm
                                .behaviour_mut()
                                .ads
                                .send_request(&peer, request.clone());
                            self.pending.insert(
                                id,
                                Pending {
                                    peer,
                                    request,
                                    generation: self.cache.generation(),
                                    deadline: Instant::now() + Duration::from_secs(5),
                                },
                            );
                        }
                    }
                    if step.last {
                        self.query = None;
                        self.status = if self.cache.has_accepted() {
                            "verified-participant"
                        } else if stats.num_successes() == 0 {
                            "entry-unreachable"
                        } else {
                            "no-verified-participant"
                        };
                    }
                }
            }
            SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Ads(
                request_response::Event::Message {
                    peer,
                    message:
                        request_response::Message::Response {
                            request_id,
                            response,
                        },
                    ..
                },
            )) => {
                if let Some(pending) = self.pending.remove(&request_id) {
                    if pending.peer == peer && pending.deadline > Instant::now() {
                        if let Some(ad) = response {
                            if self
                                .cache
                                .admit(
                                    peer,
                                    *self.swarm.local_peer_id(),
                                    &pending.request,
                                    pending.generation,
                                    &ad,
                                    AdmissionTime {
                                        unix_seconds: unix,
                                        monotonic: Instant::now(),
                                    },
                                )
                                .is_ok()
                            {
                                let accepted = self.cache.get(&peer).unwrap();
                                self.status = "verified-participant";
                                return Some(Event::Candidate(Candidate {
                                    peer,
                                    endpoints: accepted.endpoints.clone(),
                                    relay_opt_in: accepted.relay_opt_in,
                                }));
                            }
                        }
                    }
                }
            }
            SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Ads(
                request_response::Event::OutboundFailure { request_id, .. },
            )) => {
                self.pending.remove(&request_id);
            }
            SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Identify(
                identify::Event::Received { peer_id, info, .. },
            )) => {
                if info.protocols.contains(&autonat::DEFAULT_PROTOCOL_NAME)
                    && (self.probe_servers.len() < 8 || self.probe_servers.contains(&peer_id))
                {
                    self.probe_servers.insert(peer_id);
                    // Advertised AutoNAT support is permission to request that
                    // protocol, never permission to relay or send chat to IPFS.
                    self.swarm.behaviour_mut().autonat.add_server(peer_id, None);
                    if let Some(
                        host @ (libp2p::multiaddr::Protocol::Ip4(_)
                        | libp2p::multiaddr::Protocol::Ip6(_)),
                    ) = info.observed_addr.iter().next()
                    {
                        let mut prefix = Multiaddr::empty();
                        prefix.push(host);
                        if self.observed_hosts.len() < 4 && !self.observed_hosts.contains(&prefix) {
                            self.observed_hosts.push(prefix);
                        }
                        self.refresh_probe_candidates();
                    }
                }
            }
            // A response alone is not evidence: the caller correlates a fresh
            // authenticated inbound native connection from this same server.
            SwarmEvent::Behaviour(DiscoveryBehaviourEvent::Autonat(
                autonat::Event::OutboundProbe(autonat::OutboundProbeEvent::Response {
                    peer,
                    address,
                    ..
                }),
            )) if public_endpoint(&address.to_string(), *self.swarm.local_peer_id()).is_some()
                && self.probe_candidates.contains(&address) =>
            {
                return Some(Event::PublicProbe {
                    server: peer,
                    address,
                });
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
