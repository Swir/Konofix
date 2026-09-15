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
- [x] Windows/Tauri packaging and production app/Node build pipeline
- [x] `Konofix Node --public-host` ready TCP/QUIC bootstrap addresses
- [x] public Node launcher, multiaddr precheck, release gate, ZIP/SHA-256 and artifact verification
- [x] first `v0.4.2-test1` cross-country pre-release
- [x] system-language detection with English fallback
- [x] English, Polish, Norwegian, German, French, Spanish, Ukrainian localization layer
- [x] English-only repository documentation and operational tooling policy with CI audit
- [x] public Node telemetry, dual-stack-friendly DNS bootstrap generation, and health snapshots
- [x] automated Node health validation with optional connected-peer assertion
- [x] reproducible Markdown + JSON test evidence generator for LAN/TCP/QUIC/Relay/DCUtR/CGNAT scenarios
- [x] automated network-evidence gate validating PASS manifests, required scenarios and consistent client/Node versions
- [x] strict evidence schema requiring fresh results and independently identified countries/networks for Internet scenarios
- [x] scenario-aware evidence checks for Relay, DCUtR and CGNAT instead of accepting an overall PASS alone
- [ ] stable public/community Konofix Node
- [ ] two PCs on independent networks in different countries
- [ ] CGNAT ↔ public Node ↔ CGNAT test
- [ ] TCP, QUIC, relay, and DCUtR verification
- [ ] fixes discovered during real-world network tests
- [ ] migrate remaining runtime strings from compatibility translation into typed message keys

### Test-release gate

A test release may be published only when Windows CI is green, production application and Node bundles exist, version/project audits pass, the ZIP and SHA-256 pass verification, instructions are included, and there is a real publicly reachable bootstrap path. Promotion beyond the test release additionally requires fresh schema-v2 machine-readable PASS evidence for the required real-network scenarios from one consistent client and Node build, with independent countries and networks/operators recorded.

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
