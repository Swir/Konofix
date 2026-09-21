# Rooms 2.0 implementation roadmap

This is the detailed implementation plan for the `0.5.0 — Rooms 2.0` scope already declared in the authoritative `ROADMAP.md`. The authoritative active Global Beta readiness scope is now 56/67 (83.6%) after the production membership/count implementation gate passed exact-head application-runtime qualification. That credit covers the implementation/runtime gate only: real same-LAN/public-network witness records, the separate 20-client / five-network / three-country / 60-minute soak gate, and participant failover still require field evidence.

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

PR #132 merged after exact-head Windows, Linux and RustSec CI, so the live production path consumes the previously verified membership bridge instead of leaving it as source-only scaffolding. PR #133 then added a deterministic 128-peer convergence regression and merged after exact-head Windows/Linux CI. PR #140 adds an exact-head production `network_task` qualification with one owner plus four guest application loops, exercising live GossipSub membership, heartbeat/resync idempotence, WORLD leave/rejoin, authenticated Goodbye cleanup and abrupt final-connection cleanup. Together, these checks close the top-level Global Beta Rooms 2.0 implementation/wiring gate without claiming the still-separate public-network, soak or failover gates.

- [x] bounded membership transport frame and deterministic codec,
- [x] transport adapter over the verified membership runtime,
- [x] authenticated source binding before remote mutation,
- [x] heartbeat/resync snapshot reuse without revision inflation,
- [x] two-client transport convergence and adversarial replay/source tests,
- [x] verified live-coordinator semantics for final-connection close, authenticated goodbye, presence expiry and room-close republish,
- [x] application-facing adapter for signed snapshot payloads and deterministic room-count emit payloads,
- [x] add membership to the production GossipSub `WireEvent` contract,
- [x] route backend room create/join/switch/world transitions through membership state,
- [x] publish membership snapshots on transitions and heartbeat/resync,
- [x] apply remote snapshots from the live network task,
- [x] wire verified peer cleanup into final disconnect, authenticated goodbye and presence expiry handlers,
- [x] close-room cleanup and republish when the local active room disappears.

## Stage 3 — accurate room-count UX

- [x] prepare the frontend `room-user-count` consumer, temporary-room badges and active-room header rendering while keeping WORLD on global presence,
- [x] emit verified `room-user-count` deltas from backend runtime effects,
- [x] update room-list counts end-to-end without falling back to global online presence,
- [x] show the active room's synchronized count end-to-end in the chat header,
- [x] keep `#WORLD` presence semantics separate from temporary-room membership end-to-end,
- [x] reset membership-derived UI state on disconnect/reconnect.

## Stage 4 — verification and promotion

The automated application-loop qualification proves the production runtime implementation path and therefore closes the corresponding top-level implementation gate. The live-evidence tooling remains the authority for real desktop field sessions. Its minimum three-participant floor is a tooling sanity floor, **not** a replacement for the separate Global Beta 20-client / five-network / three-country / 60-minute soak gate. A passing synthetic or same-host test cannot promote the public-network gates.

- [x] exact-head Windows CI PASS for the live production-wiring implementation,
- [x] exact-head Linux Node CI PASS for the live production-wiring implementation,
- [x] production application-loop qualification with five peers, count convergence, heartbeat/resync idempotence, WORLD switching and graceful/abrupt disconnect cleanup,
- [ ] multi-peer same-LAN room switch/replay test with a validated live-evidence record,
- [ ] public-network multi-peer room membership test with independently identified networks/countries and a validated live-evidence record,
- [x] document protocol compatibility and upgrade behavior (`docs/ROOMS2-PROTOCOL.md`),
- [ ] mark the two top-level `0.5.0` goals complete only after end-to-end application evidence exists.
