# Experimental cold-start advertisement admission

This module is the application trust boundary for the next opt-in Amino adapter.
It is tested on Windows and Linux but is not yet connected to production discovery.
Draft #175 remains an earlier isolated wire experiment; neither change enables
public DHT traffic or qualifies automatic Internet WORLD.

Provider records only suggest peers. After an authenticated Noise connection, the
receiver issues a fresh 128-bit challenge and binds the response to that live
request, its local PeerID and current network generation. An Ed25519 advertisement
binds the experimental WORLD v2 namespace, public key, requester, challenge,
monotonic session sequence, issue/expiry seconds, endpoint list and relay consent
claim. The signature uses a domain-separated, length-delimited representation.
No nickname, room history, chat contents, file metadata or KNP identity is included.

The receiver accepts at most four distinct canonical literal-public-IP endpoints,
TCP or QUIC-v1, each ending in the authenticated PeerID. One relay hop is allowed
only via a different public endpoint identity. DNS, nested circuits, private,
loopback, CGNAT, link-local, multicast, documentation and IPv6 transition addresses
are rejected. DNS rejection prevents later rebinding in this untrusted path;
trusted seed DNS must be checked after resolution by the adapter's transport.
LAN mDNS and explicitly supplied contacts retain their existing policies.
An address or signed relay claim does not prove reachability or authorize using
an unrelated public DHT node as a relay.

Acceptance lasts at most 300 seconds, with both wall-clock and monotonic expiry.
Clock rollback fails closed. The 128-peer session cache keeps sequence tombstones
for the full maximum lifetime without LRU eviction under identity flood. A network
change clears accepted endpoints and advances the generation but preserves
unexpired replay tombstones. A response for an older generation cannot reintroduce
stale endpoints. The adapter must consume each pending request on every response,
including invalid responses, expire cache entries before use, and cancel requests
on network changes. A fresh challenge remains mandatory even after cache expiry;
the sequence cache alone is not a durable cross-session replay ledger.

The transport codec must cap responses at 4096 bytes before decoding and bound
pending requests, dials and per-peer/global rates. Those runtime responsibilities
are deliberately separate from this deterministic admission policy. Anonymous
identity creation is not prevented; bounds limit local cost, not Sybil identities.

Amino uses `/ipfs/kad/1.0.0`; the application's DHT stays `/konofix/kad/1.0.0`.
The WORLD key is a SHA2-256 multihash of `konofix/experimental/world/v2`, not a
nickname or arbitrary DHT value. The [IPFS specification](https://specs.ipfs.tech/routing/kad-dht/)
gives provider records a 48-hour validity and provider addresses a 24-hour TTL.
Our five-minute acceptance does **not** shorten remote retention. Public observers
can learn IPs, PeerIDs, namespace interest and timing; encrypted transport does not
hide those metadata. No public interoperability or two-PC WAN PASS is claimed.

## Isolated runtime adapter

The client adapter now owns a separate Amino swarm using the application's libp2p
key. It has no GossipSub, native DHT, KNP or relay-server behaviour, listens on no
ports and explicitly stays a DHT client. The native application must serve the
v2 advertisement protocol on its own advertised endpoints before enabling it.
This PR still does not enable the adapter in desktop startup.

A lookup runs at most once per five minutes; interface recovery may request an
earlier lookup but retains the shared budget of 64 resolved dials per five minutes.
At most 16 established connections, four pending dials, four ad requests and eight
provider candidates per lookup are allowed. Queries expire after 15 seconds;
requests after five seconds. TCP+Noise/Yamux and QUIC use the existing dependencies.
Public IP filtering is below DNS, and only the three pinned official bootstrap
DNS multiaddresses may enter DNS resolution. DHT-supplied DNS names are rejected.
These bootstrap names are best-effort community utilities, not three independently
operated Konofix relays or a production availability guarantee.

Network changes discard the adapter's sockets, queries, pending challenges and
resolver configuration. The native identity, replay tombstones and dial budget
survive; old-generation responses cannot return a contact. Provider publication
requires independently confirmed public reachability plus direct public native
endpoints, with a five-minute retry/change budget and a 22-hour normal refresh.
Losing reachability removes local advertisements; it cannot erase remote caches.
A signed ad is generated on demand and expires independently after five minutes.

Local tests use three real TCP/Noise swarms and a loopback-only test transport.
They verify DHT discovery followed by the production request/response decoder,
challenge/signature admission and generation invalidation. Claimed public endpoint
literals in these tests are syntax fixtures and are never dialed. No local test
contacts the public bootstrap list.

A manually ignored `public_amino_read_only_once` test is available for one explicitly
authorized interoperability trial. It reserves a new evidence file before traffic,
performs one GET_PROVIDERS query in a UUID-scoped experimental test namespace, and
stops within 30 seconds. It writes no provider/value records, sends no chat and
claims no physical-WAN acceptance. A remote short provider TTL cannot be requested;
read-only probing avoids creating a 48-hour provider entry. CI never enables this
test. Failed attempts are preserved, not overwritten or retried until green.
