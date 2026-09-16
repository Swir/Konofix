# Konofix Chat 0.4.2 — Test Plan

This document defines the minimum test set required before closing the first release stage intended for communication between different countries and independent networks.

## 1. Local validation

On Windows 11 run `.\scripts\check.ps1`. The local preflight runs the release gate, network-evidence self-tests, Node-health self-tests, Node-soak self-tests, project/localization audit, TypeScript/Vite build, Rust all-target tests and Rust checks for both the application and `konofix-node`. GitHub Actions runs the same core validation on `windows-latest`.

## 2. LAN baseline

Before Internet testing, validate two computers on the same LAN: different nicknames, mDNS discovery, `#WORLD` both ways, a temporary room, small and 100+ MB file transfers, cancellation, and room cleanup after its host leaves. Do not proceed if this baseline fails.

## 3. Public Konofix Node

Use `run-node.bat` or `konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP_OR_DNS`. Expose TCP and UDP 45555. Preserve `%LOCALAPPDATA%\Konofix Chat\node-identity.key` for a stable Peer ID. Validate enabled health snapshots with `.\scripts\check-node-health.ps1 -Path "$env:LOCALAPPDATA\Konofix Chat\node-health.json"`; use `-RequirePeer` once clients should be connected.

A single healthy snapshot is not sufficient for stable promotion. Collect a continuous Node-health history and validate it with `scripts\validate-node-soak.ps1`; see `docs\NODE_SOAK.md`. The promotion gate requires that soak history to use the same Node version and bootstrap Peer ID as the real-network evidence.

## 4. Bootstrap precheck

On every test PC run `.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADDRESS/tcp/45555/p2p/PEER_ID"`. DNS multiaddresses are supported. TCP precheck must succeed before application-level testing; UDP/QUIC is verified through libp2p during the real test.

## 5. Cross-country test

Minimum topology: Client A in country/network A, Client B in a different country and independent network/operator B, and a publicly reachable Node, preferably on a third network. Exchange `#WORLD` messages both ways, discover a room, transfer files both ways and compare SHA-256, reconnect clients, restart Node while preserving Peer ID, then repeat after several minutes.

## 6. Transport and NAT matrix

Verify TCP, UDP/QUIC, Circuit Relay, DCUtR/direct upgrade where possible, and the critical CGNAT ↔ public Node ↔ CGNAT topology. Do not infer transport success from general chat success: each required transport gets its own report.

## 7. Reproducible test report

For Internet scenarios use schema-v2 endpoint metadata:

```powershell
.\scripts\new-network-test-report.ps1 `
  -Scenario CGNAT `
  -ClientA "PC-A" -ClientACountry "Norway" -ClientANetwork "Operator-A LTE" `
  -ClientB "PC-B" -ClientBCountry "Poland" -ClientBNetwork "Operator-B LTE" `
  -BuildVersion "0.4.2" -NodeVersion "0.4.2" `
  -Bootstrap "/dns/node.example.org/tcp/45555/p2p/PEER_ID"
```

Internet reports are rejected at creation time if countries or network/operator identifiers are missing, countries match, or networks match. The generated JSON is schema v2. After recording results, validate the evidence set with:

```powershell
.\scripts\validate-network-test-report.ps1 -Manifest .\test-results\*.json
```

The promotion gate requires one consistent client/Node build, fresh evidence (30 days by default), PASS for all core communication/resilience checks, Relay observation in Relay and CGNAT evidence, DCUtR upgrade in DCUtR evidence, and passing manifests for TCP, QUIC, Relay, DCUtR and CGNAT. Use `-MaxAgeDays` to tighten the freshness window. `overall=PASS` by itself is intentionally insufficient.

Never put identity keys, access tokens, private addresses or other secrets in reports.

## 8. Nickname reservation test

Start two clients with the same nickname, repeat with different letter case, verify that only one Peer ID retains the synchronized reservation, then verify that the nickname becomes available after the winner leaves and its lease expires.

## 9. Resilience testing

Test Wi-Fi/LTE loss during transfer, app closure during transfer, Node restart, malformed/unreachable/duplicate bootstrap entries, dangerous executable/script extensions and cancellation from both sides. The app must not crash or leave a completed output file after failed SHA-256 verification.

## 10. Release-stage gate and artifact provenance

A cross-country GitHub test release is build-ready only with green Windows CI, production app and Node binaries, consistent documentation/versioning, verified artifacts and a real public bootstrap path. Promotion beyond the test release additionally requires validated schema-v2 evidence from independent countries/networks for the required transport/NAT scenarios, continuous Node-soak evidence bound to the same bootstrap Peer ID/version, and fixes for issues discovered during those tests.

Every Windows CI archive includes `BUILD_INFO.json`. It records the exact Git commit, project version, workflow run, SHA-256 and byte size of `konofix-node.exe`, SHA-256 and byte size of every `.exe`/`.msi` installer, and the resolved `Cargo.lock` captured by that build. `scripts\verify-release.ps1` extracts the ZIP and cross-checks all of this metadata against the actual packaged files before the artifact is uploaded.

The captured `Cargo.lock` is useful evidence of the Rust dependency graph used by that particular build, but it is not a substitute for committing and enforcing the lockfile as an input. Until a verified `src-tauri\Cargo.lock` is committed, Rust dependency resolution is not claimed to be fully reproducible.
