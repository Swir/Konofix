# Konofix Chat — Roadmap

## 0.1.0 — Foundation ✅
- Tauri + Rust + libp2p
- modern desktop GUI
- global `#WORLD`
- nickname and presence
- mDNS/LAN discovery
- temporary rooms

## 0.2.0 — Discovery / NAT ✅
- Kademlia DHT
- Identify
- AutoNAT
- DCUtR
- Circuit Relay client
- UPnP
- presence heartbeat
- distributed nickname reservation

## 0.3.0 — P2P File Transfer ✅
- user and file selection
- Accept / Reject flow
- 256 KiB transfer chunks
- progress indicator
- `.konofixpart` temporary files
- SHA-256 verification
- cancellation and size limits
- executable/script warnings

## 0.4.0 — Global Network Core ✅
- Circuit Relay server in clients
- automatic relay-listener reservation through bootstrap peers
- local cache of known peers
- reconnect attempts through the peer cache
- `Konofix Node` with bootstrap/DHT/relay/AutoNAT/GossipSub
- persistent Node Peer ID
- Windows build/test scripts

## 0.4.1 — Rebrand / Test Foundation ✅
- [x] full **Konofix Chat** rebrand
- [x] `by Swir • GitHub` footer
- [x] `Swir/Konofix` as the canonical project repository
- [x] restored normal source repository structure
- [x] Windows CI for TypeScript + Rust
- [x] public-bootstrap precheck script

## 0.4.2 — Real Internet Test 🚧
- [x] fixed Windows CI and restored `tsconfig.json`
- [x] added required Windows/Tauri icon and fixed the packaging pipeline
- [x] `Konofix Node --public-host` generates ready TCP/QUIC bootstrap addresses
- [x] `run-node.bat` guides the operator through Node startup
- [x] full multiaddr validation in `internet-test.ps1`
- [x] CI builds the production Windows app and `konofix-node.exe`
- [x] CI uploads a temporary Windows test bundle as a GitHub Actions artifact
- [x] cross-country test matrix for TCP, QUIC, relay, DCUtR, and CGNAT ↔ Node ↔ CGNAT
- [x] release gate validates versions, required files, icon, and documentation
- [x] test-release ZIP + SHA-256 checksum
- [x] automatic `v0.4.2-test1` pre-release after a successful production build
- [x] first GitHub pre-release for cross-country testing published
- [x] packaged artifact verification checks SHA-256, required files, Node binary, and Windows installer presence
- [x] system-language detection with English fallback
- [x] first localization layer: English, Polish, Norwegian, German, French, Spanish, Ukrainian
- [x] repository-facing documentation policy switched to English
- [x] CI project audit validates version consistency, English fallback, and English-only repository documentation/workflow text
- [x] localization architecture and migration policy documented in `docs/LOCALIZATION.md`
- [x] public Node CLI and operational scripts migrated to English-only output
- [x] project audit now enforces English-only Node CLI, PowerShell scripts, and batch launchers
- [x] Node prints periodic uptime and connected-peer telemetry for public test operations
- [x] Node warns on obviously non-public IP literals passed through `--public-host`
- [x] DNS bootstrap generation uses generic `/dns/...` multiaddresses for IPv4/IPv6-friendly resolution
- [x] optional metadata-only JSON health snapshot for VPS/service monitoring
- [x] health snapshot records version, stable Peer ID, uptime, peer count, timestamp, and clean shutdown state
- [x] automated health validator rejects malformed, stale, stopped, or otherwise invalid Node snapshots
- [x] optional connected-peer assertion for controlled cross-country tests
- [ ] stable public/community Konofix Node
- [ ] two PCs on independent networks in different countries
- [ ] CGNAT ↔ public Node ↔ CGNAT test
- [ ] TCP, QUIC, relay, and DCUtR verification
- [ ] fixes discovered during real-world network tests
- [ ] migrate remaining runtime strings from compatibility translation into typed message keys

### Test-release gate

A test release may be published only when:

- Windows CI is green,
- a production application bundle is created in CI,
- `konofix-node.exe` is created in CI,
- the test artifact contains the application, Node, and instructions,
- the release gate confirms version consistency,
- the project audit passes,
- the ZIP has a SHA-256 checksum,
- the finished ZIP passes `scripts/verify-release.ps1`,
- there is a real way to run a publicly reachable bootstrap Node.

## 0.5.0 — Rooms 2.0
- full room-member synchronization
- accurate per-room user count
- private rooms joined by invite link
- host leaves the application → room disappears
- per-room flood protection

## 0.6.0 — Private Chat
- direct P2P conversations
- dedicated tabs/windows
- E2E protection for private messages
- user blocking
- local ignored-Peer-ID list

## 0.7.0 — Safety / Anti-Spam
- rate limiting
- local reputation signals
- reporting and blocking
- nickname-flood protection
- limits for peer and room advertisements

## 0.8.0 — UX / Release
- automatic updates
- polished Windows installer
- signed builds
- optional autostart
- complete translation-key migration and language selector
- `#WORLD` load testing
- accessibility and keyboard-navigation pass

## 1.0.0 — Public Release
- stable global `#WORLD`
- community bootstrap pool
- production Windows release
- Node-operator documentation
- protocol frozen for the 1.x line

## Later
- Web client via WebRTC/WebTransport
- Android
- iOS/Linux
