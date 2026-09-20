# Konofix Chat 0.4.2 — Test Plan

This document defines the minimum test set required before closing the first release stage intended for communication between different countries and independent networks.

## 1. Local validation

Windows CI also installs the generated NSIS package into its disposable runner account, checks that the Start menu shortcut targets the exact `konofix-chat.exe`, and verifies that the bundled login page and Tauri bridge load in WebView2. It compares the MSI payload against the same production executable and checks the Windows GUI subsystem. This catches accidental packaging of the Node or Netprobe helper as the desktop app. `scripts/test-chat-installer.ps1` is restricted to disposable CI runners because it installs and uninstalls the app. Its loopback WebView debug port is enabled only for that test process, never by the shipped application.

On Windows 11 run `.\scripts\check.ps1`. The local preflight runs the release gate, network-evidence self-tests, exact-build promotion-evidence self-tests, network-report-editor and network-test-session self-tests, strict bootstrap-precheck self-tests, public-Node deployment/startup-task/readiness self-tests, Node-health self-tests, Node-soak validator/collector self-tests, project/localization audit, deterministic `npm ci`, TypeScript/Vite build, a locked Rust metadata check, Rust all-target tests and Rust checks for both the application and `konofix-node`. GitHub Actions runs the same core validation on `windows-latest`, and pull requests reproduce the production Windows packaging/verification path before merge.

## 2. LAN baseline

Before Internet testing, validate two computers on the same LAN: different nicknames, mDNS discovery, `#WORLD` both ways, a temporary room, small and 100+ MB file transfers, cancellation, and room cleanup after its host leaves. Do not proceed if this baseline fails.

## 3. Participant-operated Internet baseline

Every connected desktop application is a node. A separate Konofix Node service is optional. First verify at least three same-build desktop participants across independent networks: one shares a reachable address from Network settings, the others add it, and the applications discover additional peers. Record which addresses work directly, through a port mapping, or through another participant's relay. Do not treat a private LAN address as an Internet contact.

Create and switch between multiple rooms, return to WORLD, verify membership counts on all participants, add a late participant, and close the room host. Repeat after disconnect/reconnect and after losing one participant used for discovery or relay. All participants must use the same candidate build; older clients do not publish Rooms 2.0 membership and do not establish accurate all-participant counts. Qualify the actual TCP/QUIC/relay/NAT paths and file SHA-256 results, then complete the many-user scope in `GLOBAL_BETA.md`.

### Optional public Konofix Node

Prefer the fail-closed deployment preflight included in the extracted Windows test archive. First validate the intended public host and persistent state without launching:

```powershell
.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -RequireDnsResolution
```

Then start the same configuration:

```powershell
.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -Start
```

The preflight rejects private, CGNAT, documentation and other special-use IP literals by default, rejects local/single-label/reserved DNS names, prevents identity/health path collisions, and passes an explicit persistent identity path to the Node. Use `-AllowPrivateAddress` only for controlled lab tests. The raw `konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP_OR_DNS` path remains available for manual operation.

For a Windows public Node that must survive logoff and reboot, preview then install the bundled supervised startup task from an elevated shell:

```powershell
.\scripts\install-public-node-task.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\ProgramData\KonofixNode `
  -RequireDnsResolution `
  -ConfigureFirewall

.\scripts\install-public-node-task.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\ProgramData\KonofixNode `
  -RequireDnsResolution `
  -ConfigureFirewall `
  -Install `
  -StartNow
```

The task runs as SYSTEM at startup, uses a persistent staged Node/launcher, retries failures, and optionally creates only the scoped inbound TCP/UDP firewall rules. `-Uninstall` removes the task/firewall group while deliberately preserving the Node identity and health state.

Expose TCP and UDP 45555. Preserve the configured identity file for a stable Peer ID. Validate enabled health snapshots with `.\scripts\check-node-health.ps1 -Path "C:\Konofix\node-health.json"`; use `-RequirePeer` once clients should be connected.

Before distributing the bootstrap addresses to cross-country testers, run the combined readiness check from a machine that should be able to reach the Node:

```powershell
.\scripts\check-public-node-readiness.ps1 `
  -TcpBootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/PEER_ID" `
  -QuicBootstrap "/dns/node.yourdomain.com/udp/45555/quic-v1/p2p/PEER_ID" `
  -HealthPath "C:\Konofix\node-health.json" `
  -ExpectedVersion "0.4.2" `
  -ExpectedSourceCommit "FULL_40_CHARACTER_COMMIT_SHA"
```

This binds both advertised transports to the same host, port and Peer ID, then binds that Peer ID to the fresh Node-health version/source commit and checks TCP socket reachability. It validates QUIC multiaddr structure but intentionally does not claim a successful QUIC handshake; that evidence must come from the actual Konofix/libp2p QUIC scenario. `-SkipTcpReachability` exists for parser/fixture automation and must not be used as proof that a public Node is Internet-reachable.

A single healthy snapshot is not sufficient for stable promotion. For promotion-quality Windows public-Node evidence, collect the soak from the same extracted verified artifact and bind every accepted copy to that artifact's exact Node and `BUILD_INFO.json` hashes:

```powershell
.\scripts\collect-node-soak.ps1 `
  -HealthFile "C:\Konofix\node-health.json" `
  -OutputDirectory "C:\Konofix\soak-evidence" `
  -DurationSeconds 3600 `
  -IntervalSeconds 60 `
  -ExpectedVersion "0.4.2" `
  -ExpectedPeerId "PEER_ID" `
  -ExpectedSourceCommit "FULL_40_CHARACTER_COMMIT_SHA" `
  -BuildInfoPath ".\BUILD_INFO.json" `
  -NodeBinaryPath ".\konofix-node.exe"
```

The collector verifies the binary size/SHA-256 against `BUILD_INFO.json`, verifies health version/source provenance, and stamps only the validated evidence copies with exact Node and BUILD_INFO SHA-256 values. Final artifact promotion rejects unbound, mixed or mismatched soak history. See `docs\NODE_SOAK.md` for the validator and diagnostic-only legacy path.

## 4. Bootstrap precheck

On every test PC run `.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADDRESS/tcp/45555/p2p/PEER_ID"`. DNS and IPv6 multiaddresses are supported. The precheck uses strict multiaddr parsing: it rejects malformed host/port values, unsupported transports, missing/invalid Peer IDs, extra path segments, UDP addresses that are not explicit `quic-v1`, and TCP addresses carrying QUIC-only segments. TCP reachability must succeed before application-level testing; UDP/QUIC is structurally validated by this script and then verified through libp2p during the real test.

For parser-only validation without touching the network, use `-ValidateOnly`. `-AsJson` prints the normalized parsed address for automation. The Windows test archive includes this script, `public-node.ps1`, `install-public-node-task.ps1`, `check-public-node-readiness.ps1`, `new-network-test-session.ps1`, `validate-network-test-session.ps1`, `check-promotion-evidence.ps1`, and the evidence/health/soak tools under its `scripts` directory, so a tester or Node operator does not need a source checkout to run the operational test flow.

## 5. Cross-country test

Minimum topology: Client A in country/network A, Client B in a different country and independent network/operator B, and a publicly reachable Node, preferably on a third network. Exchange `#WORLD` messages both ways, discover a room, transfer files both ways and compare SHA-256, reconnect clients, restart Node while preserving Peer ID, then repeat after several minutes.

For every PASS/FAIL observation, record enough concrete evidence to identify what was actually observed without storing secrets. Suitable examples include a message ID plus UTC timestamp, the room name seen by both clients, the public Node Peer ID before/after restart, or a transport diagnostic showing Relay/DCUtR. For file transfers, record the actual full 64-character SHA-256 digest observed on both sender and receiver. Stable promotion rejects bare PASS flags and file-transfer claims without the digest.

## 6. Transport and NAT matrix

Verify TCP, UDP/QUIC, Circuit Relay, DCUtR/direct upgrade where possible, and the critical CGNAT ↔ public Node ↔ CGNAT topology. Do not infer transport success from general chat success: each required transport gets its own report.

## 7. Exact-build test session bootstrap

Prefer creating the whole five-scenario evidence workspace in one command from the **extracted verified Windows test archive**:

```powershell
.\scripts\new-network-test-session.ps1 `
  -ClientA "PC-A" -ClientACountry "Norway" -ClientANetwork "Operator-A LTE" `
  -ClientB "PC-B" -ClientBCountry "Poland" -ClientBNetwork "Operator-B LTE" `
  -TcpBootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/PEER_ID" `
  -QuicBootstrap "/dns/node.yourdomain.com/udp/45555/quic-v1/p2p/PEER_ID"
```

The session bootstrap fails closed before creating final evidence if the two endpoints are not independent, `BUILD_INFO.json` is malformed, the exact packaged `konofix-node.exe` bytes do not match its recorded SHA-256/size, the source commit is not canonical, or TCP and QUIC do not describe the same host, port and Peer ID. It stages output in a temporary directory and moves it into place only after all five schema-v3 PENDING manifests were created successfully, so a failed setup cannot leave a half-created test session that looks complete.

The resulting session directory contains copied `BUILD_INFO.json`, a `SESSION_INFO.json` inventory with the exact version/commit/Node hash/bootstrap identity and hashes of the five initial manifests, plus TCP, QUIC, Relay, DCUtR and CGNAT report pairs. The QUIC scenario starts with the QUIC bootstrap; the remaining scenarios use the paired TCP bootstrap while preserving the same Node Peer ID. Session creation does **not** prove reachability or a transport handshake; both clients still run the real prechecks and scenarios below.

After reports have been edited, `validate-network-test-session.ps1` checks the live manifest set against the immutable session bindings rather than comparing the initial manifest hashes. It rejects mixed endpoint pairs, changed country/network metadata, a different build/commit, a bootstrap outside the paired TCP/QUIC session identity, missing/duplicate scenarios, or a manifest set that no longer matches the session inventory. With `-RequirePassingEvidence`, it also requires the normal schema-v3 evidence gate to pass, including concrete per-check evidence and full file-transfer digests.

## 8. Reproducible test report

If a single report is needed independently, use the schema-v3 generator from the extracted Windows test bundle so it automatically reads the exact `commit` from `BUILD_INFO.json`:

```powershell
.\scripts\new-network-test-report.ps1 `
  -Scenario CGNAT `
  -ClientA "PC-A" -ClientACountry "Norway" -ClientANetwork "Operator-A LTE" `
  -ClientB "PC-B" -ClientBCountry "Poland" -ClientBNetwork "Operator-B LTE" `
  -BuildVersion "0.4.2" -NodeVersion "0.4.2" `
  -Bootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/PEER_ID"
```

If `BUILD_INFO.json` and Git metadata are unavailable, the generator fails closed instead of creating ambiguous release evidence; `-SourceCommit <40-character SHA>` can be supplied explicitly when the exact verified commit is known.

Do not hand-edit JSON and Markdown independently. Record each observed check with the bundled editor; it updates the authoritative schema-v3 JSON, stores a short per-check evidence note, recomputes `overall`, and regenerates the matching Markdown report. PASS and FAIL require a non-empty evidence note. File-transfer PASS requires the actual full SHA-256 digest in that note:

```powershell
.\scripts\set-network-test-result.ps1 `
  -Manifest .\test-results\network-test-cgnat-YYYYMMDD-HHMMSS.json `
  -Check world_a_to_b `
  -Result PASS `
  -Evidence "Message ID msg-123 received on PC-B at 2026-09-16T18:00:00Z"

.\scripts\set-network-test-result.ps1 `
  -Manifest .\test-results\network-test-cgnat-YYYYMMDD-HHMMSS.json `
  -Check file_a_to_b_sha256 `
  -Result PASS `
  -Evidence "sender/receiver sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

Once every promotion-critical check for the scenario has passed, use `-Finalize` on the last update (or repeat the last PASS update). Finalization runs the schema-v3 validator before replacing the source files. Previously recorded PASS/FAIL/N/A evidence cannot be changed to a different result unless `-AllowOverwrite` is supplied explicitly, which makes accidental evidence loss harder. Rejected evidence updates do not modify the authoritative source manifest.

Internet reports are rejected at creation time if countries or network/operator identifiers are missing, countries match, networks match, the two endpoint identifiers normalize to the same value, or the source commit cannot be established. The generated JSON is schema v3. After recording results, validate the evidence set with:

```powershell
.\scripts\validate-network-test-report.ps1 -Manifest .\test-results\*.json
```

The promotion gate requires one consistent client/Node build, one exact source commit, fresh evidence (30 days by default), PASS for all core communication/resilience checks, Relay observation in Relay and CGNAT evidence, DCUtR upgrade in DCUtR evidence, and passing manifests for TCP, QUIC, Relay, DCUtR and CGNAT. With the stable-promotion `RequireAllChecks` path, every PASS check must also have a concrete non-empty `check_evidence` string and both file-transfer checks must contain a full 64-character SHA-256 digest. Use `-MaxAgeDays` to tighten the freshness window. `overall=PASS` by itself is intentionally insufficient.

Once all five manifests, both client Netprobe records and the exact-build-bound Node soak history are complete, bind them to the exact Windows artifact **and the one session that created them** in one command:

```powershell
.\scripts\check-promotion-evidence.ps1 `
  -BuildInfoPath .\BUILD_INFO.json `
  -SessionInfoPath .\test-results\konofix-real-network-...\SESSION_INFO.json `
  -NetworkEvidence .\test-results\konofix-real-network-...\network-test-*.json `
  -ClientNetprobeEvidence .\test-results\konofix-real-network-...\client-*-netprobe.json `
  -NodeSoakEvidence .\node-soak\*.json
```

This preflight validates the exact `BUILD_INFO.json` version/source commit and packaged Node bytes, validates every required schema-v3 scenario, requires all five reports to belong to the same session endpoint pair and paired TCP/QUIC bootstrap identity, requires exactly one Client A and one Client B authenticated TCP+QUIC Netprobe record from distinct host/default-route contexts, requires evidence-rich PASS observations including real file digests, extracts the single validated bootstrap Peer ID, and finally requires the Node-soak history to match that same version, source commit, Peer ID, Node binary SHA-256 and `BUILD_INFO.json` SHA-256 while proving peer activity. The stable source-tree release gate likewise requires `-NetworkSessionInfo` whenever `-RequireNetworkEvidence` is used. These checks cannot replace the real tests; they prevent unrelated, evidence-free or mismatched claims from being combined after those tests are complete.

Never put identity keys, access tokens, private addresses or other secrets in reports.

## 9. Nickname reservation test

Start two clients with the same nickname, repeat with different letter case, verify that only one Peer ID retains the synchronized reservation, then verify that the nickname becomes available after the winner leaves and its lease expires.

## 10. Resilience testing

Test Wi-Fi/LTE loss during transfer, app closure during transfer, Node restart, malformed/unreachable/duplicate bootstrap entries, dangerous executable/script extensions and cancellation from both sides. The app must not crash or leave a completed output file after failed SHA-256 verification.

## 11. Release-stage gate and artifact provenance

A cross-country GitHub test release is build-ready only with green Windows CI, production app and Node binaries, consistent documentation/versioning, verified artifacts and a real public bootstrap path. Promotion beyond the test release additionally requires validated schema-v3 evidence from independent countries/networks for the required transport/NAT scenarios, one coherent `SESSION_INFO.json` binding those five scenarios to the same endpoint pair and TCP/QUIC bootstrap identity, exactly two authenticated schema-2 client Netprobe records from distinct host/network contexts, concrete per-PASS observations with full file-transfer SHA-256 digests, continuous schema-v2 Node-soak evidence bound to the same bootstrap Peer ID/version/source commit **and exact packaged Node/BUILD_INFO hashes**, and fixes for issues discovered during those tests.

Every newly built Windows CI archive includes schema-v2 `BUILD_INFO.json`. It records the exact Git commit, project version and workflow run, retains dedicated Node/installer/test-tool/dependency-lock metadata, and additionally seals every staged regular file except `BUILD_INFO.json` itself with its relative path, exact byte size and SHA-256. `scripts\verify-release.ps1` verifies the outer ZIP checksum, inspects ZIP member paths before extraction, rejects traversal and duplicate/case-colliding file entries, extracts into an isolated directory, verifies every inventory entry, and rejects any missing or unexpected file. CI also re-hashes deliberately tampered archives with an extra file and a parent-directory entry to prove that a valid outer checksum alone cannot bypass the sealed inventory. The Node binary embeds the same source commit into its health telemetry.

Stable promotion resolves the target commit from `-ExpectedSourceCommit`, `GITHUB_SHA`, or the clean Git working tree and passes that exact value into network-evidence, session-consistency and Node-soak validation. The bundled `check-promotion-evidence.ps1` gives remote testers the stronger artifact-level binding using the verified `BUILD_INFO.json`: it requires authenticated dual-client Netprobe evidence and exact-build-bound soak copies whose Node/BUILD_INFO hashes match the packaged release. This prevents evidence collected for an earlier `0.4.2` commit, another same-version/same-source Node build, a different client pair or evidence-free PASS claims from being reused for a different `0.4.2` artifact/session.

Frontend dependency resolution is deterministic through the committed `package-lock.json` and `npm ci`. Rust dependency resolution is deterministic through committed `src-tauri\Cargo.lock`; CI/local/build helpers use `--locked` validation/build commands, and release verification rejects an archive whose packaged Cargo lockfile differs from the committed build input.
