# Participant discovery recovery — 0.6.0 development checkpoint

The owner reaffirmed on 2026-09-27 that the desktop application itself is a
participant node/connector. A separate Node installation or an owner-operated
VPS is not the required user workflow. See PR #150 comments 5859824864 (failed
field test) and 5859878303 (corrected product requirement).

## Implemented recovery, not cold-start completion

The existing optional HTTPS contact-list reader now has a hard deadline covering
headers and the entire response body, a 64 KiB actual-byte bound, strict UTF-8,
limited contact count/length, explicit stream cancellation and rejection of
malformed snapshots. A non-settling fetch adapter cannot hold the login flow
indefinitely merely because it ignores AbortSignal. Normal browser fetch is still
aborted; the deadline does not replace cancellation.

The client remembers only the last valid contact-list snapshot in local browser
storage for up to 15 minutes. A source outage may reuse those contacts without
extending their lifetime. Expired/future/wrong-source/malformed cache entries are
ignored. A valid empty remote list explicitly withdraws cached contacts. Late or
superseded responses cannot overwrite newer cache state. Storage denial does not
block a valid live response. Requests omit credentials and refuse redirects.

These are contact hints from the same repository HTTPS source already used by
0.6.0, not new infrastructure, verified reachability, nickname authority, or a
security allowlist. They may refer to ordinary reachable Konofix participants.
Rust multiaddr/Peer-ID parsing, authenticated libp2p transport, manual contact
ordering, built-in/environment contacts and backend peer cache remain unchanged.
The new cache never stores messages, files, passwords, keys, or microphone data.

## Actual verification

The existing audit entry `test-remote-bootstrap-discovery.mjs` executes the
production TypeScript module with Node 22 type stripping and native Response /
ReadableStream objects, using controlled fetch/storage adapters. Twenty local
cases pass, covering live/recovery/withdrawal, cold empty start, expiry, storage
denial, hard deadlines, cancellation, late/concurrent results, byte limits and
UTF-8 boundaries. The original source blob
`2851ce34a9ecdd7a0769ec7f6a712bb088e4e8e0` is rejected by the same hard-deadline
case. This demonstrates an adapter-resilience gap, not proof that the user's
reported failure was a hung browser fetch.

Full repository TypeScript/build checks, installed Windows WebView behavior and
real independent-network communication remain separate required gates. No new
installer, Internet/audio PASS, release or roadmap credit follows from these
controlled tests. Real Internet Test remains 56/67; no checkbox is changed here.

## Still blocking the requested experience

At the inspected base `6a070cf6e8cb9bd4f747c413fc816b5c59639d09`, the packaged
contact pool and the remote main-branch pool both have `seeds: []`. Two completely
new isolated clients still have no initial contact, and this patch intentionally
returns no fabricated contact for that case. The HTTPS file is not a live registry
and running the app does not publish a contact there. This patch therefore does
NOT resolve the negative two-PC Internet result.

The next first-contact step must explicitly settle how a clean client learns an
actual running participant's address and how the network restarts after all prior
participants leave. Any new external discovery dependency must be disclosed and
approved rather than silently introduced. Do not scan arbitrary Internet hosts,
use incompatible public bootstrap networks, embed API credentials, or substitute
an obligatory headless Node/VPS for the desktop-participant model. Peer exchange,
DHT and relay recovery must also be tested with at least three participants and
loss of a connector; they do not themselves supply a first contact from nothing.
