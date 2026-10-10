# Original-harness KNP restart investigation

The two Windows job timeouts remain unresolved: main run 37415648734 and
PR #169 run 37511929284 stopped at
`real_chat_is_bidirectional_acknowledged_and_restarts_without_old_session`.
A green diagnostic run is not a fix. The later exact WORLD candidate's limited
physical text PASS permits only its prerelease; this KNP investigation and the
broader #165 route/restart gates remain separate and open.

Draft #163 adds detailed synchronous traces, nocapture and supervised stress.
Those are useful probes but alter scheduling. This complementary experiment
starts from main 9198c1a5492e526bb835285a3e1a1262f04a96a6 and keeps the original
Tokio test attribute, four workers, body, assertions, async waits, output
capture and default parallel Rust harness. Only passive phase marks are added.

## Passive phase sampling

When `KONOFIX_KNP_DIAGNOSTICS` is set, an independent OS thread writes the
current static phase once per second to a UUID-named create-new file.
Phase marks on the async test thread only select a static index and perform an
atomic store: no file/stdout/stderr lock, await, heartbeat task, altered runtime
or new async timeout. Without the environment variable the observer is absent.
The helper is compiled only under cfg(test), never into the installed client.

Samples may skip fast transitions. They show the last reached operation, not a
full execution trace or a proven cause. A continuing sample with an unchanged
phase localizes the wait even if Tokio cannot make progress. The final body
marker precedes Rust state/runtime destructors. Successful body completion
alone does not establish successful cleanup or process exit. Sampler creation
and destruction can still perturb timing; this is not a perfectly uninstrumented
control. No message, identity, key, endpoint or profile path is recorded.

## Bounded captured batch

After the unchanged all-target test command passes, the Node.js supervisor asks
locked Cargo for the exact `knp_chat_live` executable and checks its test list.
It runs a fixed batch of 24 fresh processes with the original concurrent tests,
default capture and default test-thread count. Each process has a 60-second
OS deadline. It stops at the first failure, with no retry-to-pass or skipped
test. Output goes straight to a new file rather than undrained pipes.

PASS requires both the actual restart-test/harness success summaries with all
listed tests run and successful process exit before the deadline. Watchdog
self-tests deliberately exercise empty selection, nonzero exit and a process
that prints a success summary then stalls. Those are synthetic controls,
clearly named `fixture-*`, never product or WAN evidence.

Every invocation reserves a new evidence directory, records exact source and
executable hash before launch, then exit/timeout, elapsed time and log hash.
Windows CI uploads these records and passive samples even on failure. The
all-target step is bounded to 15 minutes (the job remains 60 minutes); the new
batch has its own 8-minute ceiling. No pre-existing timeout was increased.

## Interpretation and next action

A failed attempt must remain recorded. Read the last passive phase and the
child exit record before changing code. If only the body marker completed,
investigate state/runtime destruction. If a phase remains active, instrument
that specific call/SDK boundary next. Do not label the batch green if a child
was killed, panicked, ran no tests or stalled after printing success.

A complete green batch is Windows local-socket non-reproduction evidence only.
It does not resolve the two historical timeouts, qualify #169 automatically,
or prove physical LAN/WAN, NAT traversal, bootstrap reachability or beta readiness.
