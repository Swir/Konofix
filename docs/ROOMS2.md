# Rooms 2.0 synchronization core

Rooms 2.0 is the next product-development milestone after the externally gated `0.4.2 — Real Internet Test` milestone. The public-network milestone remains **54/59 (91.5%)** until real independent-network evidence exists; work in this document does not claim any of those five external gates.

## Stage 1 implemented in this development branch

The first Rooms 2.0 checkpoint introduces a bounded, deterministic room-membership state engine in `src-tauri/src/room_membership.rs` plus an integration test under `src-tauri/tests/room_membership.rs`.

The state engine:

- tracks unique room members by authenticated peer identity,
- derives accurate per-room user counts from unique membership sets,
- applies revisioned snapshots atomically,
- treats exact retransmission as idempotent,
- rejects stale revisions and same-revision conflicting snapshots without mutation,
- removes all memberships for a disconnected peer,
- purges membership indexes for a closed room,
- rejects `world`, invalid room identifiers, duplicate room IDs and zero revisions,
- caps one peer at 64 temporary-room memberships and caps total tracked memberships at 16,384.

The module intentionally uses only the Rust standard library. Existing `cargo test --all-targets` CI compiles and exercises it through the integration test even before the desktop network loop is wired to the new protocol.

## Wire protocol planned for Stage 2

The desktop network loop will publish a source-authenticated membership snapshot whenever the local peer changes temporary rooms. The planned wire payload is conceptually:

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

Stage 1 is **not** user-visible Rooms 2.0 completion. The next implementation checkpoint must:

- add the authenticated membership snapshot to `WireEvent`,
- connect room switching/creation to a backend membership command,
- publish a new local revision when membership changes,
- apply accepted remote snapshots to the tracker,
- clear tracker state on peer expiry/goodbye and room close,
- emit room-count updates to the frontend,
- show the synchronized count in room buttons and the active-room header,
- add malformed/replay/capacity Rust tests and frontend/project-audit regression coverage.

Only after that end-to-end path is green should the roadmap items `full room-member synchronization` and `accurate per-room user count` be considered for completion.
