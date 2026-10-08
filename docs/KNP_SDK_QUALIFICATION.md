# Optional KNP SDK pin qualification

The candidate pin is KonoNexus `ee97b8b6c56467eeff9aee9f93e9375582005541`
(package `0.1.0-alpha.28`), replacing
`dc377e1001200268039b6e4df7d19b94dd0692ef` (also `0.1.0-alpha.28`). Both desktop and
Linux Node manifests keep `default-features = false`. This remains an experimental
SDK, not stable 1.0 or a production-readiness claim. Native libp2p is the primary
chat network; KNP remains a separate optional contact/identity path.

## Motivation and reviewed scope

[Upstream #30](https://github.com/Swir/KonoNexus/pull/30) fixes a proved idle-lease
defect: fresh encrypted traffic that has passed signature, identity, AEAD and replay
validation now refreshes an already admitted peer's activity time. Its deterministic
regression fails before the fix and also proves rejected/replayed traffic cannot
extend the lease. It does not create unknown peers, extend idle TTLs or relax tests.

[Upstream #31](https://github.com/Swir/KonoNexus/pull/31) fixes a second,
independently demonstrated consumer-path defect. After an authenticated ACK removed
an outbound message, a full SDK receipt channel caused `try_send` to discard the
only success event. The SDK now retains receipts in FIFO order and retries them when
capacity returns, with bounded admission once 1,024 receipts are pending. It changes
no wire format, delivery timeout or retransmission budget.

The Konofix regression sets the SDK event capacity to one, fills the sender's bridge
output with a real inbound message, sends two real messages while that output remains
blocked, then requires both delivery receipts in order. This covers the sender-side
condition missing from the earlier receiver-backpressure test. It is expected to fail
on the previous pin because the second receipt is discarded after the first fills the
SDK channel.

The complete pin also includes upstream #21–#30. The runtime changes are bounded
local route-quality learning from authenticated outcomes, authenticated IPv6 endpoint
selection and multi-relay failover selection. Added SDK JSON bridge/process-host and
WAN-evidence utilities are not automatically wired into Konofix. This update does
not switch the application to that process host or produce any WAN evidence. No
registry package version is updated in Konofix's lockfile.

Upstream #31 exact-head CI run 37790134910 passed format, Clippy, all tests,
SDK-only check and SDK-only Clippy at `01990cea78b76a9cdac59280450d074119b401b0`.
The merge commit is `ee97b8b6c56467eeff9aee9f93e9375582005541`; no exact-merge
workflow run had appeared when this candidate was prepared. Konofix's own exact-head
Windows/Linux/RustSec tests and artifact validation remain required.

## Preserved failures and the isolated control

[Konofix #181](https://github.com/Swir/Konofix/issues/181) retains both original
Linux delivery stress failures: a receipt timeout after the shutdown barrier and
`RetriesExhausted` on the earlier actor. An isolated local control used exactly the
old SDK plus only the six authenticated-liveness lines, without the other SDK
changes or tracing. Its single predeclared batch passed 24/24 fresh processes,
using the same nine actual-source tests, 30-second process cap and 15-second receipt
assertion. The slowest process took 8,801 ms; all hashes/results are appended to
the issue. This supports qualification of the change but does not prove the cause
of every historical Windows hang or close a flaky-delivery report by repetition.

The full new SDK's separate local batch also passed 24/24 fresh processes (slowest
4,993 ms), and 37 shared Node/component tests passed with the public test ignored.
Its aggregate result SHA-256 is
`a2f843fbf198699449843b8178c1ded3b0e4715bafd0dc9f394373b72fa0bd6b`;
the complete address-free result is appended to #181. It must still pass exact-head
Windows/Linux/RustSec gates and post-merge main gates. Keep the original restart
batch, timer-cancellation regression, socket/profile cleanup assertions and all
deadlines. A failure must remain recorded and be investigated; it cannot be replaced
with a passing rerun of unchanged code.

Public beta publication remains HELD. Physical automatic-WORLD WAN FAIL #165 remains
open; public Amino RPC qualification, physical independent-network messaging and
Wi-Fi/LTE recovery are separate from these local KNP results. Existing evidence and
historical SDK references in `KNP_STOP_BARRIER.md` remain unchanged.
