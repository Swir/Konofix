# Participant first contact: executable protocol candidate

Status: **startup lookup integrated in source; native registration and public deployment incomplete**.
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
headers alone are NOT authoritative. The candidate provides a bounded
`GET /v1/observe` step so a fresh participant can learn the address seen by
trusted ingress before creating a lease. A registrant still cannot claim an
unrelated public IP. This is **not proof of an externally reachable listening port**.
Only a subsequent authenticated libp2p connection and successful protocol
negotiation can establish identity, compatibility and reachability at that port.
Snapshot-to-multiaddress conversion requires a lease verified in this module.

This minimal candidate handles direct participant contact hints only. It does
not accept unverified relay claims, synthesize circuit reservations, replace the
existing relay selection or implement NAT traversal. A CGNAT client can query
for reachable participants but cannot become an available relay merely by
registering. If no usable direct path or reachable relay exists, discovery alone
cannot make the two applications communicate. Circuit Relay is not WebRTC media.

## Desktop startup lookup integration

The existing `src/main.ts` connect flow calls `loadRemoteBootstraps`, merges its
result with saved custom contacts and passes it to the native `start_network`
command after checking the current session revision. That production resolver now
also consumes an optional `contact_origins` array from the same schema-1 GitHub
pool. It accepts at most two distinct canonical HTTPS origins. The existing pool
is not changed: no origin, provider or live contact is introduced by this commit.
Only add origins after operator approval and endpoint qualification.

The resolver invokes the shared verified HTTPS lookup client, validates every
returned lease, converts only verified records to TCP/QUIC multiaddresses and
hands those hints to the existing native path. This lookup does not register the
current user, send nicknames, expose keys, restart an active session or open audio.
The existing total limit of 16 remote addresses is preserved, static seeds retain
priority, duplicate addresses are removed and origins contribute in round-robin
order. An unavailable/invalid directory does not suppress another completed source
or static/manual contacts. The original 1.8-second whole-operation deadline also
covers directory lookups; stalled operations are cancelled and cannot write late
results. Lease freshness is rechecked at the actual handoff boundary.

Only operator-managed static seeds enter the existing 15-minute recovery cache.
Short-lived signed leases and the origin list never enter that cache. This does
not erase subsequently authenticated native peer-cache entries or undo established
P2P connections. A valid empty origin list withdraws future directory requests;
there is no implicit fallback to an unrelated service. Per-source failures are
caught at startup to preserve the manual/LAN path, not reported as an Internet
success. Per-source UI diagnostics and ongoing session-owned refresh remain open.

`contactHandler(directory, { allowedOrigins })` now provides exact-origin CORS for
the browser/WebView consumer and bounded GET/JSON-POST preflight handling. The
hosting adapter must supply the exact packaged application origin(s), verified on
the target WebView. The default empty allowlist denies requests carrying Origin;
non-browser requests without Origin still go through all original validation.
There is no wildcard or credentialed CORS, reflected lookalike origin, or trust in
forwarding headers. CORS is not peer authentication: native clients can omit or
spoof Origin, so signature/source-IP/rate checks remain mandatory. TLS, actual
browser CORS enforcement and hosted ingress configuration still need qualification.

## Source, privacy, failure and cold start

No real provider or URL has been selected, embedded or activated. The constructor
requires an explicitly supplied HTTPS origin. `.invalid` origins and public-looking
IP literals occur only in injected tests; the tests never contact those hosts.
The production GitHub bootstrap pool and default endpoints remain unchanged.

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
without saved participant addresses. This requires the still-missing native desktop
registration/signing integration. At the HTTP-client level an unavailable service
throws instead of being represented as an empty successful snapshot. Independent
directories require separately origin-bound leases; ongoing refresh/retry/failover
must still be integrated with ownership of the actual native network session.

The current directory is process-local state. A service restart loses leases and
sequence floors; participants must re-register, and an otherwise valid signed lease
can be replayed until its original expiry. Do not claim durable anti-replay or deploy
this Map independently across serverless isolates and call it a shared directory.
A selected provider needs a consistent state adapter (for example a properly scoped
shared actor) and endpoint-level restart/failover tests. No hosting has been deployed,
purchased or configured; any provider activation remains an explicit owner decision.

## Required next integration, not completed claims

1. The desktop now persists its native Ed25519 libp2p identity in per-user local
   application data and the production swarm reuses that exact key after restart. Corrupt
   identity bytes fail closed rather than silently rotating the Peer ID. The remaining
   identity task is a narrow native contact-lease signer bound to this fixed domain and
   session ownership; never expose private key bytes or add a general arbitrary-sign IPC.
2. Select and authorize the real discovery service and its ingress/state/abuse policy.
   Verify endpoint bytes and independent reachability before listing it on GitHub.
3. Connect session-owned registration/refresh and ongoing lookup, bounded retry,
   contact insertion and complete cancellation to the existing native network task.
   Startup lookup alone does not close that lifecycle. Do not reset nickname/session
   ownership or reopen microphone capture to refresh.
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

Run `node --experimental-strip-types scripts/test-remote-bootstrap-discovery.mjs`
with Node 22.16 or newer. The original 20 production-resolver cases remain unchanged;
the protocol suite still tests real Ed25519 signatures, expiry, replay, admission,
identity/source-IP validation, observation and deadlines. The startup-consumer suite
adds 16 cases, exact-origin CORS adds eight and the existing production `connect`
function has three injected DOM/IPC argument/lifecycle cases. These are component
and source-integration tests, not installed Windows or Internet evidence.

The previous resolver must fail the signed-snapshot consumer case. Removing the
CORS boundary must fail the allowed-origin/preflight cases. Protocol negative
controls for signature verification, ingress-IP binding and expiry remain required.
The full TypeScript/Vite build and installed WebView checks belong to exact-head
Windows CI; native signer interoperability and hosting deployment remain unverified.
