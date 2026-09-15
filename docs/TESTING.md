# Konofix Chat 0.4.2 — Test Plan

This document defines the minimum test set required before closing the first release stage intended for communication between different countries and independent networks.

## 1. Local validation

On Windows 11:

```powershell
.\scripts\check.ps1
```

The validation must pass without errors for TypeScript/Vite, the Rust/Tauri application, and `konofix-node`. GitHub Actions runs the same core validation on `windows-latest`.

## 2. LAN baseline

Before Internet testing, validate two computers on the same LAN: use different nicknames, verify mDNS discovery, exchange messages in `#WORLD`, create a temporary room, transfer a small file and a file of at least 100 MB, cancel an active transfer, and verify room cleanup after its host leaves. If the LAN baseline fails, do not proceed to Internet testing.

## 3. Public Konofix Node

The simplest startup path is `run-node.bat`. Manual startup:

```powershell
konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP_OR_DNS
```

The VPS/router firewall must expose TCP 45555 and UDP 45555. The Node prints ready TCP and QUIC multiaddresses ending in `/p2p/<PeerId>`. Do not delete `%LOCALAPPDATA%\Konofix Chat\node-identity.key` when the Node Peer ID must remain stable.

When health snapshots are enabled, validate them before a remote test:

```powershell
.\scripts\check-node-health.ps1 -Path "$env:LOCALAPPDATA\Konofix Chat\node-health.json"
```

Use `-RequirePeer` after clients are expected to be connected.

## 4. Bootstrap precheck

Run on every test computer:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADDRESS/tcp/45555/p2p/PEER_ID"
```

For DNS use `/dns/name...` (or an address-family-specific DNS multiaddress when intentionally required). The TCP precheck must succeed before the application-level Internet test. UDP/QUIC is verified through libp2p during the actual test.

## 5. Cross-country test

Minimum topology: Client A on country/network A, Client B on a different country/network B, and a publicly reachable Node, preferably on a third independent network.

Run in order: both clients add the same bootstrap; start with different nicknames; verify bootstrap/DHT connectivity; exchange `#WORLD` messages both ways; create and discover a room; transfer files both ways and compare SHA-256; restart clients and verify reconnect; restart the public Node and confirm its Peer ID remains unchanged; repeat after several minutes without clearing peer caches.

## 6. Transport and NAT matrix

Test TCP bootstrap, UDP/QUIC, Circuit Relay with at least one client behind NAT/CGNAT without port forwarding, DCUtR/direct upgrade where possible, and the critical CGNAT ↔ public Node ↔ CGNAT scenario with clients behind independent networks.

## 7. Reproducible test report

Create a report before each controlled network test:

```powershell
.\scripts\new-network-test-report.ps1 `
  -Scenario CGNAT `
  -ClientA "Norway / LTE" `
  -ClientB "Poland / LTE" `
  -Bootstrap "/dns/node.example.org/tcp/45555/p2p/PEER_ID"
```

Supported scenarios are `LAN`, `TCP`, `QUIC`, `Relay`, `DCUtR`, and `CGNAT`. The generated Markdown file is stored under `test-results/` by default and contains a consistent PASS/FAIL matrix for messaging, rooms, bidirectional file transfer with SHA-256, reconnect, Node restart, relay/DCUtR observations, and nickname conflict handling.

Do not put private identity keys, access tokens, or other secrets in reports. Before publishing a report, remove private/local addresses that are not required to reproduce a failure.

## 8. Nickname reservation test

Start two clients with the same nickname, repeat with different letter case, verify that only one Peer ID retains the synchronized reservation, then verify that the nickname becomes available after the winning peer leaves and its lease expires.

## 9. Resilience testing

Also test disabling Wi-Fi/LTE during transfer, closing the app during transfer, restarting the Node while clients remain active, malformed/unreachable/duplicate bootstrap entries, dangerous executable/script file extensions, and cancellation from both sides. The application must not crash or leave a completed output file after invalid SHA-256 verification.

## 10. Release-stage gate

A cross-country GitHub test release is build-ready when Windows CI is green, production app and Node binaries are generated, documentation/versioning is consistent, Node startup instructions are ready, and there is a realistic publicly reachable bootstrap path.

The 0.4.2 stage is fully complete only after successful tests over two independent Internet connections, recorded transport/NAT results, and fixes for issues discovered during those tests.
