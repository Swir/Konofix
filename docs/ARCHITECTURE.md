# Konofix Chat — Architecture 0.4.2

## Windows client

Tauri 2 + TypeScript GUI + Rust/libp2p.

The client `Swarm` includes:

- TCP + QUIC
- Noise/Yamux
- GossipSub
- mDNS
- Kademlia
- Identify
- Ping
- AutoNAT
- Circuit Relay client/server
- DCUtR
- UPnP
- CBOR request-response for file transfer

## Discovery

1. mDNS discovers peers on the local network.
2. The peer cache tries addresses learned during previous sessions.
3. A bootstrap peer provides the first global entry point.
4. Kademlia discovers additional `#WORLD` providers.
5. Identify exchanges listen addresses.
6. Discovered addresses are stored in the local cache.

## NAT / Relay

The client first attempts direct TCP/QUIC connectivity. AutoNAT estimates reachability. UPnP may expose a port. DCUtR attempts hole punching. If direct P2P cannot be established, the client may use Circuit Relay.

## Konofix Node

The Node has a persistent Peer ID and predictable listen port. It can act as a DHT bootstrap peer, AutoNAT peer, and Circuit Relay. It does not maintain an account database or chat history.

## Nicknames

Nicknames are normalized with NFKC + lowercase. Reservation uses a short DHT lease and a `NickClaim` in `#WORLD`. During a network partition, a temporary conflict may occur; after reconnection, Peer ID ordering selects one active owner.

## Files

Files are never published through GossipSub. Offers and chunks use the CBOR request-response protocol. The receiver writes a `.konofixpart` temporary file, verifies SHA-256, and only then moves it to the final filename.

## Localization

The UI detects the operating-system locale. Supported locales are mapped to a translation layer, while unsupported locales fall back to English. Repository-facing documentation and development text remain English-only.

## Branding

Product name: **Konofix Chat**. Author: **Swir**. Canonical repository: `https://github.com/Swir/Konofix`.
