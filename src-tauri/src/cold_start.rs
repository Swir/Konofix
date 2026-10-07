//! Application-level cold-start admission. DHT results never authorize chat or relay.
//! No network I/O here; callers must match a live request before admission.
use libp2p::{identity, kad, multiaddr::Protocol, Multiaddr, PeerId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[path = "cold_start/reachability.rs"]
pub mod reachability;
#[path = "cold_start/runtime.rs"]
pub mod runtime;
#[path = "cold_start/server.rs"]
pub mod server;
#[path = "cold_start/transport.rs"]
mod transport;

pub const AD_PROTOCOL: &str = "/konofix/experimental/cold-start/2";
pub const WORLD_NAMESPACE: &str = "konofix/experimental/world/v2";
pub const MAX_TTL: u64 = 300;
pub const MAX_ENDPOINTS: usize = 4;
pub const MAX_CACHE: usize = 128;
pub const MAX_WIRE_BYTES: u64 = 4096;
const DOMAIN: &[u8] = b"konofix/cold-start/signed-ad/v2\0";

pub fn provider_key(namespace: &str) -> kad::RecordKey {
    let mut bytes = vec![0x12, 0x20];
    bytes.extend_from_slice(&Sha256::digest(namespace.as_bytes()));
    kad::RecordKey::new(&bytes)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub challenge: [u8; 16],
}

impl Request {
    pub fn fresh() -> Self {
        Self {
            challenge: *uuid::Uuid::new_v4().as_bytes(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Advertisement {
    namespace: String,
    public_key: Vec<u8>,
    requester: String,
    challenge: [u8; 16],
    issued: u64,
    expires: u64,
    sequence: u64,
    endpoints: Vec<String>,
    relay_opt_in: bool,
    signature: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rejection {
    Bounds,
    Identity,
    Signature,
    Freshness,
    Request,
    Endpoint,
    Replay,
    Capacity,
    Clock,
}

impl Advertisement {
    fn payload(&self) -> Vec<u8> {
        // Length-delimited canonical bytes, independent of CBOR/JSON map order.
        fn field(out: &mut Vec<u8>, bytes: &[u8]) {
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(bytes);
        }
        let mut out = DOMAIN.to_vec();
        field(&mut out, self.namespace.as_bytes());
        field(&mut out, &self.public_key);
        field(&mut out, self.requester.as_bytes());
        out.extend_from_slice(&self.challenge);
        out.extend_from_slice(&self.issued.to_be_bytes());
        out.extend_from_slice(&self.expires.to_be_bytes());
        out.extend_from_slice(&self.sequence.to_be_bytes());
        out.push(u8::from(self.relay_opt_in));
        out.push(self.endpoints.len() as u8);
        for endpoint in &self.endpoints {
            field(&mut out, endpoint.as_bytes());
        }
        out
    }

    pub fn sign(
        key: &identity::Keypair,
        requester: PeerId,
        request: &Request,
        issued: u64,
        sequence: u64,
        endpoints: Vec<String>,
        relay_opt_in: bool,
    ) -> Result<Self, Rejection> {
        let mut ad = Self {
            namespace: WORLD_NAMESPACE.into(),
            public_key: key.public().encode_protobuf(),
            requester: requester.to_string(),
            challenge: request.challenge,
            issued,
            expires: issued.checked_add(MAX_TTL).ok_or(Rejection::Freshness)?,
            sequence,
            endpoints,
            relay_opt_in,
            signature: Vec::new(),
        };
        ad.validate_shape(issued)?;
        ad.endpoints(key.public().to_peer_id())?;
        ad.signature = key.sign(&ad.payload()).map_err(|_| Rejection::Signature)?;
        Ok(ad)
    }

    fn validate_shape(&self, now: u64) -> Result<(), Rejection> {
        if self.namespace != WORLD_NAMESPACE
            || self.public_key.len() > 64
            || self.requester.len() > 64
            || self.endpoints.len() > MAX_ENDPOINTS
            || self.endpoints.is_empty()
            || self.endpoints.iter().any(|s| s.len() > 256)
            || self.sequence == 0
        {
            return Err(Rejection::Bounds);
        }
        if self.issued > now
            || self.expires <= now
            || self.expires <= self.issued
            || self.expires - self.issued > MAX_TTL
        {
            return Err(Rejection::Freshness);
        }
        Ok(())
    }

    fn endpoints(&self, peer: PeerId) -> Result<Vec<Multiaddr>, Rejection> {
        let mut endpoints = Vec::new();
        for raw in &self.endpoints {
            let address = public_endpoint(raw, peer).ok_or(Rejection::Endpoint)?;
            if endpoints.contains(&address) {
                return Err(Rejection::Endpoint);
            }
            endpoints.push(address);
        }
        // A relay claim with only circuit addresses cannot claim public hosting.
        if self.relay_opt_in && endpoints.iter().all(is_circuit) {
            return Err(Rejection::Endpoint);
        }
        Ok(endpoints)
    }

    fn verify(
        &self,
        peer: PeerId,
        requester: PeerId,
        request: &Request,
        now: u64,
    ) -> Result<Vec<Multiaddr>, Rejection> {
        self.validate_shape(now)?;
        if self.requester != requester.to_string() || self.challenge != request.challenge {
            return Err(Rejection::Request);
        }
        let key = identity::PublicKey::try_decode_protobuf(&self.public_key)
            .map_err(|_| Rejection::Identity)?;
        if key.to_peer_id() != peer {
            return Err(Rejection::Identity);
        }
        if self.signature.len() != 64 || !key.verify(&self.payload(), &self.signature) {
            return Err(Rejection::Signature);
        }
        self.endpoints(peer)
    }
}

pub fn is_circuit(address: &Multiaddr) -> bool {
    address.iter().any(|p| p == Protocol::P2pCircuit)
}

/// Literal public TCP/QUIC only, optionally exactly one public relay hop.
/// DNS is deliberately rejected: resolving an untrusted name later can rebind it
/// into LAN/loopback. LAN mDNS and explicit user contacts have separate policies.
pub fn public_endpoint(raw: &str, expected: PeerId) -> Option<Multiaddr> {
    if raw.len() > 256 {
        return None;
    }
    let address: Multiaddr = raw.parse().ok()?;
    if address.to_string() != raw {
        return None;
    }
    let protocols: Vec<_> = address.iter().collect();
    let (ip, suffix) = protocols.split_first()?;
    let public = match ip {
        Protocol::Ip4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && ((b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99) || b == 168))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        Protocol::Ip6(ip) => {
            let s = ip.segments();
            // Conservative global unicast only. Exclude special-use 2001::/23,
            // documentation, 6to4 (which can embed a private IPv4 destination).
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] & 0xf000 == 0)
        }
        _ => false,
    };
    if !public {
        return None;
    }
    let tail = match suffix {
        [Protocol::Tcp(port), tail @ ..] if *port != 0 => tail,
        [Protocol::Udp(port), Protocol::QuicV1, tail @ ..] if *port != 0 => tail,
        _ => return None,
    };
    match tail {
        [Protocol::P2p(peer)] if *peer == expected => Some(address),
        [Protocol::P2p(relay), Protocol::P2pCircuit, Protocol::P2p(peer)]
            if *peer == expected && *relay != expected =>
        {
            Some(address)
        }
        _ => None,
    }
}

#[derive(Debug)]
pub struct Accepted {
    pub endpoints: Vec<Multiaddr>,
    /// Authenticated claim only; caller must independently check public reachability.
    pub relay_opt_in: bool,
    expires: u64,
    deadline: Instant,
}

struct Entry {
    sequence: u64,
    retain_until: Instant,
    accepted: Option<Accepted>,
}

/// Session-scoped cache. No early LRU eviction of replay tombstones under flood.
/// Requests are consumed on *any* response, invalid or not, by the runtime adapter.
pub struct AdmissionTime {
    pub unix_seconds: u64,
    pub monotonic: Instant,
}

pub struct Cache {
    entries: HashMap<PeerId, Entry>,
    generation: u64,
    last_wall: u64,
}
impl Cache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            generation: 0,
            last_wall: 0,
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn network_changed(&mut self) -> Result<(), Rejection> {
        self.generation = self.generation.checked_add(1).ok_or(Rejection::Bounds)?;
        for entry in self.entries.values_mut() {
            entry.accepted = None;
        }
        Ok(())
    }
    pub fn expire(&mut self, now: u64, monotonic: Instant) {
        for entry in self.entries.values_mut() {
            if entry.accepted.as_ref().is_some_and(|a| {
                now < self.last_wall || a.expires <= now || a.deadline <= monotonic
            }) {
                entry.accepted = None;
            }
        }
        self.entries.retain(|_, e| e.retain_until > monotonic);
        self.last_wall = self.last_wall.max(now);
    }
    pub fn get(&self, peer: &PeerId) -> Option<&Accepted> {
        self.entries.get(peer)?.accepted.as_ref()
    }
    pub fn admit(
        &mut self,
        peer: PeerId,
        requester: PeerId,
        request: &Request,
        generation: u64,
        ad: &Advertisement,
        time: AdmissionTime,
    ) -> Result<(), Rejection> {
        let AdmissionTime {
            unix_seconds: now,
            monotonic,
        } = time;
        if now < self.last_wall {
            return Err(Rejection::Clock);
        }
        self.expire(now, monotonic);
        if generation != self.generation {
            return Err(Rejection::Request);
        }
        let endpoints = ad.verify(peer, requester, request, now)?;
        if self
            .entries
            .get(&peer)
            .is_some_and(|e| ad.sequence <= e.sequence)
        {
            return Err(Rejection::Replay);
        }
        if !self.entries.contains_key(&peer) && self.entries.len() >= MAX_CACHE {
            return Err(Rejection::Capacity);
        }
        self.entries.insert(
            peer,
            Entry {
                sequence: ad.sequence,
                retain_until: monotonic + Duration::from_secs(MAX_TTL),
                accepted: Some(Accepted {
                    endpoints,
                    relay_opt_in: ad.relay_opt_in,
                    expires: ad.expires,
                    deadline: monotonic + Duration::from_secs(ad.expires - now),
                }),
            },
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "cold_start/tests.rs"]
mod tests;
