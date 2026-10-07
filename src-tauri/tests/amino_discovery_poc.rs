//! Opt-in, loopback-only Amino wire/discovery experiment; never linked into the app.
use std::{num::NonZeroUsize, time::Duration};

use futures::StreamExt;
use libp2p::{
    identity,
    kad::{self, store::MemoryStore, store::MemoryStoreConfig},
    noise, request_response,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const AMINO: &str = "/ipfs/kad/1.0.0";
const AD_PROTOCOL: &str = "/konofix/experimental/cold-start/1";
const DOMAIN: &[u8] = b"konofix/experimental/world-ad/v1\0";
const MAX_TTL: u64 = 600;

fn provider_key(namespace: &[u8]) -> kad::RecordKey {
    // SHA2-256 multihash, not a naked digest or arbitrary PUT_VALUE namespace.
    let mut bytes = vec![0x12, 0x20];
    bytes.extend_from_slice(&Sha256::digest(namespace));
    kad::RecordKey::new(&bytes)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Advertisement {
    public_key: Vec<u8>,
    issued: u64,
    expires: u64,
    relay_opt_in: bool,
    signature: Vec<u8>,
}

impl Advertisement {
    fn payload(&self) -> Vec<u8> {
        let mut bytes = DOMAIN.to_vec();
        bytes.extend_from_slice(&self.issued.to_be_bytes());
        bytes.extend_from_slice(&self.expires.to_be_bytes());
        bytes.push(u8::from(self.relay_opt_in));
        bytes
    }

    fn sign(key: &identity::Keypair, issued: u64, expires: u64, relay_opt_in: bool) -> Self {
        let mut ad = Self {
            public_key: key.public().encode_protobuf(),
            issued,
            expires,
            relay_opt_in,
            signature: Vec::new(),
        };
        ad.signature = key.sign(&ad.payload()).unwrap();
        ad
    }

    fn verify(&self, authenticated_peer: PeerId, now: u64) -> bool {
        // Freshness limits acceptance, not retention by third-party DHT observers.
        if self.public_key.len() > 64
            || self.signature.len() != 64
            || self.issued > now
            || self.expires <= now
            || self.expires <= self.issued
            || self.expires - self.issued > MAX_TTL
        {
            return false;
        }
        let Ok(key) = identity::PublicKey::try_decode_protobuf(&self.public_key) else {
            return false;
        };
        key.to_peer_id() == authenticated_peer && key.verify(&self.payload(), &self.signature)
    }
}

#[derive(NetworkBehaviour)]
struct Poc {
    kad: kad::Behaviour<MemoryStore>,
    ads: request_response::cbor::Behaviour<(), Advertisement>,
}

fn swarm(key: identity::Keypair, server: bool) -> Swarm<Poc> {
    SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .unwrap()
        .with_behaviour(move |key| {
            let peer = key.public().to_peer_id();
            let mut config = kad::Config::new(StreamProtocol::new(AMINO));
            config
                .set_query_timeout(Duration::from_secs(5))
                .set_parallelism(NonZeroUsize::new(2).unwrap())
                .set_periodic_bootstrap_interval(None)
                .set_provider_publication_interval(None);
            let store = MemoryStore::with_config(
                peer,
                MemoryStoreConfig {
                    max_records: 0,
                    max_value_bytes: 0,
                    max_providers_per_key: 8,
                    max_provided_keys: 2,
                },
            );
            let mut kad = kad::Behaviour::with_config(peer, store, config);
            kad.set_mode(Some(if server {
                kad::Mode::Server
            } else {
                kad::Mode::Client
            }));
            let codec = request_response::cbor::codec::Codec::default()
                .set_request_size_maximum(16)
                .set_response_size_maximum(1024);
            let ads = request_response::cbor::Behaviour::with_codec(
                codec,
                [(
                    StreamProtocol::new(AD_PROTOCOL),
                    request_response::ProtocolSupport::Full,
                )],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(5))
                    .with_max_concurrent_streams(4),
            );
            Poc { kad, ads }
        })
        .unwrap()
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(30)))
        .build()
}

async fn listen(swarm: &mut Swarm<Poc>) -> Multiaddr {
    swarm
        .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
        .unwrap();
    loop {
        if let SwarmEvent::NewListenAddr { address, .. } = swarm.select_next_some().await {
            return address;
        }
    }
}

#[test]
fn signed_advertisements_reject_tampering_expiry_and_identity_substitution() {
    let key = identity::Keypair::generate_ed25519();
    let peer = key.public().to_peer_id();
    let ad = Advertisement::sign(&key, 1000, 1600, false);
    assert!(ad.verify(peer, 1000));
    assert!(ad.verify(peer, 1599));
    assert!(!ad.verify(peer, 1600));
    assert!(!ad.verify(peer, 999));
    assert!(!ad.verify(PeerId::random(), 1000));
    assert!(!Advertisement::sign(&key, 1000, 1601, false).verify(peer, 1000));
    assert!(!Advertisement::sign(&key, 1000, 1000, false).verify(peer, 1000));
    assert!(!Advertisement::sign(&key, u64::MAX - 1, u64::MAX, false).verify(peer, 1000));

    let mut forged = ad.clone();
    forged.relay_opt_in = true;
    assert!(!forged.verify(peer, 1000));
    forged = ad.clone();
    forged.expires -= 1;
    assert!(!forged.verify(peer, 1000));
    forged = ad.clone();
    forged.public_key = identity::Keypair::generate_ed25519()
        .public()
        .encode_protobuf();
    assert!(!forged.verify(peer, 1000));
    forged = ad.clone();
    forged.signature = key.sign(b"another application domain").unwrap();
    assert!(!forged.verify(peer, 1000));
    forged = ad.clone();
    forged.public_key = vec![0; 65];
    assert!(!forged.verify(peer, 1000));
    forged = ad;
    forged.signature.truncate(63);
    assert!(!forged.verify(peer, 1000));
    // An authenticated opt-in is a claim; reachability/capacity still need probing.
    assert!(Advertisement::sign(&key, 1000, 1600, true).verify(peer, 1000));
}

#[test]
fn rendezvous_namespace_is_a_valid_separate_multihash() {
    let key = provider_key(b"konofix/experimental/world/v1");
    assert_eq!(key.as_ref().len(), 34);
    assert_eq!(&key.as_ref()[..2], &[0x12, 0x20]);
    assert_ne!(key, provider_key(b"konofix/world/v3"));
    assert_ne!(AMINO, "/konofix/kad/1.0.0");
}

#[tokio::test]
async fn loopback_provider_discovery_then_authenticated_signed_advertisement() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let publisher_key = identity::Keypair::generate_ed25519();
        let ad = Advertisement::sign(&publisher_key, 1000, 1600, false);
        let mut publisher = swarm(publisher_key, false);
        let publisher_peer = *publisher.local_peer_id();
        let mut seed = swarm(identity::Keypair::generate_ed25519(), true);
        let seed_peer = *seed.local_peer_id();
        let mut seeker = swarm(identity::Keypair::generate_ed25519(), false);
        let seed_addr = listen(&mut seed).await;
        let publisher_addr = listen(&mut publisher).await;
        publisher.add_external_address(publisher_addr);
        publisher
            .behaviour_mut()
            .kad
            .add_address(&seed_peer, seed_addr.clone());
        seeker
            .behaviour_mut()
            .kad
            .add_address(&seed_peer, seed_addr);
        // The seeker receives no publisher address or PeerID out of band.
        assert_eq!(seeker.behaviour().kad.mode(), kad::Mode::Client);
        let key = provider_key(b"konofix/experimental/world/v1");
        let publish = publisher
            .behaviour_mut()
            .kad
            .start_providing(key.clone())
            .unwrap();
        let mut lookup_started = false;
        let mut published = false;
        let mut stored = false;
        let mut requested = None;
        let mut authenticated = false;
        loop {
            tokio::select! {
                event = seed.select_next_some() => {
                    if let SwarmEvent::Behaviour(PocEvent::Kad(kad::Event::InboundRequest {
                        request: kad::InboundRequest::AddProvider { .. },
                    })) = event {
                        stored = true;
                    }
                }
                event = publisher.select_next_some() => {
                    match event {
                        SwarmEvent::Behaviour(PocEvent::Kad(kad::Event::OutboundQueryProgressed {
                            id, result: kad::QueryResult::StartProviding(result), ..
                        })) if id == publish => {
                            result.expect("provider announcement must succeed");
                            published = true;
                        }
                        SwarmEvent::Behaviour(PocEvent::Ads(request_response::Event::Message {
                            message: request_response::Message::Request { channel, .. }, ..
                        })) => {
                            publisher.behaviour_mut().ads.send_response(channel, ad.clone()).unwrap();
                        }
                        _ => {}
                    }
                }
                event = seeker.select_next_some() => {
                    match event {
                        SwarmEvent::Behaviour(PocEvent::Kad(kad::Event::OutboundQueryProgressed {
                            result: kad::QueryResult::GetProviders(Ok(
                                kad::GetProvidersOk::FoundProviders { providers, .. }
                            )), ..
                        })) => {
                            assert!(providers.len() <= 8);
                            if requested.is_none() {
                                let peer = *providers.iter().next().expect("published provider");
                                // This equality is an assertion, not an input to discovery/dial.
                                assert_eq!(peer, publisher_peer);
                                requested = Some(seeker.behaviour_mut().ads.send_request(&peer, ()));
                            }
                        }
                        SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == publisher_peer => {
                            authenticated = true;
                        }
                        SwarmEvent::Behaviour(PocEvent::Ads(request_response::Event::Message {
                            peer, message: request_response::Message::Response { request_id, response }, ..
                        })) => {
                            assert_eq!(Some(request_id), requested);
                            assert!(authenticated);
                            assert_eq!(peer, publisher_peer);
                            assert!(response.verify(peer, 1001));
                            assert!(!response.relay_opt_in);
                            break;
                        }
                        SwarmEvent::Behaviour(PocEvent::Ads(request_response::Event::OutboundFailure {
                            error, ..
                        })) => panic!("advertisement request failed: {error}"),
                        _ => {}
                    }
                }
            }
            // ADD_PROVIDER is one-way: local send completion alone is not a
            // barrier proving that the remote fixture has stored the record.
            if published && stored && !lookup_started {
                seeker.behaviour_mut().kad.get_providers(key.clone());
                lookup_started = true;
            }
        }
    })
    .await
    .expect("loopback-only discovery/handshake exceeded 20 seconds");
}
