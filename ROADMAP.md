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
- [x] CI self-tests for valid, malformed, stale/future, stopped and peerless Node health snapshots
- [x] Node-health CI harness made deterministic by validating PowerShell exceptions instead of inherited native-process exit codes
- [x] Node-health validation bound optionally to the expected release version and stable public Node Peer ID, with adversarial CI coverage
- [x] Node-health stability window can require a minimum continuous uptime before infrastructure is accepted for release testing
- [x] Node-health gate can require a configurable minimum connected-peer quorum, with adversarial CI coverage
- [x] Node-health freshness policy has bounded stale/future windows and rejects non-positive timestamps, with adversarial CI coverage
- [x] Node-health telemetry consistency rejects uptime values that are impossible for the snapshot timestamp, with adversarial CI coverage
- [x] Node-health snapshots are size-bounded before JSON parsing, with configurable 1 KiB–1 MiB limits and adversarial CI coverage
- [x] Node-health numeric fields require real JSON integers; strings, booleans and fractional values cannot be coerced into trusted telemetry
- [x] Node-health textual fields require real non-empty JSON strings; numbers and booleans cannot be coerced into status, version or Peer ID
- [x] Node-health status and pinned identity comparisons use ordinal case-sensitive matching
- [x] explicitly supplied Node version/Peer ID pins fail closed when empty or whitespace
- [x] reproducible Markdown + JSON test evidence generator for LAN/TCP/QUIC/Relay/DCUtR/CGNAT scenarios
- [x] automated network-evidence gate validating PASS manifests, required scenarios and consistent client/Node versions
- [x] strict evidence schema requiring fresh results and independently identified countries/networks for Internet scenarios
- [x] scenario-aware evidence checks for Relay, DCUtR and CGNAT instead of accepting an overall PASS alone
- [x] stable-promotion release gate wired directly to schema-v2 real-network evidence validation
- [x] promotion evidence bound to the exact target client/Node version and one stable public bootstrap Peer ID
- [x] CI self-tests for positive evidence plus wrong versions, same-country/network, stale/future evidence, incomplete checks and mixed bootstrap Peer IDs
- [x] README progress bar derived from the active roadmap milestone and checked by CI
- [x] release gate invokes the PowerShell network-evidence validator deterministically
- [x] Windows CI cancels superseded runs per branch/ref
- [x] Windows build/test job uses a read-only GitHub token
- [x] project audit prevents `npm ci`/npm-cache activation unless a real committed frontend lockfile exists
- [x] automatic GitHub Release publication removed from ordinary pushes; release publication remains gated by real public-network readiness
- [ ] stable public/community Konofix Node
- [ ] two PCs on independent networks in different countries
- [ ] CGNAT ↔ public Node ↔ CGNAT test
- [ ] TCP, QUIC, relay, and DCUtR verification
- [ ] fixes discovered during real-world network tests
- [ ] migrate remaining runtime strings from compatibility translation into typed message keys

### Test-release gate

The existing `v0.4.2-test1` pre-release is a controlled preview for gathering real-network evidence, not proof that the public-network milestone has passed. No later release should be published automatically from an ordinary push. A new release may be published only when Windows CI is green, production application and Node bundles exist, version/project audits pass, the ZIP and SHA-256 pass verification, instructions are included, and there is a real publicly reachable bootstrap path. Promotion beyond the test release additionally requires fresh schema-v2 machine-readable PASS evidence for the required real-network scenarios from the exact release client and Node version, with independent countries and networks/operators recorded and one stable public bootstrap Peer ID across the promotion evidence. The repository currently has no committed `package-lock.json`; Windows CI therefore uses `npm install --no-audit --no-fund` without setup-node npm caching, while the project audit prevents accidental activation of lockfile-only CI behavior.

## 0.5.0 — Rooms 2.0
- full room-member synchronization
- accurate per-room user count
