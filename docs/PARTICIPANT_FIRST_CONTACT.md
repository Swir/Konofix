# Participant first contact: executable protocol candidate

Status: **local/component implementation, not a deployed service or desktop integration**.
The two-PC field failures remain unresolved. Real Internet Test stays 56/67; no
Audio 0.6.0 acceptance item is credited. Do not issue another installer as an
Internet repair because these modules exist.

## Intended ordinary-user workflow

Install and start Konofix. No extra Node executable, participant IP entry,
GitHub account, developer token, router procedure or required owner VPS.
The desktop remains the P2P participant; no chat/file/audio transport is replaced.

GitHub can publish an operator-reviewed read-only list of approved first-contact
endpoints. It cannot accept anonymous client writes into this repository.
GitHub Pages is static hosting, not the dynamic registration service. Shipping a
GitHub token, relying on GitHub Actions as a permanent relay, or treating an empty
JSON pool as working discovery is not an acceptable shortcut.

Sources:
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
- https://github.com/libp2p/specs/blob/master/peer-ids/peer-ids.md

## Implemented candidate

`services/discovery/participant-directory.mjs` implements expiring signed leases,
bounded registration, replay ordering, source-IP binding and rotating bounded
contact snapshots. `http-contact.mjs` implements a Request/Response handler and
credential-free HTTPS registration/lookup client with a whole-operation deadline,
stream-byte bounds and cancellation. No third-party package was added.

This is a **Konofix HTTPS contact-lease candidate**, not an implementation of the
libp2p `/rendezvous/1.0.0` wire protocol. Peer IDs use the canonical Ed25519 public-key
protobuf / identity multihash / base58btc representation. WebCrypto checks the
lease signature against the public key that derives the claimed Peer ID.

A lease signs a fixed UTF-8 JSON array, domain `konofix/participant-contact/1`,
schema, HTTPS origin, exact Konofix control-protocol identifier, public key,
Peer ID, one direct public IPv4/IPv6 address, TCP/QUIC ports, issue/expiry times
and sequence. The origin prevents cross-directory replay without re-signing.
The lifetime is at most 120 seconds with bounded future clock skew. Unknown
fields, type coercion, incorrect identity/signature, private/special IPs and
unbounded bodies are rejected. Keys, chat, nicknames, room names/passwords,
file descriptions and audio signaling are not accepted directory fields.

The hosting adapter must supply a trustworthy observed source IP; request
headers alone are NOT authoritative. A registrant cannot claim an unrelated
public IP. This is still **not proof of an externally reachable listening port**.
Only a subsequent authenticated libp2p connection and successful protocol
negotiation can establish identity, compatibility and reachability at that port.
Snapshot-to-multiaddress conversion requires a lease verified in this module.

This minimal candidate handles direct participant contact hints only. It does
not accept unverified relay claims, synthesize circuit reservations, replace the
existing relay selection or implement NAT traversal. A CGNAT client can query
for reachable participants but cannot become an available relay merely by
registering. If no usable direct path or reachable relay exists, discovery alone
cannot make the two applications communicate. Circuit Relay is not WebRTC media.

## Source, privacy, failure and cold start

No real provider or URL has been selected, embedded or activated. The constructor
requires an explicitly supplied HTTPS origin. `.invalid` origins and public-looking
IP literals occur only in tests; the tests never contact those hosts. The existing
production GitHub bootstrap pool/resolver and default endpoints remain unchanged.

A future service operator and querying participants can see registered public IPs,
ports, public keys/Peer IDs and lease timing. TLS ingress may retain access logs;
lease expiry does not erase such logs. No privacy claim about an unchosen provider
is made. Registration signatures authenticate key ownership, not a human identity,
unique person, reachability or protection from all Sybil attacks.

Per-source rates, source-bucket/entry limits and concurrent-verification caps bound
this component. Production ingress must additionally bound concurrent request-body
readers, enforce TLS, establish trusted source addresses, and apply its abuse policy.
Native cryptographic verification is used; no client API secret is needed.

When all participants leave, their leases expire and lookup returns an empty list.
Once new participants register with a live directory, it can again return contacts
without saved participant addresses. An unavailable service is reported as an error,
not empty success. Independent directories require separately origin-bound leases;
automatic multi-source retry/failover must be integrated into the desktop session.

The current directory is process-local state. A service restart loses leases and
sequence floors; participants must re-register, and an otherwise valid signed lease
can be replayed until its original expiry. Do not claim durable anti-replay or deploy
this Map independently across serverless isolates and call it a shared directory.
A selected provider needs a consistent state adapter (for example a properly scoped
shared actor) and endpoint-level restart/failover tests. No hosting has been deployed,
purchased or configured; any provider activation remains an explicit owner decision.

## Required next integration, not completed claims

1. Persist the desktop's existing native libp2p identity safely; reuse that exact key
   to sign this fixed lease domain without exposing private keys to JavaScript.
   Bound the signer to session ownership and never add a general arbitrary-sign IPC.
2. Select and authorize the real discovery service and its ingress/state/abuse policy.
   Verify endpoint bytes and independent reachability before listing it on GitHub.
3. Connect session-owned register/refresh/lookup, bounded retry, source failover,
   contact insertion and complete cancellation to the existing native network task.
   Do not reset nickname/session ownership or reopen microphone capture to refresh.
4. Advertise only appropriate observed/confirmed addresses. Keep first contact,
   observed transport, relay reservation, authenticated presence and successful
   application exchange separate in the status model. An HTTP 200 is not Internet PASS.
5. Qualify two fresh installed Windows applications on independent networks with
   WORLD, regular/protected rooms, private messages, files both ways and reconnect;
   add at least three participants and connector departure. Then qualify audio.

No runtime loopback/HTTP fixture, signature test, CI build or this document replaces
those field gates. Immutable releases, prerelease approval, exact-build qualification
and the existing sole hourly schedule are unchanged.

## Verification

Run `node --test scripts/test-participant-rendezvous.mjs` with Node 22.16 or newer.
There are 28 controlled cases: actual Ed25519 signatures, two fresh protocol clients,
expiry/empty/repopulation, alternate-directory scope, replay, capacity/rotation,
forged identity/source IP, malformed bytes, HTTP handling and cancellation/deadlines.
The existing remote-bootstrap test entry point also imports these cases; its original
20 regression cases are preserved byte-for-byte in a sibling test file.

Negative controls that remove signature verification, ingress-IP binding or expiry
cleanup must each make the suite fail. These are component evidence, not real network
or Windows runtime evidence. Native signer interoperability and hosting deployment
remain unverified.
