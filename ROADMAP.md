# Konofix Chat — Roadmap

## Project progress

**Real Internet Test milestone: 92% complete**

`██████████████████░░ 92%`

The active milestone currently has 54 of 59 tasks complete. The remaining five tasks require real public-network evidence and fixes discovered during those tests; CI alone cannot credit them.

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
- [x] stable-promotion release gate wired directly to schema-v3 real-network evidence validation
- [x] promotion evidence bound to the exact target client/Node version and one stable public bootstrap Peer ID
- [x] CI self-tests for positive evidence plus wrong versions, same-country/network, stale/future evidence, incomplete checks and mixed bootstrap Peer IDs
- [x] README progress bar derived from the active roadmap milestone and checked by CI
- [x] release gate invokes the PowerShell network-evidence validator deterministically
- [x] Windows CI cancels superseded runs per branch/ref
- [x] Windows build/test job uses a read-only GitHub token
- [x] project audit prevents `npm ci`/npm-cache activation unless a real committed frontend lockfile exists
- [x] automatic GitHub Release publication removed from ordinary pushes; release publication remains gated by real public-network readiness
- [x] dependency audit derives lockfile state from Git tracking, and no-lockfile CI suppresses transient `package-lock.json` generation
- [x] GitHub Actions are pinned to immutable commit SHAs, checkout credentials are not persisted, and CI audit rejects floating action refs
- [x] migrate remaining runtime strings from compatibility translation into typed message keys; remove the DOM/source-text translator and enforce the migration in project audit
- [x] promotion evidence, Node health and soak history are bound to the exact source commit carried by Windows artifact provenance
- [x] commit the CI-generated frontend lockfile, enforce `npm ci` plus lockfile-keyed caching, validate manifest/lock agreement, and bind the exact lockfile hash into Windows artifact provenance
- [x] harden persistent public Node identity with an explicit `--identity-file`, fail-closed corrupted-key handling, race-safe create-new semantics and Rust regression tests
- [x] run production Windows app/Node builds, bundle staging, ZIP/SHA-256 generation and release-artifact verification on pull requests before merge
- [x] add a fail-closed public Node deployment preflight/launcher with special-use address rejection, persistent identity/health separation, adversarial CI self-tests and inclusion in verified Windows artifacts
- [x] add a supervised Windows startup-task installer for long-lived public Nodes, with persistent runtime staging, SYSTEM startup, restart policy, optional scoped firewall rules, mutation-free CI self-tests and inclusion in verified Windows artifacts
- [x] commit the Rust dependency graph recovered from a verified green Windows artifact, enforce `Cargo.lock` with `--locked` across CI/local/build helpers, and require packaged Rust provenance to match the committed build input
- [x] add a combined public Node readiness validator that binds TCP and QUIC bootstraps to one host/port/Peer ID plus exact health/version/source-commit state, with adversarial CI coverage and no false QUIC-handshake claim
- [x] bind signed GossipSub presence/chat/room/nickname payload identities to the authenticated libp2p source and bind file-transfer offer/completion/cancel state to the requesting peer, with malformed/duplicate transfer-ID and digest rejection
- [x] add a validated public-Node soak collector with retry-safe snapshot capture, duplicate suppression, same-timestamp conflict rejection, CI/local self-tests and inclusion in verified Windows artifacts
- [x] add a schema-v3 network report editor that stores per-check evidence, protects prior results from accidental overwrite, recomputes outcome, regenerates Markdown and validates scenarios before finalization
- [x] make schema-v3 network evidence fail closed on JSON type coercion/non-canonical result casing and bound manifest size before parsing, with adversarial CI coverage
- [x] add a bundled exact-build promotion-evidence preflight that joins verified `BUILD_INFO.json`, all required schema-v3 network manifests and the matching Node-soak history into one fail-closed PASS check, with positive and adversarial CI tests
- [x] add an atomic exact-build network-test-session bootstrap that verifies `BUILD_INFO.json`, packaged Node bytes and paired TCP/QUIC identity before creating all five PENDING promotion manifests, with adversarial CI tests and Windows-artifact inclusion
- [x] require stable promotion evidence to stay inside one coherent test session, binding all five scenarios to the same endpoint pair, countries/networks, exact build/source commit and paired TCP/QUIC bootstrap identity, with adversarial CI coverage
- [x] require every stable-promotion PASS check to carry concrete non-empty `check_evidence`, require both file-transfer PASS checks to include an explicit 64-character SHA-256 digest, and reject evidence-free/malformed observations in editor and CI self-tests
- Public Node promotion groundwork also includes a multi-snapshot soak validator and adversarial CI self-tests. Stable promotion requires a continuous health window with one Node version/source commit/Peer ID, no restart, bounded sample gaps, fresh final telemetry and observed peer activity, and the soak identity must match the bootstrap Peer ID in the cross-country evidence.
- Local preflight mirrors the CI gate/test path instead of checking only the frontend and basic Cargo compilation, including deterministic `npm ci` against the committed frontend lockfile, `cargo fmt --check`, high-signal Clippy correctness/suspicious/performance gates, and `--locked` Rust resolution against the committed `src-tauri/Cargo.lock`.
- Production Windows Node hardening executes the release-built `konofix-node.exe` before artifact publication, validates exact version/source-commit health telemetry, restarts it with the same persisted identity and requires an unchanged Peer ID. The same smoke tool can run from the staged test bundle and first verifies the packaged Node SHA-256 against `BUILD_INFO.json`; local incremental builds also watch the actual symbolic Git ref so a new commit cannot silently reuse stale embedded provenance.
- Internet bootstrap precheck strictly validates TCP and QUIC-v1 multiaddr structure, address families, ports and Peer IDs, with adversarial CI self-tests before any real-network evidence is accepted.
- Windows test archives carry the operational public-Node/bootstrap/readiness/evidence/health/soak/promotion scripts themselves, including the supervised startup-task installer, exact-build network-session bootstrap, session-consistency validator and production-Node runtime smoke, and artifact provenance verifies their hashes and sizes so remote testers can run the documented flow without cloning the source repository.
- Windows artifacts carry machine-readable `BUILD_INFO.json` provenance with commit/version plus hashes and sizes for the Node, committed frontend and Rust lockfiles, test tools and every installer; artifact verification cross-checks that metadata and both committed dependency inputs before upload.
- Linux public-Node infrastructure now uses an isolated headless Cargo target that single-sources the production Node implementation, rejects desktop dependency leakage, reuses the committed Rust lockfile, and is validated by Linux CI without requiring Tauri/WebKit development libraries.
- Linux CI now exercises the release Node as a real process, verifies schema-v2 health provenance against the exact build commit, performs a clean stop/restart, and requires persistent Peer-ID continuity before the Linux path is considered build-valid.
- Linux systemd installation rejects privileged ports below 1024 because the service intentionally runs as the unprivileged `konofix` user; boundary behavior is covered by installer self-tests instead of depending on host-specific capabilities or sysctls.
- Raw Node state-file safety independently rejects identity/health/executable path collisions, stages health snapshots through unique create-new temporary files with durable writes and cleanup, and fails startup when an explicitly requested initial health snapshot cannot be published.
- [ ] stable public/community Konofix Node
- [ ] two PCs on independent networks in different countries
- [ ] CGNAT ↔ public Node ↔ CGNAT test
- [ ] TCP, QUIC, relay, and DCUtR verification
- [ ] fixes discovered during real-world network tests

### Test-release gate

The existing `v0.4.2-test1` pre-release is a controlled preview for gathering real-network evidence, not proof that the public-network milestone has passed. No later release should be published automatically from an ordinary push. A new release may be published only when Windows CI is green, production application and Node bundles exist, version/project audits pass, the ZIP and SHA-256 pass verification, instructions are included, and there is a real publicly reachable bootstrap path. Pull requests to `main` must already reproduce the production application/Node build and pass staged archive verification before merge; the production Windows Node runtime smoke must also prove exact-build health telemetry and persistent Peer-ID continuity, while artifact upload remains a post-merge `main` action. Promotion beyond the test release additionally requires fresh schema-v3 machine-readable PASS evidence for the required real-network scenarios from the exact release client and Node version and exact source commit, with independent countries and networks/operators recorded and one stable public bootstrap Peer ID across the promotion evidence. Those five manifests must also remain bound to the single `SESSION_INFO.json` that created them: stable promotion rejects mixed endpoint pairs, changed country/network metadata, a different exact build/source commit, or bootstrap addresses outside the paired TCP/QUIC session identity. A PASS value alone is insufficient: every PASS check used for stable promotion must carry a concrete non-empty `check_evidence` note, and both file-transfer SHA-256 checks must contain the observed full 64-character digest. Stable promotion also requires a continuous Node soak history; the release gate binds that history to the same bootstrap Peer ID, Node version and exact source commit used by the network manifests and rejects restarts, stale samples and monitoring gaps. Public/community Node operators can pin identity storage explicitly, malformed existing identities fail startup rather than silently rotating the Peer ID, and the bundled deployment preflight rejects obviously non-public addresses and unsafe state-path collisions before launch. The bundled Windows startup-task installer can stage the Node/launcher into persistent state, run it as SYSTEM at boot with restart policy, and optionally create only the scoped TCP/UDP firewall rules needed for the configured port; uninstall preserves identity/state. The readiness validator additionally requires TCP and QUIC bootstrap addresses to describe the same host, port and Peer ID and binds them to a fresh health snapshot; its TCP socket probe is a reachability check only, and QUIC success still requires the real libp2p transport scenario. Signed GossipSub events are accepted only when their payload identity matches the authenticated libp2p source, and file-transfer control state is rejected when it is not owned by the requesting peer. The verified Windows artifact includes a fail-closed Node soak collector that validates exact captured bytes before accepting them as evidence, deduplicates unchanged snapshots and refuses conflicting samples with the same timestamp. It also includes a schema-v3 report editor so testers do not need to keep JSON and Markdown synchronized by hand; the editor refuses PASS/FAIL without an evidence note and refuses file PASS results without the full SHA-256 digest. The exact-build session bootstrap verifies the packaged Node against `BUILD_INFO.json`, rejects mismatched TCP/QUIC bootstrap identity and non-independent endpoint metadata, then stages the complete five-scenario PENDING workspace and moves it into place only after successful creation. The bundled `check-promotion-evidence.ps1` ties verified artifact provenance, that coherent session, the evidence-rich transport/NAT manifest set and the public-Node soak history together and emits PASS only when version, source commit, endpoint metadata, evidence quality and bootstrap identity all match. Network evidence validation rejects oversized manifests before parsing and requires genuine JSON integer/string types plus canonical scenario/result casing, preventing PowerShell coercion from turning malformed evidence into trusted promotion input. Windows CI embeds `BUILD_INFO.json` in each test archive and verifies that its commit/version plus Node/installer/test-tool/frontend-lock/Rust-lock hashes and sizes match the packaged files before upload. Before the ZIP is produced, the staged runtime smoke verifies the packaged Node hash from that metadata and executes the exact staged binary twice with one temporary persistent identity. The Node embeds the build source commit into schema-v2 health snapshots, while real-network manifests use schema v3, preventing evidence gathered from one `0.4.2` commit from promoting a different `0.4.2` build. Frontend dependency resolution is deterministic through the committed `package-lock.json` and `npm ci`. Rust dependency resolution is likewise pinned by committed `src-tauri/Cargo.lock`; CI and local/build helpers validate or build with `--locked`, CI/local preflight also enforce `cargo fmt --check`, and release verification requires the packaged Cargo lockfile to match that committed build input. GitHub Actions are pinned to full commit SHAs and checkout credentials are not persisted.

## 0.5.0 — Rooms 2.0
- full room-member synchronization
- accurate per-room user count
