# Konofix Chat 0.4.2

**Konofix Chat** is an ephemeral peer-to-peer messenger for Windows created by **Swir**. Start the app, choose a nickname, join the global `#WORLD` room, create temporary rooms, and transfer files directly to other peers. When the app closes, the user disappears from the active network.

GitHub: https://github.com/Swir/Konofix

## Project progress

**Real Internet Test milestone: 91% complete**

`██████████████████░░ 91%`

The percentage is calculated from the checked tasks in the active `0.4.2 — Real Internet Test` roadmap milestone (53 of 58 tasks complete). It is intentionally not increased by CI runs alone: the remaining public-Node, cross-country, CGNAT, transport and real-world-fix work must actually pass before the milestone can reach 100%.

## Core principles

- no traditional account, email address, or phone number,
- one active nickname per network; `SWIR` and `swir` are treated as the same nickname,
- global `#WORLD` room,
- user-created rooms are temporary,
- Konofix Chat does not archive message history on a central server,
- signed GossipSub payload identities must match the authenticated libp2p source Peer ID before presence, chat, room or nickname events are accepted,
- P2P file transfers require recipient approval and transfer-control messages are bound to the requesting peer,
- files are transferred in 256 KiB chunks and verified with SHA-256,
- direct P2P is preferred; Circuit Relay is a fallback path,
- discovered peer addresses are cached locally,
- closing the app removes the user's active network presence.

## 0.4.2 — Real Internet Test

This version prepares the project for real cross-network and cross-country tests. `Konofix Node` can generate ready-to-use TCP and QUIC bootstrap multiaddresses containing its Peer ID.

```powershell
konofix-node.exe --port 45555 --public-host 203.0.113.10
```

Paste the recommended address into **Network settings → Bootstrap**. A bootstrap helps peers discover the DHT/relay network; it is not a message-history server or file store.

Stable promotion also requires a continuous public-Node soak history that proves the Node kept one version, source commit and Peer ID, did not restart inside the evidence window, produced fresh snapshots without excessive monitoring gaps, and actually observed peer activity. The soak identity is bound to the same bootstrap Peer ID and exact source commit used by the validated cross-country manifests. Public/community deployments can pin identity storage explicitly with `--identity-file`; existing invalid identity files now fail closed instead of being silently replaced with a new Peer ID. A validated soak collector snapshots only health data that passes the same strict health gate, deduplicates unchanged samples, rejects conflicting same-timestamp evidence and is included in verified Windows artifacts. Cross-country testers also get a report editor that updates schema-v3 JSON and Markdown together, protects recorded results from accidental overwrite and can validate a completed scenario before finalizing it. The Windows test archive includes `new-network-test-session.ps1`, which verifies its exact `BUILD_INFO.json` and packaged Node bytes, verifies paired TCP/QUIC bootstrap identity, and atomically creates the five required PENDING scenario reports plus a session inventory before testing starts. `validate-network-test-session.ps1` then prevents those reports from being mixed with a different endpoint pair, country/network pair, build, source commit or bootstrap identity during stable promotion. The promotion validator treats schema-v3 JSON as typed evidence rather than coercible PowerShell values, enforces canonical casing and bounds manifest size before parsing. The verified Windows archive also includes `check-promotion-evidence.ps1`, which joins exact artifact provenance, one coherent session, all required network manifests and the matching Node-soak history into one fail-closed PASS preflight. See `docs/NODE.md`, `docs/NODE_SOAK.md`, and `docs/TESTING.md`.

## Localization

Konofix Chat detects the operating-system language automatically. The current UI localization layer supports **English, Polish, Norwegian, German, French, Spanish, and Ukrainian**. Unsupported system languages and missing per-language entries fall back to **English**. Runtime UI text now goes through a typed message-key API with explicit parameters for dynamic values; the old DOM/source-text compatibility translator has been removed. Repository documentation, release notes, CI text, and development-facing content are maintained in English.

## Architecture

Frontend: **Tauri 2 + TypeScript**  
Core: **Rust + Tokio + rust-libp2p**

The client network stack includes TCP, QUIC, Noise/Yamux, GossipSub, mDNS, Kademlia DHT, Identify, Ping, AutoNAT, Circuit Relay client/server, DCUtR, UPnP, and CBOR request-response for file transfer.

## Development

Requirements: Windows 11, Node.js 22+, and Rust MSVC.

```powershell
npm ci
npm run tauri dev
```

Project checks:

```powershell
.\scripts\check.ps1
```

GitHub Actions validates TypeScript/Vite, Rust formatting, Rust all-target tests and checks, `konofix-node`, release/network/public-Node/readiness/Node-health/Node-soak gates, exact-build promotion evidence, atomic exact-build network-session creation and consistency, network-report editing, Node-soak collection, localization/project consistency, and the production Windows bundle. Pull requests to `main` execute the production Tauri build, production Node build, test-bundle staging, ZIP/SHA-256 generation and release-artifact verification before merge; only artifact upload remains restricted to a `main` push. The localization audit requires the typed `MessageKey`/`t()` API, rejects the removed DOM/source-text translator pattern, and fails if Polish UI literals return to `src/main.ts`. Frontend dependencies are pinned by the committed `package-lock.json`; CI and the local preflight use `npm ci --no-audit --no-fund`, with setup-node caching keyed to that exact lockfile. Rust dependencies are pinned by committed `src-tauri/Cargo.lock`; CI/local validation uses `cargo metadata/test/check/build --locked` where applicable, requires `cargo fmt --check`, and the Windows helper verifies the locked graph before Tauri packaging. The project audit verifies both lockfile policies and rejects CI/build-helper drift. GitHub Actions are pinned to immutable commit SHAs, checkout credentials are not persisted, superseded runs are cancelled automatically, and build/test steps receive a read-only repository token. Ordinary pushes do not publish GitHub Releases; publication remains a deliberate gate after public-network readiness is demonstrated.

Each Windows CI archive also carries `BUILD_INFO.json` with the exact commit/version and SHA-256 plus byte size for `konofix-node.exe`, the committed frontend and Rust lockfiles, the bundled test tools and every Windows installer. Release verification requires both packaged lockfiles to match their committed build inputs by size and SHA-256. The Node binary embeds that same source commit in its schema-v2 health snapshots. Real-network evidence is schema v3 and stable promotion rejects evidence, Node health or soak history from any other source commit, preventing two different `0.4.2` builds from being treated as interchangeable.

## Windows build

```powershell
.\scripts\build-windows.ps1
```

The application bundle is written to `src-tauri\target\release\bundle`.

### Konofix Node

```powershell
build-node.bat
```

For a long-lived public/community Node, the recommended Windows-artifact path is the fail-closed deployment preflight/launcher. It validates the public host, rejects private/CGNAT/documentation/special-use IP literals by default, keeps identity and health state on separate paths, optionally verifies DNS resolution, and passes an explicit persistent identity file to the Node:

```powershell
.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -RequireDnsResolution

.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -Start
```

`-AllowPrivateAddress` exists only for controlled LAN/lab tests. The launcher is included in the verified Windows test archive, so a public Node operator does not need a source checkout.

For a Node that should survive logoff/reboot without keeping an interactive terminal open, the same verified Windows archive includes a supervised startup-task installer. Preview the exact SYSTEM task, persistent paths and optional firewall changes first, then install from an elevated PowerShell window:

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

The installer stages `konofix-node.exe` and the validated launcher under persistent state, runs the Node as SYSTEM at boot, configures restart-on-failure, and can create only the scoped inbound TCP/UDP rules for the selected port. `-Uninstall` removes the task and its firewall group but deliberately preserves Node identity/state, preventing accidental bootstrap Peer-ID rotation.

The raw Node command remains available when explicit manual control is needed:

```powershell
konofix-node.exe `
  --port 45555 `
  --public-host YOUR_PUBLIC_IP_OR_DNS `
  --identity-file C:\Konofix\node-identity.key `
  --health-file C:\Konofix\health.json
```

Open TCP 45555 and UDP 45555. See `docs/NODE.md` for operator details and `docs/NODE_SOAK.md` for stable-promotion soak evidence.

Before a client test, validate both advertised transports against the same Node identity and fresh health snapshot:

```powershell
.\scripts\check-public-node-readiness.ps1 `
  -TcpBootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/12D3KooW..." `
  -QuicBootstrap "/dns/node.yourdomain.com/udp/45555/quic-v1/p2p/12D3KooW..." `
  -HealthPath "C:\Konofix\node-health.json" `
  -ExpectedVersion "0.4.2" `
  -ExpectedSourceCommit "FULL_40_CHARACTER_COMMIT_SHA"
```

The readiness check verifies strict TCP/QUIC multiaddr structure, same host/port/Peer ID, health identity/version/source commit and TCP socket reachability. It deliberately does **not** claim a successful QUIC handshake; QUIC must still pass the real Konofix/libp2p transport scenario.

For a single bootstrap precheck you can still run:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW..."
```

From the extracted verified Windows archive, create the complete five-scenario evidence workspace before cross-country testing:

```powershell
.\scripts\new-network-test-session.ps1 `
  -ClientA "PC-A" -ClientACountry "Norway" -ClientANetwork "Operator-A LTE" `
  -ClientB "PC-B" -ClientBCountry "Poland" -ClientBNetwork "Operator-B LTE" `
  -TcpBootstrap "/dns/node.yourdomain.com/tcp/45555/p2p/PEER_ID" `
  -QuicBootstrap "/dns/node.yourdomain.com/udp/45555/quic-v1/p2p/PEER_ID"
```

The helper refuses mismatched/tampered build provenance, mismatched TCP/QUIC Node identity, same-country/same-network endpoints and existing session output. It creates the TCP/QUIC/Relay/DCUtR/CGNAT PENDING manifests only after every precondition passes, then moves the staged session into place atomically. This prepares evidence; it does not claim that any real transport succeeded.

Once the five required Internet manifests and Node-soak snapshots exist, run the bundled exact-build promotion preflight against the `BUILD_INFO.json` from the same extracted Windows archive and the `SESSION_INFO.json` that created those manifests:

```powershell
.\scripts\check-promotion-evidence.ps1 `
  -BuildInfoPath .\BUILD_INFO.json `
  -SessionInfoPath .\test-results\konofix-real-network-...\SESSION_INFO.json `
  -NetworkEvidence .\test-results\konofix-real-network-...\network-test-*.json `
  -NodeSoakEvidence .\node-soak\*.json
```

It returns PASS only when all required scenarios are valid and fresh, all five belong to the same exact-build session endpoint pair and paired TCP/QUIC bootstrap identity, and the soak history matches the exact artifact version, source commit and single bootstrap Peer ID.

## Local data

- peer cache: `%LOCALAPPDATA%\Konofix Chat\peer-cache.json`
- default Node identity: `%LOCALAPPDATA%\Konofix Chat\node-identity.key` (or the explicit `--identity-file` path)
- downloaded files: `Downloads\Konofix Chat`

## Project status

`0.4.2` is the **Real Internet Test** stage. The global P2P layer is ready for controlled testing, but cross-country connectivity and CGNAT ↔ relay scenarios remain unverified until they pass tests on independent networks through a stable public Konofix Node. The existing `v0.4.2-test1` pre-release is a test vehicle for collecting that evidence, not a declaration that these gates have passed. After this stage closes, development moves to **0.5.0 Rooms 2.0**.

---

**Konofix Chat — by Swir**  
https://github.com/Swir/Konofix
