# Rooms 2.0 implementation roadmap

This is the detailed implementation plan for the `0.5.0 — Rooms 2.0` scope already declared in the authoritative `ROADMAP.md`. The authoritative active Global Beta readiness scope is currently 55/67 (82.1%); Rooms 2.0 implementation work must not inflate that percentage until the real production membership/count gate has end-to-end evidence.

## Stage 1 — state model and desktop lifecycle foundation

- [x] bounded temporary-room membership tracker,
- [x] monotonic local snapshot revisions,
- [x] authenticated-source validation for remote snapshots,
- [x] replay/stale/conflict handling,
- [x] bounded known-room registry,
- [x] local create/enter/world/close lifecycle adapter,
- [x] deterministic local + remote room-count deltas,
- [x] peer-departure cleanup.

## Stage 2 — network transport and live runtime wiring

The verified runtime now also has a tested `RoomMembershipProductionBridge` that maps every relevant network-loop lifecycle input to one `ApplicationMembershipEffects` contract. Production-bridge regressions additionally prove that a membership snapshot received before its room announcement does not poison revision state: after the room becomes known, the same authenticated revision can be applied exactly once. Three-peer switch/disconnect/room-close convergence is also covered before the live loop is changed. These tests reduce integration risk but do **not** close any production-loop item below.

- [x] bounded membership transport frame and deterministic codec,
- [x] transport adapter over the verified membership runtime,
- [x] authenticated source binding before remote mutation,
- [x] heartbeat/resync snapshot reuse without revision inflation,
- [x] two-client transport convergence and adversarial replay/source tests,
- [x] verified live-coordinator semantics for final-connection close, authenticated goodbye, presence expiry and room-close republish,
- [x] application-facing adapter for signed snapshot payloads and deterministic room-count emit payloads,
- [ ] add membership to the production GossipSub `WireEvent` contract,
- [ ] route backend room create/join/switch/world transitions through membership state,
- [ ] publish membership snapshots on transitions and heartbeat/resync,
- [ ] apply remote snapshots from the live network task,
- [ ] wire verified peer cleanup into final disconnect, authenticated goodbye and presence expiry handlers,
- [ ] close-room cleanup and republish when the local active room disappears.

## Stage 3 — accurate room-count UX

- [x] prepare the frontend `room-user-count` consumer, temporary-room badges and active-room header rendering while keeping WORLD on global presence,
- [ ] emit verified `room-user-count` deltas from backend runtime effects,
- [ ] update room-list counts end-to-end without falling back to global online presence,
- [ ] show the active room's synchronized count end-to-end in the chat header,
- [ ] keep `#WORLD` presence semantics separate from temporary-room membership end-to-end,
- [ ] reset membership-derived UI state on disconnect/reconnect.

## Stage 4 — verification and promotion

- [ ] exact-head Windows CI PASS for the live production-wiring implementation,
- [ ] exact-head Linux Node CI PASS for the live production-wiring implementation,
- [ ] multi-peer same-LAN room switch/replay test,
- [ ] public-network multi-peer room membership test,
- [x] document protocol compatibility and upgrade behavior (`docs/ROOMS2-PROTOCOL.md`),
- [ ] mark the two top-level `0.5.0` goals complete only after end-to-end application evidence exists.
