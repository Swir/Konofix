# Rooms 2.0 development changelog

This scoped changelog records unreleased Rooms 2.0 work separately from stable `0.4.2` release notes. It does not change the active Real Internet Test percentage or stable-release readiness.

## Stage 2.3 — application effects adapter

- added `RoomMembershipApplicationAdapter` as a narrow application-facing layer over the verified live coordinator,
- converted monotonic membership snapshots into a signed-envelope-ready payload without duplicating membership validation or revision rules,
- converted verified `RoomCountChange` values into deterministic `room-user-count`-ready payloads while keeping replay/stale/conflict events silent,
- preserved WORLD as a separate global-presence state by mapping `None` / `world` transitions to empty temporary-room membership,
- added integration coverage for local switching, heartbeat revision stability, remote convergence, duplicate replay suppression, forged-source rejection, multi-connection cleanup and active-room close republish,
- kept actual `WireEvent` insertion, backend command-loop wiring and frontend event emission explicitly pending until the production network task consumes this adapter.

## Stage 2.2 — production WireEvent bridge preparation

- added a decoded-snapshot bridge on `RoomMembershipLiveCoordinator` so the production GossipSub `WireEvent` path can hand off `peer_id` / revision / room fields without reimplementing membership validation,
- preserved the verified 16 KiB transport bound, authenticated-source binding and replay/conflict semantics by routing decoded fields back through the existing transport boundary,
- added focused coverage proving forged decoded identities fail before count mutation and duplicate live snapshots remain idempotent,
- kept the actual production `WireEvent` insertion, backend room switching and frontend count emission explicitly pending rather than claiming user-visible Rooms 2.0 early.

## Stage 2.1 — live lifecycle coordinator

- added `RoomMembershipLiveCoordinator` as a narrow production-wiring boundary over the authenticated membership transport,
- made final-connection cleanup explicit: a transient libp2p connection close cannot remove membership while another connection to the peer remains established,
- converged authenticated goodbye and presence-expiry cleanup on the same idempotent peer-departure path,
- preserved room-close leave-snapshot republishing and revision-stable heartbeat/resync semantics,
- added integration coverage for multi-connection churn, duplicate departure signals, local room switching, remote convergence and room-close cleanup.

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
- wire the verified final-disconnect/goodbye/presence-expiry cleanup paths into the live network task,
- propagate verified `room-user-count` deltas into the desktop UI,
- complete exact-head Windows/Linux CI and real multi-peer application testing.
