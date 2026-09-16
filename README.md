# Konofix Chat 0.4.2

**Konofix Chat** is an ephemeral peer-to-peer messenger for Windows created by **Swir**. Start the app, choose a nickname, join the global `#WORLD` room, create temporary rooms, and transfer files directly to other peers. When the app closes, the user disappears from the active network.

GitHub: https://github.com/Swir/Konofix

## Project progress

**Real Internet Test milestone: 84% complete**

`█████████████████░░░ 84%`

The percentage is calculated from the checked tasks in the active `0.4.2 — Real Internet Test` roadmap milestone (32 of 38 tasks complete). It is intentionally not increased by CI runs alone: the remaining real public-Node, cross-country, CGNAT and transport verification work must actually pass before the milestone can reach 100%.

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

Example output:

```text
BOOTSTRAP TCP : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
BOOTSTRAP QUIC: /ip4/203.0.113.10/udp/45555/quic-v1/p2p/12D3KooW...
RECOMMENDED   : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

Paste the recommended address into **Network settings → Bootstrap**. A bootstrap helps peers discover the DHT/relay network; it is not a message-history server or file store.

## Localization

Konofix Chat detects the operating-system language automatically. The current UI localization layer supports **English, Polish, Norwegian, German, French, Spanish, and Ukrainian**. Unsupported system languages fall back to **English**.

Repository documentation, release notes, CI text, and development-facing content are maintained in English.

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

Or use `run-dev.bat`.

Project checks:

```powershell
.\scripts\check.ps1
```

GitHub Actions additionally validates TypeScript/Vite, the Rust application, `konofix-node`, and the production Windows bundle. Superseded CI runs on the same branch/ref are cancelled automatically so only the newest commit proceeds through expensive Windows packaging.

## Windows build

```powershell
.\scripts\build-windows.ps1
```

The application bundle is written to:

```text
src-tauri\target\release\bundle
```

### Konofix Node

```powershell
build-node.bat
```

Output:

```text
src-tauri\target\release\konofix-node.exe
```

Run the Node on a publicly reachable computer or VPS:

```powershell
konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP
```

Open TCP 45555 and UDP 45555. See `docs/NODE.md` for operator details.

Before a client test:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW..."
```

## Local data

- peer cache: `%LOCALAPPDATA%\Konofix Chat\peer-cache.json`
- Node identity: `%LOCALAPPDATA%\Konofix Chat\node-identity.key`
- downloaded files: `Downloads\Konofix Chat`

## Project status

`0.4.2` is the **Real Internet Test** stage. The global P2P layer is ready for controlled testing, but cross-country connectivity and CGNAT ↔ relay scenarios remain unverified until they pass tests on independent networks through a stable public Konofix Node. After this stage closes, development moves to **0.5.0 Rooms 2.0**.

---

**Konofix Chat — by Swir**  
https://github.com/Swir/Konofix
