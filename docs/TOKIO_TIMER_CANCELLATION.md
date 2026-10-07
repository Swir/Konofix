# Tokio timer cancellation qualification

The baseline product lockfile selected Tokio 1.53.1; this change selects 1.53.2. Upstream
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

## Recorded baseline

Windows run [37567796069](https://github.com/Swir/Konofix/actions/runs/37567796069),
head `cdb992843942abeee53522ec9b0c809b10d7dfd2` (PR test merge
`032aee08ae8aa78ed297e09f521435cea08089e0`), reproduced the old-lock defect:
retained-owner controls completed cancellation and runtime cleanup with zero
and four workers. Reentrant cancellation entered the nested destructor and
did not return; the parent failed after 10.06 seconds at its unchanged
10-second OS deadline. The initial attempt at `76376b7` stopped earlier at
local/CI command parity and is not reproduction evidence.

Only the Tokio version/checksum entry changes in the dependency lockfile.
The crates.io index confirms identical normal dependency requirements and
features between these patch versions. The same regression and the original
captured/parallel KNP batch from #173 must pass on the candidate. This does not
retroactively identify the cause of the historical KNP timeouts.
