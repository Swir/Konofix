# Rooms 2.0 protocol compatibility and upgrade behavior

Status: **unreleased 0.5.0 design/implementation contract**. This document describes the verified Rooms 2.0 membership components already present in the repository and the compatibility rules the production `WireEvent` integration must preserve. It does **not** claim that Rooms 2.0 is user-visible end to end yet, and it does not change the active `0.4.2 — Real Internet Test` milestone.

## Scope

Rooms 2.0 adds synchronized membership for temporary rooms while keeping `#WORLD` presence semantics separate. The membership layer is volatile P2P session state; it is not a durable account, roster, moderation, or message-history system.

The current verified membership transport is `RoomMembershipNetworkEvent::MembershipSnapshot`:

```text
membership_snapshot
  peer_id:  canonical libp2p PeerId string
  revision: monotonically increasing u64 for that live peer/session
  rooms:    bounded temporary-room IDs
```

`#WORLD` is intentionally not represented as a temporary-room membership. An empty `rooms` set means that the peer is not currently inside a synchronized temporary room.

## Authentication boundary

A membership claim is trusted only after the outer signed GossipSub message supplies an authenticated libp2p source Peer ID. The claimed `peer_id` inside the snapshot must match that source before any room-count mutation occurs.

The production integration must not treat a payload Peer ID, room owner string, DHT record, frontend state, or unsigned transport metadata as equivalent authentication.

## Bounds and validation

The membership transport keeps a hard **16 KiB** frame ceiling before JSON parsing. Room IDs then pass the existing bounded membership/runtime validation rather than being accepted directly by the network event loop.

The live production bridge deliberately routes decoded `peer_id`, `revision`, and `rooms` fields back through the verified membership transport. This preserves source binding, frame geometry, known-room validation, deterministic count deltas, and replay/conflict handling in one place.

## Revision and replay rules

Revisions are monotonic for one live peer/session:

- a newer valid revision may replace the peer's previous temporary-room membership,
- the same revision with the same membership is a duplicate and must not double-count,
- an older revision is stale and must not roll state backward,
- the same revision carrying different membership is a conflict and must not mutate trusted counts,
- heartbeat/resync republishes the currently committed snapshot without manufacturing a new revision.

A reconnect/new Peer ID starts a new live membership identity. No durable revision history is inferred across unrelated Peer IDs.

## Departure and room-close convergence

Remote membership is removed through idempotent authoritative lifecycle paths:

- final libp2p connection close only after no established connection to that Peer ID remains,
- authenticated `Goodbye`,
- presence expiry,
- room closure for membership associated with the closed temporary room.

A transient close while another connection remains established must not decrement room membership. Duplicate departure signals must not double-decrement counts.

If the local peer is inside a room that closes, the membership runtime produces a monotonic leave snapshot for republishing so other capable peers can converge.

## Mixed-version behavior

The 0.5.0 production wire change must be additive to the existing signed GossipSub event family. Existing 0.4.x presence, chat, nickname, room-create, and room-close messages remain valid and retain their current meaning.

A 0.4.x client does not understand the future membership event and therefore cannot contribute synchronized temporary-room counts. The 0.5.0 UI must never silently replace a verified temporary-room membership count with the global `#WORLD` online-presence count. In a mixed-version swarm, temporary-room counts describe only membership evidence actually accepted by the Rooms 2.0 runtime.

This limitation is preferable to fabricating completeness. Compatibility may later gain an explicit capability advertisement, but no such capability is claimed by the current implementation.

## Upgrade rules for 0.5.0 production wiring

The production integration is accepted only if all of the following remain true:

1. Membership enters GossipSub through the authenticated `WireEvent` path and cannot bypass source verification.
2. Local create/join/switch/return-to-world transitions use the membership runtime instead of frontend-only state.
3. Transition snapshots and revision-stable heartbeat/resync snapshots are actually published.
4. Remote snapshots are applied only through the verified live coordinator.
5. Final disconnect, authenticated goodbye, presence expiry, and room-close cleanup converge through the same idempotent runtime.
6. `room-user-count` UI events originate from verified runtime deltas, while `#WORLD` keeps presence semantics.
7. Disconnect/reconnect clears membership-derived UI state.
8. Exact-head Windows and Linux CI are green and multi-peer application evidence exists before the top-level 0.5.0 goals are marked complete.

## Wire compatibility discipline

Until 0.5.0 is released, the Rooms 2.0 wire shape is internal and may still change on development branches. Once released, incompatible field or semantic changes require an explicit protocol-version migration rather than silently reusing the same event meaning.

Unknown, malformed, oversized, forged, stale, or conflicting membership input must fail closed without changing trusted membership counts. Compatibility must never weaken those checks merely to make mixed-version peers appear synchronized.
