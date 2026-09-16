# Konofix Chat 0.4.2

**Konofix Chat** is an ephemeral peer-to-peer messenger for Windows created by **Swir**. Start the app, choose a nickname, join the global `#WORLD` room, create temporary rooms, and transfer files directly to other peers. When the app closes, the user disappears from the active network.

GitHub: https://github.com/Swir/Konofix

## Project progress

**Real Internet Test milestone: 89% complete**

`██████████████████░░ 89%`

The percentage is calculated from the checked tasks in the active `0.4.2 — Real Internet Test` roadmap milestone (39 of 44 tasks complete). It is intentionally not increased by CI runs alone: the remaining public-Node, cross-country, CGNAT, transport and real-world-fix work must actually pass before the milestone can reach 100%.

## Core principles

- no traditional account, email address, or phone number,
- one active nickname per network; `SWIR` and `swir` are treated as the same nickname,
- global `#WORLD` room,
- user-created rooms are temporary,
- Konofix Chat does not archive message history on a central server,
- P2P file transfers require recipient approval,
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

Stable promotion also requires a continuous public-Node soak history that proves the Node kept one version, source commit and Peer ID, did not restart inside the evidence window, produced fresh snapshots without excessive monitoring gaps, and actually observed peer activity. The soak identity is bound to the same bootstrap Peer ID and exact source commit used by the validated cross-country manifests. See `docs/NODE_SOAK.md`.

## Localization

Konofix Chat detects the operating-system language automatically. The current UI localization layer supports **English, Polish, Norwegian, German, French, Spanish, and Ukrainian**. Unsupported system languages and missing per-language entries fall back to **English**. Runtime UI text now goes through a typed message-key API with explicit parameters for dynamic values; the old DOM/source-text compatibility translator has been removed. Repository documentation, release notes, CI text, and development-facing content are maintained in English.

## Architecture

Frontend: **Tauri 2 + TypeScript**  
Core: **Rust + Tokio + rust-libp2p**

The client network stack includes TCP, QUIC, Noise/Yamux, GossipSub, mDNS, Kademlia DHT, Identify, Ping, AutoNAT, Circuit Relay client/server, DCUtR, UPnP, and CBOR request-response for file transfer.

## Development

Requirements: Windows 11, Node.js 20+, and Rust MSVC.

```powershell
npm install
npm run tauri dev
```

Project checks:

```powershell
.\scripts\check.ps1
```

GitHub Actions validates TypeScript/Vite, Rust all-target tests and checks, `konofix-node`, release/network/Node-health/Node-soak gates, localization/project consistency, and the production Windows bundle. The localization audit requires the typed `MessageKey`/`t()` API, rejects the removed DOM/source-text translator pattern, and fails if Polish UI literals return to `src/main.ts`. The repository does not currently contain a committed `package-lock.json`, so CI intentionally uses `npm install --no-audit --no-fund --package-lock=false`; the audit derives dependency policy from Git-tracked files instead of transient workspace files, so an npm-generated lockfile cannot masquerade as a committed reproducibility guarantee. Lockfile-enforced `npm ci` remains pending until a real lockfile is committed and verified. GitHub Actions are pinned to immutable commit SHAs, checkout credentials are not persisted, superseded runs are cancelled automatically, and build/test steps receive a read-only repository token. Ordinary pushes do not publish GitHub Releases; publication remains a deliberate gate after public-network readiness is demonstrated.

Each Windows CI archive also carries `BUILD_INFO.json` with the exact commit/version and SHA-256 plus byte size for `konofix-node.exe` and every Windows installer. The Node binary embeds that same source commit in its schema-v2 health snapshots. Real-network evidence is schema v3 and stable promotion rejects evidence, Node health or soak history from any other source commit, preventing two different `0.4.2` builds from being treated as interchangeable. `scripts/verify-release.ps1` cross-checks packaged provenance against the extracted archive and verifies the captured `Cargo.lock` before upload. The lockfile currently records the Rust graph resolved by that build; it is not presented as a deterministic build input until a verified `src-tauri/Cargo.lock` is committed and enforced.

## Windows build

```powershell
.\scripts\build-windows.ps1
```

The application bundle is written to `src-tauri\target\release\bundle`.

### Konofix Node

```powershell
build-node.bat
```

Run the Node on a publicly reachable computer or VPS:

```powershell
konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP
```

Open TCP 45555 and UDP 45555. See `docs/NODE.md` for operator details and `docs/NODE_SOAK.md` for stable-promotion soak evidence.

Before a client test:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW..."
```

## Local data

- peer cache: `%LOCALAPPDATA%\Konofix Chat\peer-cache.json`
- Node identity: `%LOCALAPPDATA%\Konofix Chat\node-identity.key`
- downloaded files: `Downloads\Konofix Chat`

## Project status

`0.4.2` is the **Real Internet Test** stage. The global P2P layer is ready for controlled testing, but cross-country connectivity and CGNAT ↔ relay scenarios remain unverified until they pass tests on independent networks through a stable public Konofix Node. The existing `v0.4.2-test1` pre-release is a test vehicle for collecting that evidence, not a declaration that these gates have passed. After this stage closes, development moves to **0.5.0 Rooms 2.0**.

---

**Konofix Chat — by Swir**  
https://github.com/Swir/Konofix
