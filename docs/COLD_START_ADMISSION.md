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
