# One explicitly authorized public RPC attempt

The first public trial on `b398bf941bad1e1f8b75ab0a61dd33ed2d0e003c` did not
establish an authenticated connection or successful RPC. Its original JSON and
hash are preserved in #177 and `docs/evidence/amino/`. It must not be overwritten
or reclassified. The manual workflow is prepared for a **new** authorization;
adding or merging it does not authorize running another public test.

This workflow has no push, PR, schedule or workflow-completion trigger. It is
dispatched manually on `main`, requires the exact reviewed SHA and the literal
acknowledgement `read-only-no-wan-claim`, and refuses GitHub **Re-run jobs** attempts.
Old hourly automations remain OFF. No operator VPS or permanent node is started.

After explicit authorization for a new attempt and confirmation that the runner's
network policy permits public Amino traffic:

1. Open **Actions → Manual read-only Amino interoperability → Run workflow**.
2. Select `main`, enter its reviewed full SHA and the acknowledgement above.
3. Run once. Do not rerun on failure. Save the `Amino-read-only-SHA-RUN-1` artifact
   and its Actions digest, retaining every previous attempt.

The runner compiles the shared production adapter without executing tests, verifies
that exactly the named ignored probe exists, then executes it once. Source provenance
is bound to the selected SHA. The query uses a fresh random test namespace, an
ephemeral in-memory identity, no provider announcement/value PUT/chat/relay and the
existing 30-second probe deadline. A 45-second outer process limit prevents a hung
probe from blocking evidence collection. It does not change any product/test deadline.
The public transport still bounds dial/connection/query budgets. Identify/Ping and
authenticated transport handshakes are necessary protocol traffic, not WORLD messages.

The output directory and each evidence file are created exclusively. Intent,
original probe JSON, process output, final result and SHA-256 manifest remain separate;
an incomplete/failed attempt fails the job and is uploaded using `always()` with
`overwrite: false`. A compilation/authorization failure produces no network result;
missing evidence is never PASS. Artifact retention is 30 days, so append the exact
JSON/hash and run link to the project checkpoint before it expires. No account,
application identity files, credentials or user message data are collected.

`RPC_INTEROPERABILITY_PASS` means only authenticated public routing RPCs completed.
It does **not** qualify signed participant discovery, reachability, relay service,
message delivery, network-change recovery or a physical two-PC WAN test. #165 remains
the real WAN FAIL and publication stays HELD until the separate acceptance gates pass.
Public DHT services are best effort; metadata observers can see source IP, ephemeral
PeerID, test namespace and timing. A read-only test requests no remote record TTL.

Offline guard tests: `python3 scripts/test-amino-once.py`. These use generated fixture
executables only and must never be reported as public interoperability evidence.
