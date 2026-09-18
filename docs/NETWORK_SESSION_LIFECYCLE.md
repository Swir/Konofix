# Network session lifecycle

Konofix treats one running desktop P2P task as one owned network session. The Rust command sender stored in `AppState` is the ownership handle for that session.

## Start and ownership

`start_network` installs the command sender while holding the `AppState.tx` mutex. The check for an existing session and the sender installation happen under the same lock, so overlapping starts cannot both pass a check-then-set window.

The spawned task retains a clone of that exact Tokio MPSC sender. After every P2P task return — clean `Ok(())` or fatal `Err(...)` — cleanup compares the task-owned sender with the currently installed sender using `Sender::same_channel`. Only the task that still owns the active channel may clear `AppState.tx`; `network-error` is emitted only when that owned exit is fatal. A clean nickname-conflict shutdown therefore releases backend ownership without manufacturing a fatal error, while a late exit from an older task cannot tear down a newer reconnect session.

Startup/ready-handshake failures use the same channel-ownership check. They may clear only the sender installed for that startup attempt.

## Explicit disconnect

`disconnect_network` atomically takes the current sender once and then sends `NetworkCommand::Stop`. Repeated disconnect calls are safe no-ops after the first take. A task that exits later cannot clear a replacement session because channel ownership no longer matches.

## Desktop recovery

The frontend uses one `resetSessionView` path for both explicit disconnect and terminal network-task failure. Terminal recovery closes stale modals, marks the client disconnected, clears the local peer identity and cached UI peer/room/message/transfer state, restores the offline network status, and returns to the login view while preserving the terminal error text for the user.

Connection startup is also treated as part of the owned lifecycle. A local `connectPending` flag prevents overlapping UI start attempts, while a monotonic `sessionRevision` identifies the currently valid asynchronous start attempt. `resetSessionView` advances that revision before rebuilding the login view, so a delayed successful or failed `start_network` promise from an older attempt cannot resurrect or overwrite a reset/newer session.

The terminal `network-error` listener handles failures while either a session is connected or a start is still pending. It invokes `disconnect_network` as an idempotent convergence step before resetting the view. Nickname-conflict shutdown continues to use its existing explicit disconnect path.

## Regression policy

Rust unit tests cover channel ownership, clean-exit release followed by reconnect, overlapping-start rejection followed by reconnect, and idempotent sender take. `scripts/check-network-session-lifecycle.mjs` is wired into the normal project audit together with adversarial mutation tests. The policy gate fails if cleanup stops running for every task return, channel ownership, atomic start, startup-safe terminal recovery, stale async-start invalidation, fatal terminal-event ownership, idempotent disconnect, or frontend terminal reset behavior is removed.

This lifecycle hardening improves resilience only. It does **not** add Real Internet Test milestone credit; public cross-country/independent-network evidence remains authoritative for that milestone.
