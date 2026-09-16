# Konofix Chat 0.4.2 — Test Plan

This document defines the minimum test set required before closing the first release stage intended for communication between different countries and independent networks.

## 1. Local validation

On Windows 11 run `.\scripts\check.ps1`. The local preflight runs the release gate, network-evidence self-tests, network-report-editor self-tests, strict bootstrap-precheck self-tests, public-Node deployment/readiness self-tests, Node-health self-tests, Node-soak validator/collector self-tests, project/localization audit, deterministic `npm ci`, TypeScript/Vite build, a locked Rust metadata check, Rust all-target tests and Rust checks for both the application and `konofix-node`. GitHub Actions runs the same core validation on `windows-latest`, and pull requests reproduce the production Windows packaging/verification path before merge.

## 2. LAN baseline

Before Internet testing, validate two computers on the same LAN: different nicknames, mDNS discovery, `#WORLD` both ways, a temporary room, small and 100+ MB file transfers, cancellation, and room cleanup after its host leaves. Do not proceed if this baseline fails.

## 3. Public Konofix Node

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

A single healthy snapshot is not sufficient for stable promotion. Use `scripts\collect-node-soak.ps1` to capture only health snapshots that pass the strict health validator, then validate the resulting history with `scripts\validate-node-soak.ps1`; see `docs\NODE_SOAK.md`. Schema-v2 Node health carries the exact source commit, and the promotion gate requires that soak history to use the same Node version, exact source commit and bootstrap Peer ID as the real-network evidence.

## 4. Bootstrap precheck

On every test PC run `.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADDRESS/tcp/45555/p2p/PEER_ID"`. DNS and IPv6 multiaddresses are supported. The precheck uses strict multiaddr parsing: it rejects malformed host/port values, unsupported transports, missing/invalid Peer IDs, extra path segments, UDP addresses that are not explicit `quic-v1`, and TCP addresses carrying QUIC-only segments. TCP reachability must succeed before application-level testing; UDP/QUIC is structurally validated by this script and then verified through libp2p during the real test.

For parser-only validation without touching the network, use `-ValidateOnly`. `-AsJson` prints the normalized parsed address for automation. The Windows test archive includes this script, `public-node.ps1`, `check-public-node-readiness.ps1`, and the evidence/health/soak tools under its `scripts` directory, so a tester or Node operator does not need a source checkout to run the operational test flow.

## 5. Cross-country test

Minimum topology: Client A in country/network A, Client B in a different country and independent network/operator B, and a publicly reachable Node, preferably on a third network. Exchange `#WORLD` messages both ways, discover a room, transfer files both ways and compare SHA-256, reconnect clients, restart Node while preserving Peer ID, then repeat after several minutes.

## 6. Transport and NAT matrix

Verify TCP, UDP/QUIC, Circuit Relay, DCUtR/direct upgrade where possible, and the critical CGNAT ↔ public Node ↔ CGNAT topology. Do not infer transport success from general chat success: each required transport gets its own report.

## 7. Reproducible test report

For Internet scenarios use schema-v3 endpoint metadata. Run the generator from the extracted Windows test bundle so it automatically reads the exact `commit` from `BUILD_INFO.json`:

```powershell
.\scripts\new-network-test-report.ps1 `
  -Scenario CGNAT `
  -ClientA "PC-A" -ClientACountry "Norway" -ClientANetwork "Operator-A LTE" `
  -ClientB "PC-B" -ClientBCountry "Poland" -ClientBNetwork "Operator-B LTE" `
  -BuildVersion "0.4.2" -NodeVersion "0.4.2" `
  -Bootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/PEER_ID"
```

If `BUILD_INFO.json` and Git metadata are unavailable, the generator fails closed instead of creating ambiguous release evidence; `-SourceCommit <40-character SHA>` can be supplied explicitly when the exact verified commit is known.

Do not hand-edit JSON and Markdown independently. Record each observed check with the bundled editor; it updates the authoritative schema-v3 JSON, stores a short per-check evidence note, recomputes `overall`, and regenerates the matching Markdown report:

```powershell
.\scripts\set-network-test-result.ps1 `
  -Manifest .\test-results\network-test-cgnat-YYYYMMDD-HHMMSS.json `
  -Check world_a_to_b `
  -Result PASS `
  -Evidence "Message ID/UTC recorded on PC-B"
```

Once every promotion-critical check for the scenario has passed, use `-Finalize` on the last update (or repeat the last PASS update). Finalization runs the schema-v3 validator before replacing the source files. Previously recorded PASS/FAIL/N/A evidence cannot be changed to a different result unless `-AllowOverwrite` is supplied explicitly, which makes accidental evidence loss harder.

Internet reports are rejected at creation time if countries or network/operator identifiers are missing, countries match, networks match, the two endpoint identifiers normalize to the same value, or the source commit cannot be established. The generated JSON is schema v3. After recording results, validate the evidence set with:

```powershell
.\scripts\validate-network-test-report.ps1 -Manifest .\test-results\*.json
```

The promotion gate requires one consistent client/Node build, one exact source commit, fresh evidence (30 days by default), PASS for all core communication/resilience checks, Relay observation in Relay and CGNAT evidence, DCUtR upgrade in DCUtR evidence, and passing manifests for TCP, QUIC, Relay, DCUtR and CGNAT. Use `-MaxAgeDays` to tighten the freshness window. `overall=PASS` by itself is intentionally insufficient.

Never put identity keys, access tokens, private addresses or other secrets in reports.

## 8. Nickname reservation test

Start two clients with the same nickname, repeat with different letter case, verify that only one Peer ID retains the synchronized reservation, then verify that the nickname becomes available after the winner leaves and its lease expires.

## 9. Resilience testing

Test Wi-Fi/LTE loss during transfer, app closure during transfer, Node restart, malformed/unreachable/duplicate bootstrap entries, dangerous executable/script extensions and cancellation from both sides. The app must not crash or leave a completed output file after failed SHA-256 verification.

## 10. Release-stage gate and artifact provenance

A cross-country GitHub test release is build-ready only with green Windows CI, production app and Node binaries, consistent documentation/versioning, verified artifacts and a real public bootstrap path. Promotion beyond the test release additionally requires validated schema-v3 evidence from independent countries/networks for the required transport/NAT scenarios, continuous schema-v2 Node-soak evidence bound to the same bootstrap Peer ID/version/source commit, and fixes for issues discovered during those tests.

Every Windows CI archive includes `BUILD_INFO.json`. It records the exact Git commit, project version, workflow run, SHA-256 and byte size of `konofix-node.exe`, SHA-256 and byte size of every `.exe`/`.msi` installer, hashes/sizes for the bundled operational test scripts, the exact committed frontend lockfile, and the exact committed Rust lockfile. The Node binary embeds the same source commit into its health telemetry. `scripts\verify-release.ps1` extracts the ZIP and cross-checks packaged metadata and both dependency lockfiles against the committed build inputs before the artifact is uploaded.

Stable promotion resolves the target commit from `-ExpectedSourceCommit`, `GITHUB_SHA`, or the clean Git working tree and passes that exact value into both network-evidence and Node-soak validation. This prevents evidence collected for an earlier `0.4.2` commit from being reused for a different `0.4.2` build.

Frontend dependency resolution is deterministic through the committed `package-lock.json` and `npm ci`. Rust dependency resolution is deterministic through committed `src-tauri\Cargo.lock`; CI/local/build helpers use `--locked` validation/build commands, and release verification rejects an archive whose packaged Cargo lockfile differs from the committed build input.
