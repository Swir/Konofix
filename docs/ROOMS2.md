# Rooms 2.0 synchronization core

Rooms 2.0 is the next product-development milestone after the externally gated `0.4.2 — Real Internet Test` milestone. The public-network milestone remains **54/59 (91.5%)** until real independent-network evidence exists; work in this document does not claim any of those five external gates.

## Stage 1 implemented in this development branch

The first Rooms 2.0 checkpoint introduces a bounded, deterministic room-membership state engine in `src-tauri/src/room_membership.rs`, a source-authenticated wire snapshot validator in `src-tauri/src/room_membership_wire.rs`, and integration tests under `src-tauri/tests/room_membership.rs`.

The state engine:

- validates that each wire snapshot claims the same libp2p Peer ID as its authenticated GossipSub source,
- tracks unique room members by authenticated peer identity,
- derives accurate per-room user counts from unique membership sets,
- applies revisioned snapshots atomically,
- treats exact retransmission as idempotent,
- rejects stale revisions and same-revision conflicting snapshots without mutation,
- removes all memberships for a disconnected peer,
- purges membership indexes for a closed room,
- rejects `world`, invalid room identifiers, duplicate room IDs and zero revisions,
- caps one peer at 64 temporary-room memberships, caps total tracked memberships at 16,384, and caps retained peer membership states at 2,048.

The tracker itself uses only the Rust standard library; the wire validator uses the project's existing `libp2p` and `serde` dependencies. Existing `cargo test --all-targets` CI compiles and exercises both modules through the integration test even before the desktop network loop is wired to the new protocol.

## Stage 1.5 implemented in this development branch

The wire layer now also owns the deterministic transition helpers needed by the desktop loop:

- `LocalRoomMembershipState` converts local room-set changes into strictly monotonic revisioned snapshots and emits nothing for idempotent room sets,
- local validation happens before revision/state mutation, so duplicate, invalid or over-limit room sets fail closed,
- snapshots are normalized into deterministic room ordering before publication,
- `apply_authenticated_snapshot` joins authenticated-source validation, known-room validation and tracker mutation in one fail-closed call,
- forged-source or unknown-room input is rejected before member counts can change,
- integration tests exercise the publisher/apply boundary so the remaining runtime wiring does not need to duplicate protocol policy.

## Stage 1.75 runtime coordinator implemented in this development branch

`src-tauri/src/room_membership_runtime.rs` now provides the stateful coordinator that the desktop network loop can wire directly instead of reimplementing membership policy in `lib.rs`:

- one bounded known-room registry shared by local and remote transitions,
- one total-count view combining the local peer with authenticated remote memberships,
- local room changes that return both the next monotonic snapshot and the exact room-count deltas for UI emission,
- authenticated remote snapshot application mapped to total room counts,
- explicit loopback-snapshot rejection so a locally echoed GossipSub event cannot double-count the current user,
- last-connection/goodbye cleanup through `remove_remote_peer`,
- room-close cleanup that purges remote membership, removes local membership and returns a publishable local snapshot when required,
- atomic batch room registration validation and a 256-room runtime bound matching the existing desktop active-room ceiling.

`src-tauri/tests/room_membership_runtime.rs` makes this coordinator part of `cargo test --all-targets` and covers two-peer convergence, disconnect cleanup and idempotent room close. This materially reduces the remaining Stage 2 desktop-loop integration surface while still making no claim that Rooms 2.0 is user-visible yet.

## Wire protocol planned for Stage 2

The desktop network loop will publish a source-authenticated membership snapshot whenever the local peer changes temporary rooms. The wire payload is:

```text
RoomMembershipSnapshot {
    peer_id,
    revision,
    rooms[]
}
```

Acceptance remains fail-closed:

1. GossipSub must provide an authenticated source Peer ID.
2. `peer_id` in the payload must equal that authenticated source.
3. Every referenced room must already exist and must not be `world`.
4. Snapshot revision must be newer than the last accepted revision for that peer, except an exact same-revision retransmission which is a no-op.
5. A same-revision snapshot with different room content is a conflict and is rejected.
6. Resource limits are checked before any membership mutation.

Snapshot semantics are preferred over join/leave deltas because GossipSub delivery can duplicate or reorder messages. A newer complete snapshot converges membership state without depending on delivery of every earlier transition.

## Remaining integration work

Stage 1.75 is **not** user-visible Rooms 2.0 completion. The next implementation checkpoint must:

- add the authenticated membership snapshot to `WireEvent`,
- instantiate `RoomMembershipRuntime` inside the desktop network task,
- connect room switching/creation to backend membership updates and publish returned local snapshots,
- apply accepted remote snapshots through the runtime coordinator,
- call runtime cleanup on peer expiry, final connection close, goodbye and room close,
- emit returned room-count deltas to the frontend,
- show the synchronized count in room buttons and the active-room header,
- add malformed/replay/capacity runtime wiring tests and frontend/project-audit regression coverage.

Only after that end-to-end path is green should the roadmap items `full room-member synchronization` and `accurate per-room user count` be considered for completion.
