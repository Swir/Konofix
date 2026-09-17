# File-transfer security

Konofix file transfer runs over authenticated libp2p request/response streams. The receiver treats every inbound offer and control message as untrusted network input and keeps transfer state bound to the authenticated remote Peer ID.

## Admission limits

- At most four incoming transfers/offers can occupy receiver capacity at once.
- A single remote peer may keep only one unanswered file offer pending. This prevents one peer from reserving every receiver slot.
- Unanswered offers expire after 45 seconds. Expiry removes the pending state and attempts to return a rejection so request/response resources are not retained indefinitely.
- Transfer IDs must be UUIDs and cannot collide with another active incoming, outgoing or pending transfer.
- Declared file size is capped at 32 GiB and chunks are capped at 256 KiB.

## Integrity and identity

Accepted chunks must arrive from the Peer ID that created the offer and at the exact next byte offset. The receiver rejects overflow past the declared size. Completion is accepted only from that same peer and only with a canonical 64-character SHA-256 digest. The temporary file is promoted to its final download name only after the received byte count and SHA-256 both match.

Signed chat/presence/room events are separately bound to the authenticated GossipSub source identity. These controls do not replace the real cross-country Relay/DCUtR/CGNAT release gates; they reduce local protocol abuse risk while those real-network tests remain pending.
