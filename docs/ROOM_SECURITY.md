# Room lifecycle security

Konofix room announcements travel over authenticated GossipSub, but authenticated transport identity does not authorize a peer to replace state owned by another Peer ID.

## Ownership invariant

The first accepted owner of an active room ID keeps that ID until the room is closed. A later `RoomCreate` for the same ID is accepted only when it is an idempotent refresh from the same owner. Announcements from a different authenticated owner are rejected and reported as a network warning.

Local room creation uses the same admission policy before the room is inserted or published, so local and remote state follow one rule.

## Resource bounds

A single owner may hold at most 16 active rooms and the in-memory room map is capped at 256 active rooms. These bounds prevent one authenticated peer from growing room/UI state without limit while preserving normal temporary-room usage.

## Regression coverage

Rust tests cover cross-owner takeover rejection, same-owner idempotent refresh, the per-owner cap and the global cap. Real Internet Test progress is unchanged because this is local protocol/state hardening rather than public-network evidence.
