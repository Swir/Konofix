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
- CBOR request-response for file transfer and authenticated private control

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

## Optional KonoNexus/KNP coexistence

The ordinary login starts the primary libp2p session. Opening **Optional KNP contacts** starts a separate bounded contact-text actor owned by that primary session; returning to WORLD keeps both running. Closing KNP leaves libp2p running. Disconnecting or terminating the primary owner also stops its KNP child; late cleanup from an old primary session cannot stop a newer child. Persistent KNP profiles are exclusively locked on Windows. The lower-level transport foundation is opt-in (`enableKnpTransport`), avoiding an unused additional KNP identity on ordinary login.

| Conversation / operation | Route and identity | Failure semantics |
| --- | --- | --- |
| WORLD and public room announcements | Existing signed libp2p GossipSub, authenticated PeerID/source checks | Existing libp2p discovery and connection recovery; no KNP copy |
| Private control, protected room grants and direct files | Existing peer-bound libp2p request/response and authorization | Preserve replay, membership, consent, bounds and hash checks; no public GossipSub fallback |
| Optional KNP direct text | Explicitly admitted KNP NodeID + exact endpoint; separate UI and session | Distinct queued, transport-delivered and application-received states; no silent libp2p resend |

A KNP NodeID is **not** currently authenticated as the same identity as a libp2p PeerID. Automatic cross-protocol fallback would change recipient/security semantics and risk duplicate or misdirected delivery. This integration therefore selects the route by explicit conversation type, while retaining existing discovery, direct TCP/QUIC, relay and recovery within libp2p. Any future shared-recipient router needs authenticated identity binding, equivalent authorization and message deduplication before it can be enabled.

No account service, centralized message store or central history is added. A bootstrap supplies contact addresses; a relay is a replaceable transport participant. Neither is an authority for identities or history. Public WORLD remains public to its participants; transport encryption does not make a public room a private conversation.

LAN discovery uses mDNS without pasted addresses. Across the Internet, DHT/cache/Identify discovery can proceed after a reachable first contact; two fresh isolated nodes cannot discover arbitrary Internet peers from no contact information. CGNAT/symmetric NAT can require a reachable bootstrap/relay. A reservation at a relay is not evidence that a message used a relay, and a successful cloud test is not WAN acceptance. The remaining field acceptance scenarios are in `KNP_CHAT_BETA.md` and `TESTING.md`.

## Observed connection routes

`network-status.routes` is populated only by authenticated Swarm `ConnectionEstablished` events and removed by individual `ConnectionClosed` IDs. It distinguishes direct TCP, direct QUIC-v1 and circuit connections to the authenticated remote PeerID. Incoming circuit classification uses the local relay endpoint as required by libp2p, not just the remote address. Closing one connection does not erase another connection to the same peer or trigger peer-wide file/control cleanup.

The sidebar displays direct/relay connection counts. Network settings show a snapshot of the peer, connection type and endpoint observed at establishment; reopen it to refresh. Relay listen addresses are counted separately as reservations. Neither a reservation nor a direct connection to a relay participant proves a direct connection to another recipient. Route observations describe connections, not the path of a particular GossipSub message, and inbound/migrating endpoints are not necessarily dialable addresses. The local TCP/QUIC and controlled circuit tests are transport regressions, not independent-network acceptance.
