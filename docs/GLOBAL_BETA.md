# Konofix Global Beta

Global Beta means a public, many-computer network. A two-PC test is only the smallest smoke test and is not the beta target.

## Target topology

The product remains **participant-operated P2P**: every connected desktop is a
network node, with TCP/QUIC, signed GossipSub, discovery and Circuit Relay.
The clarified requirement of 2026-10-06 is zero-config mDNS on LAN and automatic
Internet entry into WORLD without pasting an invitation address. No single
mandatory central account, message/history authority or Konofix-owned VPS is
permitted. libp2p is the foundation; KNP is an optional additional contact path
with its own identity boundary.

Two fresh Internet nodes need a reachable first contact, but **operator-owned
VPSs and a dedicated server are not product prerequisites**. The experimental
public cold-start adapter uses shared Amino provider routing only to find
untrusted contact hints. It then authenticates and verifies bounded, short-lived
signed advertisements before handing contacts to native direct-first libp2p.
A publicly reachable desktop can provide bounded relay service unless the visible
session option is cleared; a fresh reachability witness is still mandatory.
Public IPFS peers are not Konofix relays, room-membership authorities or history
servers. Native configured pools and the headless Node remain optional operator
alternatives. See [COLD_START_DESKTOP.md](COLD_START_DESKTOP.md) for limits,
observable public metadata and the visible default-on session controls.

For WORLD presence and public text, the same session choice also enables the
[replaceable public Nostr relay fallback](WORLD_RELAY_FALLBACK.md). It provides a
NAT-safe live path while the native mesh is unavailable, with signed ephemeral
events and multi-relay deduplication. Version 0.5.3 adds recipient-addressed NIP-44
private text and accepted encrypted files up to 2 MiB without making the relay an
authority for native PeerIDs or rooms. Relay operators can observe or copy public
WORLD content and connection/ciphertext metadata; the design avoids dependence on
any one relay rather than claiming that no third-party transport exists.

**Current evidence:** the original candidate's empty pool explained the physical
LAN-to-LTE [WAN FAIL #165](https://github.com/Swir/Konofix/issues/165). The four
configured Nostr relays later passed a bounded two-client presence/text probe,
and the user then confirmed that exact candidate `8f6772b8…` restored normal
typed communication on the two physical installations across their
independent-network test. The physical route subtype and restart recovery were
not recorded, so this limited PASS authorizes a preview but does not complete
the broader WAN gate. Preserve the original failure and append each new attempt
separately. Direct TCP/QUIC remains preferred where NAT allows, without promising
universal hole punching; native rooms and larger streamed files still need a direct
or compatible participant circuit path, while the new encrypted private/small-file
fallback remains pending an exact 0.5.3 physical retest.

Qualification must exercise at least three participant nodes across at least two independent networks, with at least two reachable contact/relay paths, then demonstrate recovery when one leaves. Participants may keep the app open or optionally run the headless Node. Ephemeral desktop identities and addresses are valid for the running session. After all compatible participants leave, automatic public rediscovery must recover when participants return; an invitation-only recovery is diagnostic and cannot satisfy automatic WORLD.

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

## Build-owned pool admission is not network evidence

Windows and Linux Node tests validate every committed seed with the real libp2p
Multiaddr/PeerID parser and the existing strict public-host policy. A nonempty
pool must contain at least three distinct identities, each with direct TCP and
QUIC-v1, at different configured hostnames/IP literals. Duplicates, extra
protocols/circuits, zero ports, placeholders, private/CGNAT/documentation hosts
and unsupported JSON fields/schema are rejected. The 32-address limit remains.

The empty native pool is allowed because it is optional. It records the original candidate's missing-first-contact condition; the experimental shared-overlay route has separate admission and evidence gates.
Passing this static check does not enable publication or establish DNS,
ownership, distinct providers/ASNs, reachability, relay service or WAN success.
Different hostnames may still resolve to one machine: independent operator and
failure-domain review plus actual external observations remain required. The
checks apply to build-owned defaults; user-supplied lab/LAN contacts keep their
existing runtime handling.
