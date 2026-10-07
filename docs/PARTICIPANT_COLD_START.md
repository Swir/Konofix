# Participant-owned cold start: experimental design

Status: proposed architecture plus a default-off, **loopback-only** compatibility POC.
This does not fix WAN FAIL [#165](https://github.com/Swir/Konofix/issues/165),
supply a live public peer, or authorize beta publication. Updated 2026-10-07.

## Product requirement

An ordinary installation participates in the network without an operator-owned
VPS, account, message server or central history. LAN uses mDNS. Across networks,
a shared public overlay may supply **initial contact information only**. Once
connected, Konofix participants maintain discovery and routing; publicly
reachable, consenting applications can offer bounded, rotating relay capacity.
The optional headless Node and the three-operator deployment kit remain useful
voluntary contributions, not a mandatory topology or prerequisite imposed on
the user. Manual address entry is diagnostic, not successful product acceptance.

Every application is a full application peer. This cannot mean forcing every
CGNAT endpoint into a publicly dialable DHT server role: unreachable routers
poison lookup paths. All clients query and maintain local routing state; eligible
public clients additionally serve WAN DHT queries and, with consent, relay
circuits. Private clients still participate in chat, peer exchange, and LAN
discovery. Losing public reachability withdraws the server/relay offer.

Two fresh peers behind restrictive CGNAT cannot communicate merely by learning
each other's addresses. They need a reachable participant to synchronize/relay,
or an accessible external transport overlay such as Tor/I2P. No operator VPS
does not mean no public network participants. If all routes/overlays are blocked,
the truthful outcome is unavailable, never an invented direct connection.

## Options and actual compatibility

| Option | Compatibility / transport | Metadata and operational constraints | Decision |
| --- | --- | --- | --- |
| Mainline BitTorrent BEP5 | Different UDP KRPC/bencode protocol; not rust-libp2p Kad. Compact IP/port results do not authenticate a libp2p PeerID. UDP blocking prevents discovery; NAT source-port discovery does not make TCP/QUIC reachable. | Public lookup key, source IP and port; no BEP5 signed application envelope. IP-bound write tokens mitigate spoofed announcements, not Sybil/eclipse. BEP42 adds IP-related node-ID constraints, not identities with scarce cost. BEP44 adds signed mutable items but needs known publisher keys and is a separate extension. | Do not implement fake torrent announcements or assume public torrent nodes relay Konofix. Additional maintained client dependency, licence review and an operationally appropriate namespace/bootstrap policy would be needed. |
| IPFS Amino DHT | Existing rust-libp2p 0.57 supports the libp2p wire protocol. Use a **separate** behaviour/swarm with `/ipfs/kad/1.0.0`; keep `/konofix/kad/1.0.0` unchanged. TCP works without UDP; QUIC needs UDP. Provider keys are multihashes. | Public PeerIDs, addresses, lookup interest and timing; encrypted links do not hide these from routing peers. Providers are untrusted candidates, not authenticated Konofix members or consenting relays. IPFS permits only its validated value namespaces, not arbitrary application PUT_VALUE records. Official bootstrappers are best-effort utilities, not a production SLA or proof of operator independence. | Best candidate for a bounded discovery experiment. The included POC uses no public endpoint and does not publish to Amino. Public rollout needs the additional gates below. |
| Independent Konofix / KonoNexus overlay plus three entry participants | Konofix libp2p Kad and KonoNexus KNP UDP DHT are different protocols/identities, not interchangeable Kademlia networks. Three independently operated participants improve initial-contact diversity only if actually reachable. | Community participants can be ordinary consenting apps; stable VPSs are optional. An empty pool cannot cold-start. Native limits and signed app advertisements are under project control, but cheap identities still permit Sybil attacks. | Keep the native participant network as the foundation. The existing deployment package is optional infrastructure, not the product's sole WAN solution. No public KNP seeds have been authenticated/reachability-qualified for this build. |

Sources: [BEP5](https://www.bittorrent.org/beps/bep_0005.html),
[BEP42](https://www.bittorrent.org/beps/bep_0042.html),
[BEP44](https://www.bittorrent.org/beps/bep_0044.html),
[Amino specification](https://specs.ipfs.tech/routing/kad-dht/),
[IPFS public utilities](https://docs.ipfs.tech/concepts/public-utilities/),
[rust-libp2p IPFS example](https://github.com/libp2p/rust-libp2p/tree/master/examples/ipfs-kad),
[libp2p routing discovery](https://github.com/libp2p/go-libp2p/blob/master/p2p/discovery/routing/routing.go).
The POC adds no dependency: it reuses the existing locked MIT-licensed
[rust-libp2p](https://github.com/libp2p/rust-libp2p/blob/master/LICENSE).
BEP5's public-domain specification is not a licence for every implementation
or permission to consume arbitrary public services without limits.

## Proposed flow and boundaries

1. Start native TCP/QUIC, mDNS and WORLD membership normally. Use the bounded
   local cache of previously authenticated participants; invalidate stale routes
   on a network-generation change. KNP remains optional and separately identified.
2. If no native contact exists, a replaceable discovery adapter queries a
   versioned application namespace. Do not turn the chat swarm into an IPFS node,
   subscribe public IPFS peers to WORLD, or send chat/history through a gateway.
   Resolve a bounded number of candidates, then stop the cold-start search.
3. Treat provider results as hints. Authenticate the exact PeerID over Noise/QUIC,
   negotiate the Konofix announcement protocol, then verify its signature,
   scope and expiry before admitting it. Never infer KNP NodeID equivalence.
   No nickname, private room, message content or history goes into discovery.
4. Production advertisements must bind authenticated identity, network/version,
   endpoint set, issue/expiry, sequence/generation and explicit relay consent.
   Limit accepted lifetime to ten minutes, wire bytes and addresses; reject
   future/expired, tampered and conflicting records. Verify public IPs after DNS
   resolution, reject private/link-local/loopback targets from public discovery,
   and bind every dial to its expected PeerID. A signature proves a key-holder's
   claim, not address reachability, honest conduct or operator independence.
5. Try direct routes first. Use AutoNAT observations from independent peers and
   UPnP where available. Acquire a bounded reservation only from a consenting,
   authenticated participant advertising compatible circuit-v2; use DCUtR to
   upgrade to direct and retire unneeded circuits. A bootstrap is not a relay,
   a reservation is not a recipient connection, and KNP is not circuit-v2.
6. Public apps rotate relay offers with reachability, consent and capacity.
   Proposed initial budgets: 8 reservations, 2 active circuits, 1 circuit/peer,
   8 MiB and 120 seconds/circuit, plus global bandwidth/connections/handshake
   limits and per-address-prefix limits. These are a design starting point,
   **not implemented production limits in this POC**. No arbitrary proxy/exit,
   no room history; encrypted endpoint streams retain existing authentication.
7. Network change cancels the old generation's lookups/dials, withdraws old
   advertisements/reservations, rechecks listeners/AutoNAT/UPnP, and performs
   jittered bounded rebootstrap followed by WORLD provider/presence reannouncement.
   Delayed old-generation callbacks must not repopulate the current route cache.

Discovery adapters need a global query/dial budget, bounded deduplication/cache,
backoff and cancellation. Query different routing paths/peer IP groups, not just
different DNS aliases for one service. Persist only authenticated successful
contacts with expiry. Signatures, IP grouping, disjoint lookups and reputation
limit particular attacks but do **not** solve open-membership Sybil resistance.
A single public WORLD key also risks provider-list saturation; namespace
rotation/sharding must be measured before deployment, not added as an unbounded
search multiplier. Rotation is not anonymity: the namespace is public.

Short-lived application acceptance does not erase metadata. Amino provider
records normally live for 48 hours and provider addresses for 24 hours; remote
operators/observers may retain them longer. Do not promise a ten-minute network
retention limit or try to change other nodes' TTL with local configuration.
Avoid frequent provider writes; the public cold-start announcement cadence,
daily key overlap and provider eviction behaviour require a measured trial.

UI target: distinguish LAN-only, looking for Internet participants, direct,
circuit relay, hole-punch upgrade, Tor/I2P and no available route. Show voluntary
relay status/capacity separately from the user's route. A DHT connection alone
must never light a global-connected or WAN-PASS indicator.

## Optional final transport: Tor or I2P

Tor onion services can be hosted by clients behind NAT using outbound circuits;
they do not require a Konofix-owned VPS or an exit relay. Stream transport needs
an embedded/client-managed Tor implementation, onion-service lifecycle, a
libp2p transport adapter and authenticated binding to the existing identity.
SOCKS TCP is not a tunnel for arbitrary UDP/QUIC. Onion addresses must still be
discovered; Tor is not a global Konofix user directory. Circuit latency, startup,
censorship and connection budgets differ from native direct transport.

I2P offers bidirectional reliable streams via a local SAM router session and
Destinations. A stream adapter, router lifecycle/packaging and destination
discovery are still needed. Keep one long-lived session rather than creating
tunnel pools per chat/dial. I2P's underlying TCP/UDP reachability and reseeding
also depend on an available external network. Neither option guarantees access
from a network that blocks all usable routes.

These are optional last-resort transport candidates, not currently implemented
or tested fallbacks. Do not silently change privacy expectations or send a
private conversation into public WORLD when switching transport. WORLD remains
a **public signed room with encrypted links**, not a private recipient-only E2E
room; existing protected-room and direct-message security contracts remain in
force. Hiding IPs from other users additionally requires preventing direct/DHT
metadata leakage, not merely adding an onion connection.

Sources: [Tor onion-service protocol](https://community.torproject.org/onion-services/overview/),
[Arti current status](https://arti.torproject.org/FAQs/),
[I2P SAMv3](https://i2p.net/en/docs/api/samv3/),
[DCUtR](https://github.com/libp2p/specs/blob/master/relay/DCUtR.md).
No Tor/I2P package is added here; binary licensing, updates, Windows startup/
shutdown and resource controls must be reviewed before bundling one.

## What the opt-in POC actually proves

`experimental-amino-discovery` has no default activation and no application
wiring. The test executable is excluded unless this Cargo feature is explicit:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --features experimental-amino-discovery --test amino_discovery_poc
```

Three fresh local libp2p swarms use real TCP, Noise, Yamux, Amino provider
messages and a bounded CBOR request/response handshake. One local fixture acts
as a DHT server; the publisher/seeker are clients. The seeker knows only that
fixture, discovers the publisher through GET_PROVIDERS, authenticates its
PeerID and retrieves a signed, expiring role announcement. No public bootstrap,
DNS, UDP, relay, KNP or chat traffic is generated. The local fixture is test
infrastructure, not a proposed central service.

The proof has bounded query/stream sizes and a 20-second test deadline. Negative
tests cover peer substitution, tampering with expiry/relay consent, future and
expired times, excessive TTL, malformed signature length and overflow edges.
The announcement deliberately has no endpoint list, sequence/cache or room
payload: these require a separate reviewed production protocol. Replay within
the accepted lifetime is not prevented by this minimal POC. Provider entries
are not themselves treated as signed app announcements.

Passing this test demonstrates a local building block, not public Amino
interoperability under load, discovery after network change, mDNS regression,
relay consent enforcement in the desktop, Sybil resistance or physical WAN.
Existing default-path tests remain separate and must stay green.

## Gates before a public, default-on implementation

- A bounded trial using real documented public entry points, with current
  service policies/limits checked, explicit test opt-in and source-bound logs;
  no fictional endpoints, random-node relay assumptions or published keys.
- Actual default-client routing/server-mode and voluntary relay lifecycle,
  endpoint policy, resource limits, network-generation/reconnect tests,
  cancellation and malicious-provider tests; preserve zero-config LAN.
- Verify cold start and provider diversity/eviction with more than two peers;
  remove a discovered relay, switch Wi-Fi to LTE and prove convergence.
- Two clean physical Windows installations on different operators automatically
  join WORLD and exchange messages without manual addresses or an operator VPS.
  Record direct/circuit/relay (and any overlay) from actual endpoints. Preserve
  the failed run and every subsequent report without overwriting. Only the
  observed scenario can pass; publication remains HELD until its real gates pass.
