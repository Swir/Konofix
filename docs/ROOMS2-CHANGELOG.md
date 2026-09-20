# Rooms 2.0 development changelog

This scoped changelog records unreleased Rooms 2.0 work separately from stable `0.4.2` release notes. It does not change the active Real Internet Test percentage or stable-release readiness.

## Stage 2 — authenticated transport contract

- added `RoomMembershipNetwork`, a network-facing adapter over the verified membership runtime,
- added a bounded 16 KiB JSON wire contract for membership snapshots before parsing,
- bound claimed membership Peer IDs to the authenticated libp2p source before state mutation,
- preserved monotonic snapshot revisions for local room switches and idempotent heartbeat/resync publication without manufacturing new revisions,
- exposed deterministic per-room count deltas for frontend/event wiring,
- converged peer-departure and room-close cleanup through the same membership runtime,
- added integration coverage for two-client convergence, duplicate/replay handling, stale/conflicting revisions, forged source identities, unknown rooms, room switching and oversized frames.

### Still pending before Rooms 2.0 is user-visible

- insert the membership event into the production GossipSub `WireEvent` path,
- wire create/join/switch/world transitions through the backend command loop,
- publish heartbeat/resync membership snapshots from the live network task,
- remove peer membership on final connection close, authenticated goodbye and presence expiry,
- propagate verified `room-user-count` deltas into the desktop UI,
- complete exact-head Windows/Linux CI and real multi-peer application testing.
