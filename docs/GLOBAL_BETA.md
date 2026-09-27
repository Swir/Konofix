# Konofix Global Beta

Global Beta means a public, many-computer network. A two-PC test is only the smallest smoke test and is not the beta target.

## Target topology

Konofix remains **participant-operated P2P**: desktop clients exchange chat/file/private-control traffic directly or through encrypted libp2p relay transport and no Node stores chat history. The field failure reported on 2026-09-27 clarified an operational requirement that the earlier wording understated: a fresh installation cannot discover arbitrary Internet peers from mDNS alone. Automatic global discovery therefore requires at least one reachable, protocol-compatible public Konofix bootstrap/relay identity.

LAN discovery remains automatic through mDNS. Across independent networks, a client first contacts a public Konofix Node (or an explicitly supplied reachable participant), then Identify/Kademlia, relay reservation, DCUtR/AutoNAT and the peer cache can build the wider P2P graph. Private LAN addresses are not Internet invitations. Symmetric NAT/CGNAT can require the public relay path even when STUN succeeds for audio ICE.

The controlled 0.6 Beta may start with one verified public Node to restore fresh-install Internet discovery, but that node is an explicit temporary single point of failure. Global Beta requires at least two independent reachable bootstrap/relay identities and failover evidence before infrastructure resilience can be claimed.

The build-owned `src-tauri/bootstrap-pool.json` is still the packaged baseline. In addition, 0.6 clients resolve the current schema-1 pool from the repository over HTTPS at connect time with a short fail-open timeout, then merge it ahead of user-provided contacts. Remote metadata is discovery-only: failure to fetch it never blocks LAN/manual operation, and every candidate multiaddr is still parsed and Peer-ID validated by the Rust backend. Failed/lost bootstrap Peer IDs are retried with bounded exponential backoff. Placeholder/fake infrastructure is never shipped or counted as evidence.

Rooms 2.0 snapshots are now wired through signed desktop GossipSub and backend-acknowledged create/switch/WORLD commands. Local count changes, remote snapshots, final disconnect, goodbye, snapshot/presence expiry and room closure use the verified membership bridge. Owned rooms and membership snapshots are republished every heartbeat. Gossip message IDs use the signed source and sequence number, so identical fresh heartbeats/resyncs are delivered rather than suppressed by a content-only duplicate cache. These implementation changes require exact-head CI and live application evidence before earning readiness credit.

## Capacity and abuse boundary

The public Node has explicit libp2p admission ceilings. Current beta defaults are:

- 1024 established connections total
- 768 established incoming connections
- 4 established connections per Peer ID
- 128 pending incoming handshakes
- 128 pending outgoing handshakes

These are safety ceilings, not a promise that every VPS can sustain those numbers. Operators must measure CPU, memory, sockets/file descriptors and bandwidth before raising limits.

## Concurrent transport admission test

The Windows beta bundle includes `scripts\global-beta-load.ps1`. It launches many independent `konofix-netprobe.exe` processes with bounded parallelism. Every successful probe must provide structured Konofix Netprobe evidence for the requested transport and target, including one canonical exact source commit and version. The load summary also seals the Netprobe executable SHA-256 and byte size, so results cannot silently mix a different probe binary into the same run.

For promotion-quality load evidence, use Node health continuity as well. `-RequireStableNodeHealth` requires a fresh schema-v2 health file plus exact version/source-commit pins before the run, then waits for a newer validated health snapshot after the run. The harness rejects a changed Peer ID/version/source commit, backwards uptime or a changed derived boot epoch. This turns "no crash/restart" into recorded evidence instead of an operator assumption.

Example 50-client gate from one exact Windows bundle:

```powershell
.\scripts\global-beta-load.ps1 `
  -TcpBootstrap "/dns/node.example.com/tcp/45555/p2p/PEER_ID" `
  -QuicBootstrap "/dns/node.example.com/udp/45555/quic-v1/p2p/PEER_ID" `
  -Clients 50 -Parallelism 10 -MinimumSuccessPercent 95 `
  -ExpectedVersion "0.4.2" `
  -ExpectedSourceCommit "FULL_40_CHARACTER_COMMIT_SHA" `
  -HealthPath "C:\Konofix\health.json" `
  -RequireStableNodeHealth `
  -OutputPath ".\global-beta-load-50.json"
```

Repeat with **50, 100 and 250 clients** before calling the infrastructure Global-Beta-ready. Keep the three schema-v2 JSON outputs with the exact candidate artifact/evidence package. A promotion-quality run must have `node_health.verified=true`, one exact `exact_build.source_commit`, one exact `exact_build.version`, and the expected success threshold.

A load-harness PASS proves transport/admission concurrency only. It does not prove chat fan-out, room convergence, file transfer, relay, DCUtR, CGNAT behavior or long-running stability.

## Real multi-user beta gate

Before the first real Global Beta prerelease:

1. Run at least three participant nodes across at least two independent networks; a dedicated server is not required.
2. Verify LAN discovery, first Internet contact, remembered-peer discovery and recovery through at least two independent reachable participants. Optional operator seeds must not be a single point of failure.
3. Pass 50, 100 and 250 concurrent exact-build Netprobe admission runs with stable pre/post Node health evidence proving no Node crash/restart.
4. Complete Rooms 2.0 production membership and count wiring.
5. Run at least 20 real clients across at least five independent networks and at least three countries for at least 60 minutes.
6. Exercise WORLD, multiple rooms, reconnect, bidirectional file transfer and SHA-256 validation.
7. Close or isolate one contact/relay participant and prove clients recover through the remaining participants.
8. Re-run the existing TCP, QUIC, Relay, DCUtR and CGNAT evidence gates on the exact beta candidate.
9. Publish only the exact verified build with tester handoff, rollback notes, participant-joining instructions and the evidence package.

## Fail-closed qualification manifest

Source-side promotion review includes `scripts/validate-global-beta-evidence.mjs`. The validator does **not** create evidence and does not turn synthetic/local results into readiness credit; it rejects incomplete, unbound or internally inconsistent operator evidence before anyone can treat it as a Global Beta PASS.

A **schema-2** manifest binds one exact candidate version, canonical 40-character source commit, relative candidate artifact path and artifact SHA-256 to a test window of at least 60 minutes. It requires at least three unique participant Peer IDs on at least two participant networks, at least two distinct reachable participant contact/relay identities, at least 20 unique clients across five network IDs and three country codes, concrete WORLD/rooms/reconnect/TCP/QUIC/relay/DCUtR/CGNAT checks, bidirectional file-transfer SHA-256 observations, and a failover record proving discovery/chat/rooms recovered through a surviving recorded contact identity after another participant was removed.

Every required field check and the failover record must now reference package-contained evidence with an object of the form `{ "path": "evidence/...", "sha256": "..." }`. The validator confines those relative paths to the manifest directory, resolves symlinks before trusting the target, opens bounded regular-file bytes, calculates SHA-256 from the captured bytes and rejects missing, escaped, changed or tampered evidence. Portable absolute-path detection rejects POSIX paths, Windows drive-letter paths and UNC paths even when validation runs on a different operating system. Schema-1 manifests that carried only free-text evidence notes are deliberately no longer promotion-eligible. Multiple checks may reference the same exact attachment only when they declare the same digest; the validator caches the verified real path so one package cannot make conflicting claims about the same file.

The validator also opens the candidate artifact and each referenced 50/100/250 load JSON from inside the manifest directory, captures bounded file bytes, verifies their recorded SHA-256 values and rejects path escapes. Each load JSON must be the real schema-v2 `konofix-global-beta-load` output for the same candidate version/source commit, require at least a 95% success threshold, include both TCP and QUIC-v1 successes and carry verified stable pre/post Node health with advancing timestamp/uptime. A manifest cannot replace those referenced files with duplicated claims.

Start from the explicitly non-passing schema-2 template `docs/global-beta-evidence.template.json`; `_template=true`, `status=pending` and blank attachment digests are intentionally rejected by the validator until real evidence is filled in. Keep the candidate archive, the three referenced load JSON files and every referenced field/failover evidence attachment beside the completed manifest (or below that directory) so the package remains self-contained.

### Seal package hashes without inventing readiness

After recording the real observations and placing every referenced file inside the package directory, the source checkout can calculate the byte bindings with `scripts/seal-global-beta-evidence.mjs`. The sealer copies the working manifest to a separate output file and fills only `candidate.artifact_sha256`, the three `load_runs[].sha256` values, each `checks[].evidence.sha256` and `failover.evidence.sha256`. It deliberately leaves `_template`, PASS/PENDING status, participants, clients, timestamps, transport results and observed transfer digests unchanged.

```powershell
node .\scripts\seal-global-beta-evidence.mjs .\global-beta-evidence.working.json `
  --output .\global-beta-evidence.json

node .\scripts\seal-global-beta-evidence.mjs .\global-beta-evidence.json --check
```

Both modes fail closed on portable absolute paths, lexical escapes, symlink escapes, missing/non-regular/empty/oversized files, files that change while being captured and digest mismatches. `--output` must stay inside the evidence package and may not overwrite the source manifest. Sealing hashes makes manual `Get-FileHash` bookkeeping reproducible; it does **not** create field evidence or make a candidate Global-Beta-ready.

Run the validator from a source checkout with Node.js 22+:

```powershell
node .\scripts\validate-global-beta-evidence.mjs .\global-beta-evidence.json `
  --expected-version 0.4.2 `
  --expected-commit FULL_40_CHARACTER_COMMIT_SHA
```

The project audit runs deterministic adversarial self-tests for schema downgrade, structure, candidate/load byte tampering, field/failover evidence byte tampering, source-commit mismatch, weak load thresholds, missing stable health, path confinement and failover invariants. It also tests the sealer's no-promotion contract, tamper detection and cross-platform path confinement. Passing schema/package validation is necessary for promotion review but is never a substitute for the real networks, countries, independent participants, traffic, failover and exact-build observations named above.

## Infrastructure blocker

The external blocker is actual participant reachability and multi-network evidence, not purchasing servers. Local tests and GitHub Actions cannot establish that twenty real users across five networks and three countries can exchange messages, switch rooms, transfer files and recover after a participant leaves. The existing headless-Node health/load tools remain available for optional operators; their PASS results alone do not qualify the desktop participant network. Global Beta readiness remains open until the real participant tests pass.
