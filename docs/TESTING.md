# Konofix Chat 0.4.2 — Test Plan

This document defines the minimum test set required before closing the first release stage intended for communication between different countries and independent networks.

## 1. Local validation

On Windows 11:

```powershell
.\scripts\check.ps1
```

The validation must pass without errors for:

- TypeScript/Vite,
- the Rust/Tauri application,
- `konofix-node`.

GitHub Actions runs the same core validation on `windows-latest`.

## 2. LAN baseline

Before Internet testing, validate two computers on the same LAN:

1. Start Konofix Chat on both computers.
2. Use different nicknames.
3. Both clients should discover each other through mDNS.
4. Send messages both ways in `#WORLD`.
5. Create a temporary room.
6. Send a small file and a file of at least 100 MB.
7. Cancel one transfer while it is active.
8. Close the room host — the room should disappear on the other client.

If the LAN baseline fails, do not proceed to Internet testing.

## 3. Public Konofix Node

The simplest startup path is:

```text
run-node.bat
```

The script asks for a public IP address or DNS name.

Manual startup:

```powershell
konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP_OR_DNS
```

The VPS/router firewall must expose:

- TCP 45555,
- UDP 45555.

The Node prints ready TCP and QUIC multiaddresses ending in `/p2p/<PeerId>`.

Do not delete `%LOCALAPPDATA%\Konofix Chat\node-identity.key` if the Node Peer ID must remain stable across restarts.

## 4. Bootstrap precheck from each client

On every test computer:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADDRESS/tcp/45555/p2p/PEER_ID"
```

For DNS, use `/dns4/name...` or `/dns/name...`.

The TCP precheck must succeed before the application-level Internet test. UDP/QUIC is verified through libp2p during the actual test.

## 5. Cross-country test

Minimum topology:

| Role | Requirement |
| --- | --- |
| Client A | country/network A, for example Norway / LTE or fiber |
| Client B | country/network B, for example Poland / another ISP |
| Node | public IP/DNS, preferably on a third independent network |

Run these steps in order:

1. Both computers add the same bootstrap.
2. Start Konofix Chat on both with different nicknames.
3. Verify that the network panel shows bootstrap connectivity and a growing DHT peer count.
4. Send A → B and B → A messages in `#WORLD`.
5. Create a room on A and verify that it appears on B.
6. Send a file A → B and B → A.
7. Compare file size and SHA-256 between source and received files.
8. Restart both clients and verify peer discovery/cache reconnect behavior.
9. Restart the public Node and confirm that its Peer ID remains unchanged.
10. Repeat after several minutes without manually clearing the peer cache.

## 6. Transport and NAT matrix

Run multiple variants:

### A. TCP bootstrap

Use `/tcp/45555/p2p/...` and verify chat, room, and file transfer.

### B. QUIC

Use `/udp/45555/quic-v1/p2p/...` and verify connectivity over UDP/QUIC.

### C. Relay

At least one client should be behind NAT/CGNAT with no port forwarding. Confirm that it can enter the network through Circuit Relay.

### D. DCUtR

While connected through a relay, inspect logs/status and verify whether a successful hole punch can upgrade the connection to a direct path.

### E. CGNAT ↔ Node ↔ CGNAT

Critical scenario before closing the public test stage:

- client A behind CGNAT,
- client B behind a different CGNAT/NAT,
- public Konofix Node reachable from both sides.

## 7. Nickname reservation test

1. Start two clients with the same nickname.
2. Repeat with different letter case, for example `SWIR` and `swir`.
3. After network synchronization, only one Peer ID should retain the reservation.
4. After the winning peer leaves and the lease expires, the nickname should become available again.

## 8. Resilience testing

Also test:

- disabling Wi-Fi/LTE during transfer,
- closing the app during transfer,
- restarting the Node while clients remain active,
- malformed bootstrap,
- unreachable bootstrap,
- duplicate bootstrap entry,
- file with a dangerous executable/script extension,
- cancellation from both sides.

The application must not crash or leave a completed output file after a transfer with an invalid SHA-256. Incomplete data should remain only in `.konofixpart` temporary files and be cleaned according to transfer logic.

## 9. What to record for each test

Record:

- Konofix Chat version,
- country and connection type for both clients,
- NAT/CGNAT type when known,
- TCP/QUIC bootstrap used,
- whether relay was used,
- whether DCUtR appeared,
- chat: PASS/FAIL,
- rooms: PASS/FAIL,
- files: PASS/FAIL,
- reconnect: PASS/FAIL,
- nickname conflict: PASS/FAIL,
- failure description and when it occurred.

Never publish private identity keys or other secrets.

## 10. Release-stage gate

A cross-country GitHub test release is considered build-ready when:

- Windows CI is green,
- a production Windows build is generated in CI,
- `konofix-node.exe` is generated in CI,
- application and Node documentation use a consistent version,
- public Node startup instructions are ready,
- there is at least one realistic path to a publicly reachable bootstrap.

The 0.4.2 stage is fully complete only after a successful test over two independent Internet connections and fixes for issues discovered during those tests.
