# Konofix Global Beta

Global Beta means a public, many-computer network. A two-PC test is only the smallest smoke test and is not the beta target.

## Target topology

The product decision of 2026-09-20 is **participant-operated P2P**: every connected desktop application is a network node. The desktop includes discovery, TCP/QUIC, signed GossipSub, a Circuit Relay service and relay client. A separately installed `konofix-node` or a company-operated server fleet is optional, not a prerequisite for using the chat.

The first participant in an isolated network cannot discover arbitrary Internet computers without any contact information. In a LAN, mDNS discovers and dials other applications automatically. For a first Internet connection, an online participant shares a reachable address from Network settings. The recipient adds that address; Identify/Kademlia and the local peer cache then help discover and reconnect to other participants. Private LAN addresses are not Internet invitations. Symmetric NAT/CGNAT may require a reachable participant providing relay or appropriate port mapping; this is a network reachability constraint, not a central chat-server requirement.

Qualification must exercise at least three participant nodes across at least two independent networks, with at least two reachable contact/relay paths, then demonstrate recovery when one leaves. Participants may keep the app open or optionally run the headless Node. Ephemeral desktop identities and addresses are valid for the running session; after all participants leave, fresh invitations may be necessary.

The optional build-owned `src-tauri/bootstrap-pool.json` is merged ahead of environment and user-provided contacts. Duplicates are removed without destroying priority, the total pool is bounded, and failed/lost bootstrap Peer IDs are retried with bounded exponential backoff. The desktop also selects up to three relay candidates from connected Konofix participants advertising relay support through Identify, without requiring them to be configured bootstrap servers. Failed listeners and disconnected candidates are released for later rediscovery. The committed default pool remains empty; placeholder infrastructure is never shipped.

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

Source-side promotion review now includes `scripts/validate-global-beta-evidence.mjs`. The validator does **not** create evidence and does not turn synthetic/local results into readiness credit; it rejects incomplete or internally inconsistent operator evidence before anyone can treat it as a Global Beta PASS.

A schema-1 manifest must bind one exact candidate version, canonical 40-character source commit, relative candidate artifact path and artifact SHA-256 to a test window of at least 60 minutes. It requires at least three unique participant Peer IDs on at least two participant networks, at least two distinct reachable participant contact/relay identities, at least 20 unique clients across five network IDs and three country codes, concrete WORLD/rooms/reconnect/TCP/QUIC/relay/DCUtR/CGNAT checks, bidirectional file-transfer SHA-256 observations, and a failover record proving discovery/chat/rooms recovered through a surviving recorded contact identity after another participant was removed.

The validator opens the candidate artifact and each referenced 50/100/250 load JSON from inside the manifest directory, captures bounded file bytes, verifies their recorded SHA-256 values and rejects path escapes. Each load JSON must be the real schema-v2 `konofix-global-beta-load` output for the same candidate version/source commit, require at least a 95% success threshold, include both TCP and QUIC-v1 successes and carry verified stable pre/post Node health with advancing timestamp/uptime. A manifest cannot replace those referenced files with duplicated claims.

Start from the explicitly non-passing template `docs/global-beta-evidence.template.json`; `_template=true` and `status=pending` are intentionally rejected by the validator until real evidence is filled in. Keep the candidate archive and the three referenced load JSON files beside the completed manifest (or below that directory) so the package remains self-contained.

Run the validator from a source checkout with Node.js 22+:

```powershell
node .\scripts\validate-global-beta-evidence.mjs .\global-beta-evidence.json `
  --expected-version 0.4.2 `
  --expected-commit FULL_40_CHARACTER_COMMIT_SHA
```

The project audit runs deterministic adversarial self-tests for structure, candidate/load byte tampering, source-commit mismatch, weak load thresholds, missing stable health, path confinement and failover invariants. Passing schema/package validation is necessary for promotion review but is never a substitute for the real networks, countries, independent participants, traffic, failover and exact-build observations named above.

## Infrastructure blocker

The external blocker is actual participant reachability and multi-network evidence, not purchasing servers. Local tests and GitHub Actions cannot establish that twenty real users across five networks and three countries can exchange messages, switch rooms, transfer files and recover after a participant leaves. The existing headless-Node health/load tools remain available for optional operators; their PASS results alone do not qualify the desktop participant network. Global Beta readiness remains open until the real participant tests pass.
