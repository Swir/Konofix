# Rooms 2.0 implementation roadmap

This is the detailed implementation plan for the `0.5.0 — Rooms 2.0` scope already declared in the authoritative `ROADMAP.md`. The active `0.4.2 — Real Internet Test` milestone remains 54/59 (91.5%); Rooms 2.0 work must not inflate that percentage.

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

- [x] bounded membership transport frame and deterministic codec,
- [x] transport adapter over the verified membership runtime,
- [x] authenticated source binding before remote mutation,
- [x] heartbeat/resync snapshot reuse without revision inflation,
- [x] two-client transport convergence and adversarial replay/source tests,
- [ ] add membership to the production GossipSub `WireEvent` contract,
- [ ] route backend room create/join/switch/world transitions through membership state,
- [ ] publish membership snapshots on transitions and heartbeat/resync,
- [ ] apply remote snapshots from the live network task,
- [ ] clear remote membership on final disconnect, authenticated goodbye and presence expiry,
- [ ] close-room cleanup and republish when the local active room disappears.

## Stage 3 — accurate room-count UX

- [ ] emit verified `room-user-count` deltas from backend runtime effects,
- [ ] update room-list counts without falling back to global online presence,
- [ ] show the active room's synchronized count in the chat header,
- [ ] keep `#WORLD` presence semantics separate from temporary-room membership,
- [ ] reset membership-derived UI state on disconnect/reconnect.

## Stage 4 — verification and promotion

- [ ] exact-head Windows CI PASS,
- [ ] exact-head Linux Node CI PASS,
- [ ] multi-peer same-LAN room switch/replay test,
- [ ] public-network multi-peer room membership test,
- [ ] document protocol compatibility and upgrade behavior,
- [ ] mark the two top-level `0.5.0` goals complete only after end-to-end application evidence exists.
