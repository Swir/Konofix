# Nickname trust boundary

Konofix uses two transports for nickname reservation signals, but they do not have the same authority.

## Authoritative path

GossipSub messages are signed by libp2p and the application requires the payload Peer ID to match the authenticated message source. A well-formed `NickClaim` from that path may participate in deterministic nickname conflict resolution.

## DHT path

The current JSON `NickLease` stored in Kademlia has no application-level signature. Neither the payload `peer_id` nor Kademlia `record.publisher` is proof that the claimed Peer ID created the lease, so DHT nickname records are non-authoritative hints only.

Before an unsigned hint is treated as structurally plausible, Konofix verifies Peer ID syntax, nickname validation/canonicalization, the exact DHT key, a live expiration, and an upper lifetime bound equal to the lease window plus a small clock-skew allowance. Even a valid unsigned hint cannot emit `nick-conflict`, disconnect a client, or reject its nickname.

A future signed lease may become authoritative only if its signature covers protocol/domain separation, canonical and display nickname, publisher Peer ID and expiration, and its public key proves the claimed Peer ID.

## Regression policy

`scripts/check-nickname-lease-trust.mjs` is part of `npm run audit`. Its adversarial companion verifies that removing DHT hint validation/key/lifetime checks, restoring DHT conflict authority, or removing GossipSub source binding fails closed. Rust unit tests cover the same structural boundaries.
