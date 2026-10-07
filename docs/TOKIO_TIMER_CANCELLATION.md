# Tokio timer cancellation qualification

The product lockfile currently selects Tokio 1.53.1. Upstream
[tokio-rs/tokio#8551](https://github.com/tokio-rs/tokio/issues/8551) identifies a
deterministic deadlock when cancellation destroys a resource-owning waker
under the timer-driver mutex, and that waker destroys another registered timer.
[#8552](https://github.com/tokio-rs/tokio/pull/8552) releases the driver mutex
before destroying the waker. It shipped in
[1.53.2](https://github.com/tokio-rs/tokio/releases/tag/tokio-1.53.2).

`src-tauri/tests/runtime_cancel.rs` exercises this public-API cancellation
contract with the actual product dependency lock. A retained-owner control
runs the nested cleanup outside the critical section; the trigger releases
the final owner during cancellation. Both current-thread and four-worker
runtimes must complete cancellation and runtime destruction.

The parent supervises separate OS processes with a 10-second deadline because
an async timeout cannot interrupt this synchronous mutex deadlock. Successful
child completion has a distinct exit code, so empty selection, panic, ordinary
exit and timeout all fail. The CI regression runs before the broader app tests.
No longer timeout, test skip or retry is used.

This is a dependency regression, not network evidence. Upstream explicitly
states ordinary Tokio task wakers have not been shown to trigger this defect.
The historical KNP hangs in 37415648734 and 37511929284 therefore remain
unexplained unless their own trace proves this lock cycle. Original captured
KNP stress and installed-app Windows checks remain necessary. Public beta
publication remains HELD and the existing physical WAN FAIL remains open.
