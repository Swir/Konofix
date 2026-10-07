# Optional KNP SDK pin qualification

The candidate pin is KonoNexus `dc377e1001200268039b6e4df7d19b94dd0692ef`
(package `0.1.0-alpha.28`), replacing
`ea9cc5dfffa7480ab5a1bb0f79e8b5649fdeea3e` (`0.1.0-alpha.23`). Both desktop and
Linux Node manifests keep `default-features = false`. This remains an experimental
SDK, not stable 1.0 or a production-readiness claim. Native libp2p is the primary
chat network; KNP remains a separate optional contact/identity path.

## Motivation and reviewed scope

[Upstream #30](https://github.com/Swir/KonoNexus/pull/30) fixes a proved idle-lease
defect: fresh encrypted traffic that has passed signature, identity, AEAD and replay
validation now refreshes an already admitted peer's activity time. Its deterministic
regression fails before the fix and also proves rejected/replayed traffic cannot
extend the lease. It does not create unknown peers, extend idle TTLs or relax tests.

The complete pin also includes upstream #21–#29. The runtime changes are bounded
local route-quality learning from authenticated outcomes, authenticated IPv6 endpoint
selection and multi-relay failover selection. Added SDK JSON bridge/process-host and
WAN-evidence utilities are not automatically wired into Konofix. This update does
not switch the application to that process host or produce any WAN evidence. The
SDK facade, configuration and packet/session/security source files are unchanged
across this range. No registry package version is updated in Konofix's lockfile.

Upstream exact-main core and Windows jobs passed at this pin (37668159811 and
37668159832). Those results are prerequisites, not substitutes for Konofix's own
Windows integration tests, artifact validation and post-merge checks.

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
