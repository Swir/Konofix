# KNP lifecycle hang diagnostics

Main Windows run [37415648734](https://github.com/Swir/Konofix/actions/runs/37415648734)
was cancelled after the job deadline. Its last unfinished Rust test was
`knp_chat::tests::real_chat_is_bidirectional_acknowledged_and_restarts_without_old_session`.
The log did not identify the blocked operation. PR #163 is diagnostic only:
a later green run did not reproduce or fix that failure.

## What the diagnostic draft measures

The restart test runs in an exact-filtered child test process, with eight real
bidirectional-message/receipt/identity-restart cycles for each of one and four
Tokio workers. The original delivery, identity, stale-session and UDP rebind
assertions remain required. A separate stress test synchronizes sixteen sends
and four shutdown callers after queuing sixty-four abandoned snapshot replies.
It verifies completion of every caller, rejection by the stopped session and
release of both UDP sockets, for eight fresh pairs.

The parent uses an OS process deadline (180 seconds for restart, 120 seconds
for the shutdown race), independent of Tokio. It covers synchronous cleanup
and runtime destruction too. The existing 20-second async phase limits still
apply. Exceeding either limit fails the test. There is no retry-to-pass,
ignored failure, relaxed receipt requirement or forced shutdown in product code.

A child must exit successfully **and** emit its completion marker. An empty
test filter cannot pass. Watchdog self-tests deliberately stall outside Tokio,
panic, complete normally and select a nonexistent test. Those clearly labelled
fixtures validate the supervisor; they are never product/network evidence.

## Reading retained evidence

Windows CI uploads `KNP-lifecycle-diagnostics-<source SHA>-<run attempt>`
even after test failure. Each invocation reserves a UUID-named log, `.start.json` and
`.result.json` using create-new opens. Repeated runs do not replace evidence.
The normal Cargo command also prints the final 64 KiB of each product test log.
Locally, logs default to the temporary `konofix-knp-diagnostics` directory;
`KONOFIX_KNP_DIAGNOSTICS` can select a dedicated directory.

Use the artifact's exact workflow/run attempt and source SHA, then:

1. Read the matching result record: test name, fixture classification, deadline,
   elapsed time, timeout flag, exit code and body-completion marker.
2. Find the last started lifecycle phase without its finished line.
3. Follow the numbered chat/bridge actor's last phase. Separate SDK connect/send,
   SDK abort-and-join, bridge stop, profile release, directory cleanup and runtime
   drop markers distinguish where progress stopped.
4. Compare the Tokio heartbeat: continued heartbeats with a blocked operation
   differ from a runtime that stops scheduling all work. Heartbeats alone do not
   establish deadlock or identify an SDK-internal stack.
5. Preserve the original log and result. Record the failure without replacing it
   with a later green result. A missing result after runner cancellation is
   incomplete evidence, never PASS.

Instrumentation is compiled only with `cfg(test)`. It logs static phase names,
process-local actor numbers and timing, not message bodies, keys, identities,
addresses or profile paths. Only these test logs/result records are uploaded:
no private profiles, memory dumps or general runner diagnostics are collected.

These traces identify the last observable application/SDK boundary, not an
unobserved native stack or a proven root cause. If an SDK call blocks, use that
specific trace to design the next regression. Do not patch suspected scheduling,
socket or cache behavior without evidence.

## Qualification remains separate

This draft does not change installed networking or the pinned SDK. libp2p
remains the primary network; KNP remains optional. Candidate 0.5.2 is tester-only.
The main Windows hang remains unresolved until supported by an actual diagnosis
and qualified correction. Physical LAN, direct WAN and controlled relay tests
remain NOT RUN until testers supply real results. See [the two-PC procedure](TWO_PC_TEST.md).
