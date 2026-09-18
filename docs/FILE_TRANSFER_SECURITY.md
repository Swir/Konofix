# File-transfer security

Konofix file transfer runs over authenticated libp2p request/response streams. The receiver treats every inbound offer and control message as untrusted network input and keeps transfer state bound to the authenticated remote Peer ID.

## Admission limits

- At most four incoming transfers/offers can occupy receiver capacity at once.
- A single remote peer may keep only one unanswered file offer pending. This prevents one peer from reserving every receiver slot.
- Unanswered offers expire after 45 seconds. Expiry removes the pending state and attempts to return a rejection so request/response resources are not retained indefinitely.
- Accepted incoming transfers expire after 120 seconds without a successfully written non-empty chunk. Expiry releases the receiver slot, deletes only that transfer's owned `.konofixpart` path, and emits a failed-transfer update instead of allowing an abandoned sender to retain capacity indefinitely.
- When the last established connection to a remote Peer ID closes, Konofix immediately releases that peer's unanswered offers and accepted incoming transfers. Pending offer dialogs are invalidated and transfer-owned temporary files are cleaned without touching state owned by other peers.
- The same final-connection boundary now reclaims outgoing transfers owned by that disconnected Peer ID instead of waiting for the request/response timeout. Each reclaimed sender slot emits a deterministic failed-transfer update, and only request metadata tied to those reclaimed transfer IDs is pruned; unrelated peers and requests remain untouched.
- Transfer IDs must be UUIDs and cannot collide with another active incoming, outgoing or pending transfer.
- Declared file size is capped at 32 GiB and chunks are capped at 256 KiB. Empty chunks are rejected and do not refresh receive-side liveness, so a sender cannot keep a slot alive with zero-byte traffic.

## Integrity and identity

Accepted chunks must arrive from the Peer ID that created the offer and at the exact next byte offset. The receiver rejects overflow past the declared size. Only a successfully written non-empty chunk refreshes the accepted transfer's inactivity timer; wrong-peer, wrong-offset, oversized, empty and failed writes do not extend the lease. Completion is accepted only from that same peer and only with a canonical 64-character SHA-256 digest. Before a verified transfer is exposed under its final filename, Konofix flushes and synchronizes the owned temporary file.

Outgoing disconnect cleanup never treats a single closed transport as terminal when another connection to the same Peer ID remains established. Cleanup runs only at `num_established == 0`, so multi-connection TCP/QUIC/relay sessions cannot be failed prematurely. Late request/response events for reclaimed transfer IDs are ignored because their metadata has already been removed, while metadata for unrelated transfers remains eligible for normal completion/failure handling.

## Local filesystem safety

Incoming downloads are reserved with an exclusive `create_new` open of `<candidate>.konofixpart`; Konofix no longer relies on a separate `Path::exists()` check followed by a truncating create. If another process or Konofix instance already owns the partial name, the receiver retries a numbered destination without touching that file. After an exclusive temporary reservation succeeds, the receiver checks the corresponding final path again; if that final name appeared concurrently, Konofix deletes only the temporary file it just created and retries another candidate.

After path/separator/control-character sanitization, the receiver also bounds the encoded UTF-8 filename component to 180 bytes before adding numbered collision suffixes or `.konofixpart`. Short extensions are preserved when truncation is required. The byte-oriented bound is intentionally conservative across Windows and Unix-style filesystems: a remote filename made mostly of multi-byte Unicode characters cannot pass a character-count limit and then exceed a typical 255-byte/component boundary when the temporary or retry suffix is added.

Verified data is promoted with an atomic same-directory hard link to the final path. Hard-link creation fails if the final destination already exists, so a file created by another local process during the transfer is never overwritten. Konofix then removes its own `.konofixpart` link. If the filesystem cannot provide this no-clobber hard-link guarantee, finalization fails closed and removes only the transfer-owned temporary file instead of falling back to an overwrite-prone rename.

Regression tests cover pre-existing partial files with sentinel bytes, concurrent reservations for the same requested filename, a final destination appearing after temporary reservation, bounded reservation exhaustion, no-clobber finalization, successful promotion, multi-byte filename byte bounds plus retry/temporary suffix geometry, pending-offer TTL boundaries, accepted-transfer inactivity TTL boundaries, final-connection-only cleanup, peer-scoped outgoing reclamation and scoped request-metadata pruning. Cancellation, rejected/failed acceptance, hash mismatch, disconnect, inactivity timeout and finalization failure clean up only state owned by the affected transfer.

Signed chat/presence/room events are separately bound to the authenticated GossipSub source identity. These controls do not replace the real cross-country Relay/DCUtR/CGNAT release gates; they reduce local protocol abuse risk while those real-network tests remain pending.
