# Konofix Chat — Roadmap

## Project progress

<img width="100%" src="assets/readme/progress-mini.svg" alt="Konofix Chat Real Internet Test compact progress — 54 of 59 verified tasks, 91.5%, in progress" />

**Verified checklist fraction: 54 of 59 tasks — 91.5%.** The generated mini card uses the exact checklist fraction; release readiness remains a separate evidence gate.

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
- [x] project audit prevents `npm ci`/npm-cache activation unless a real committed `package-lock.json` exists
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
- Coherent-session validation now also rejects cross-directory manifest substitution: all five supplied scenario manifests must resolve beside their `SESSION_INFO.json`, with an adversarial copied-manifest regression test. This hardening does not add Real Internet Test credit.
- [x] require every stable-promotion PASS check to carry concrete non-empty `check_evidence`, require both file-transfer PASS checks to include an explicit 64-character SHA-256 digest, and reject evidence-free/malformed observations in editor and CI self-tests
- Public Node promotion groundwork also includes a multi-snapshot soak validator and adversarial CI self-tests. Stable promotion requires a continuous health window with one Node version/source commit/Peer ID, no restart, bounded sample gaps, fresh final telemetry and observed peer activity, and the soak identity must match the bootstrap Peer ID in the cross-country evidence.
- Promotion-quality Node soak evidence is now exact-build-bound: the collector verifies the packaged `konofix-node.exe` against `BUILD_INFO.json` before stamping the Node and BUILD_INFO SHA-256 values into validated evidence copies, and the final artifact promotion preflight rejects missing, mixed or mismatched bindings. This provenance hardening does not add Real Internet Test credit.
- Local preflight mirrors the CI gate/test path instead of checking only the frontend and basic Cargo compilation, including deterministic `npm ci` against the committed frontend lockfile, `cargo fmt --check`, high-signal Clippy correctness/suspicious/performance gates, and `--locked` Rust resolution against the committed `src-tauri/Cargo.lock`.
- Local/Windows source-preflight parity is now machine-checked during `npm run audit`: required evidence/public-Node PowerShell self-tests and all locked Windows CI `cargo check` targets must also exist in `scripts/check.ps1`. The local path now includes dual-client public-Node Netprobe evidence self-tests and `konofix-netprobe`; production packaging/runtime-only stages remain CI/build responsibilities. This maintenance hardening does not add Real Internet Test credit.
- Windows desktop and isolated Linux Node/Netprobe builds now share one canonical source-commit provenance implementation in `src-tauri/build-shared.rs`. Linux CI fail-closes on manifest/target/source-bridge/provenance drift and shadow Linux implementations, while the desktop wrapper retains its Tauri build hook; the implementation head passed the complete Windows and Linux pipelines before documentation synchronization. This build-integrity hardening does not add Real Internet Test credit.
- Production Windows Node hardening executes the release-built `konofix-node.exe` before artifact publication, validates exact version/source-commit health telemetry, restarts it with the same persisted identity and requires an unchanged Peer ID. The same smoke tool can run from the staged test bundle and first verifies the packaged Node SHA-256 against `BUILD_INFO.json`; local incremental builds also watch the actual symbolic Git ref so a new commit cannot silently reuse stale embedded provenance.
- Exact-build transport smoke now also uses a separate `konofix-netprobe.exe` libp2p client against the restarted production Node over both TCP and QUIC-v1. PASS requires the expected Noise-authenticated Peer ID, `/konofix/4.0` Identify metadata, the expected `Konofix-Node/<version>` agent and a successful libp2p Ping; the probe binary is provenance-sealed in the Windows bundle. This is a runtime/build gate only and deliberately does not add a roadmap checklist credit until the same transports are proven across independent public networks.
- Linux CI now reuses that same Netprobe implementation through the isolated headless Cargo target, unit-tests and release-builds it without desktop dependencies, and requires authenticated TCP plus QUIC-v1 PASS evidence after the release Node restarts with the same persistent Peer ID. This remains a local runtime gate and does not change the 54/59 real-network count.
- Stable promotion now also requires one exact-build authenticated client Netprobe record from each independently identified Client A and Client B. Both records must prove direct TCP and QUIC-v1 against the same public Node identity and bind to the same test session, `BUILD_INFO.json`, source commit and sealed Netprobe bytes. Schema-2 capture now additionally includes session-scoped SHA-256 fingerprints derived locally from Windows MachineGuid and the active default-route-network context; raw host/network identifiers are not stored, and promotion rejects same-host or same-network A/B evidence. This anti-accidental-reuse hardening still does not credit the 54/59 milestone until genuine public-network evidence exists; Relay, DCUtR, CGNAT, application/file-transfer checks and Node soak remain separate real-world gates.
- Internet bootstrap precheck strictly validates TCP and QUIC-v1 multiaddr structure, address families, ports and Peer IDs, with adversarial CI self-tests before any real-network evidence is accepted.
- Bootstrap Peer ID validation now decodes base58btc and validates the libp2p multihash envelope used by Konofix (`identity` or `sha2-256`), rejecting malformed/truncated/unsupported/wrong-length identities before readiness, session or promotion evidence can treat them as a Node identity. Canonical identity and sha2-256 fixtures are exercised across the dependent self-tests; this hardening does not add Real Internet Test credit.
- Windows test archives carry the operational public-Node/bootstrap/readiness/evidence/health/soak/promotion scripts themselves, including the supervised startup-task installer, exact-build network-session bootstrap, session-consistency validator and production-Node runtime smoke, and artifact provenance verifies their hashes and sizes so remote testers can run the documented flow without cloning the source repository.
- Windows artifacts carry schema-v2 `BUILD_INFO.json` provenance with exact commit/version plus a complete SHA-256 and byte-size inventory of every staged regular file except the self-referential manifest. Release verification inspects ZIP entry paths and bounded archive-resource metadata before extraction, rejects traversal, duplicate/case-colliding file names, oversized archives/entries/expanded payloads and suspiciously high compression ratios, requires an exact no-missing/no-extra inventory, and adversarial CI re-hashes deliberately tampered archives—including a highly compressible decompression-bomb fixture—to prove that the outer checksum alone cannot bypass provenance or pre-extraction safety verification.
- Linux public-Node infrastructure now uses an isolated headless Cargo target that single-sources the production Node implementation, rejects desktop dependency leakage, reuses the committed Rust lockfile, and is validated by Linux CI without requiring Tauri/WebKit development libraries.
- Linux CI now exercises the release Node as a real process, verifies schema-v2 health provenance against the exact build commit, performs a clean stop/restart, and requires persistent Peer-ID continuity before the Linux path is considered build-valid.
- Linux systemd installation rejects privileged ports below 1024 because the service intentionally runs as the unprivileged `konofix` user; boundary behavior is covered by installer self-tests instead of depending on host-specific capabilities or sysctls.
- Raw Node state-file safety independently rejects identity/health/executable path collisions, stages health snapshots through unique create-new temporary files with durable writes and cleanup, and fails startup when an explicitly requested initial health snapshot cannot be published.
- Linux systemd installation canonicalizes state/install paths, rejects root or top-level directories, and rejects equal, nested, lexical-alias or symlink-alias layouts so writable identity/health state cannot overlap the staged Node executable.
- Linux release bundles are staged and integrity-verified on pull requests before merge; `NODE_BUILD_INFO.json` binds the exact expected archive inventory (Node, installer and operator documentation) to byte sizes and SHA-256 hashes plus source commit/version, while upload remains `main`-only.
- Linux public-Node systemd execution now uses empty capability sets, device/tmp/proc isolation, hostname/clock/kernel/control-group protections, namespace/realtime/personality/SUID restrictions, native-only syscall ABI, private keyring/IPC lifecycle and exactly one dedicated writable state path; mutation-free installer self-tests enforce the sandbox and write-boundary invariants.
- Public-Node readiness now fails closed when a literal bootstrap endpoint is private, CGNAT, loopback/link-local, documentation-only, benchmark/reserved/ORCHID or otherwise non-global; DNS endpoints must be public-looking FQDNs and, for readiness evidence, resolve only to globally routable addresses. Readiness schema v2 records the resolved-address evidence while still refusing to claim a QUIC handshake that was not actually performed.
- Windows and Linux public-Node deployment preflights now use the same fail-closed public-host boundary as promotion readiness: special/private-use DNS suffixes are rejected, and DNS evidence cannot pass with mixed public/non-public answers.
- The supervised Windows SYSTEM public-Node task now requires identity/health inside one protected state tree, rejects existing reparse-point storage during installation, applies protected SYSTEM+Administrators-only ACLs to the state/runtime tree, preflights ScheduledTasks/firewall capabilities before mutation, and safely stops/waits/restarts an already-running task during secured upgrades.
- File-transfer abuse resistance now bounds unanswered inbound offers per remote peer and expires stale pending offers, preventing one peer from indefinitely reserving all receiver slots; the desktop closes expired offer dialogs and reports expiry instead of exposing stale actions. This preserves the 54/59 real-network milestone count.
- Incoming file storage now reserves `.konofixpart` paths with exclusive create-new semantics and promotes verified data through same-directory no-clobber hard links after flush/sync, retrying same-name races without truncating or overwriting another process's files. Regression coverage exercises concurrent reservations, pre-existing partial sentinels, final-path races, bounded exhaustion and commit behavior. This local filesystem hardening does not add Real Internet Test credit.
- Received filenames are additionally bounded to 180 encoded UTF-8 bytes after sanitization and before collision/temp suffixes are added, preserving short extensions and preventing multi-byte remote names from exceeding common per-component filesystem limits. Regression coverage verifies UTF-8 boundaries and worst-case retry/temp suffix geometry; this local hardening does not add Real Internet Test credit and the milestone remains 54/59.
- Accepted incoming file transfers now have a 120-second inactivity lease that advances only after a successfully written non-empty chunk; abandoned senders can no longer retain all receive slots indefinitely, zero-byte keepalive chunks are rejected, and the final connection close for a remote Peer ID immediately clears that peer's unanswered offers and accepted receive state while deleting only transfer-owned `.konofixpart` files. TTL-boundary regression coverage is included and the Real Internet Test milestone stays 54/59.
- Outgoing file transfers now converge immediately when the final connection to their authenticated remote Peer ID closes: only that peer's sender-side transfer slots are reclaimed, matching outbound request metadata is pruned so late responses are ignored, and unrelated peer/request state remains untouched. Adversarial liveness coverage guards the final-connection and peer-ownership boundaries; this local resilience hardening does not add Real Internet Test credit and the milestone remains 54/59.
- Fatal desktop network-task exits now release only the session sender owned by that exact Tokio channel, stale task exits cannot clear a newer reconnect, overlapping starts are rejected atomically, explicit disconnect remains idempotent, and terminal frontend recovery clears stale peer/room/message/transfer state before returning to login. Rust regression tests, adversarial audit mutations and dedicated lifecycle documentation cover the behavior; this resilience hardening does not add Real Internet Test credit and the milestone remains 54/59.
- All desktop network-task returns now converge owned backend session state, including clean exits such as nickname-conflict shutdowns; cleanup runs before error-only reporting, preserves exact-channel stale-task protection and idempotent explicit disconnect, and is guarded by Rust plus adversarial audit regression coverage. This lifecycle resilience work does not add Real Internet Test credit and the milestone remains 54/59.
- Bootstrap settings now persist a connected-session bootstrap only after the live `add_bootstrap` backend accepts it; rejected addresses leave the stored configuration untouched, offline staging remains available, and fail-closed audit plus adversarial mutation tests guard the validation-before-save ordering. This UX/config-consistency hardening does not add Real Internet Test credit and the milestone remains 54/59.
- Authenticated GossipSub input is now schema-bounded after signature/source verification: malformed nickname, chat and room events (including attempts to mutate reserved `world`) are rejected before they can alter UI/network state.
- Repository supply-chain maintenance now has scheduled Dependabot coverage for npm, Cargo and GitHub Actions plus a private-disclosure security policy; these maintenance controls do not add Real Internet Test credit.
- Rust dependency security now also has a dedicated read-only scheduled RustSec `cargo-audit` gate over the committed `Cargo.lock`, pinned to reviewed cargo-audit 0.22.2 and Rust 1.88.0 and protected by a fail-closed vulnerable fixture plus adversarial workflow-policy tests integrated into `npm run audit`. This supply-chain hardening does not add Real Internet Test credit.
- Rust toolchain maintenance now uses `dirs` 7.0.0 in both the desktop and isolated Linux Node manifests after full platform CI verification; this does not change the 54/59 real-network count.
- Frontend toolchain maintenance now runs TypeScript 7.0.2 with explicit Vite client ambient types and a project-audit guard for CSS/asset side-effect imports; the verified compatibility migration does not change the 54/59 real-network count.
- Frontend bundling now uses Vite 8.3.0 after full Windows and Linux PR verification; this maintenance update does not change the 54/59 real-network count.
- [ ] stable public/community Konofix Node
- [ ] two PCs on independent networks in different countries
- [ ] CGNAT ↔ public Node ↔ CGNAT test
- [ ] TCP, QUIC, relay, and DCUtR verification
- [ ] fixes discovered during real-world network tests

### Test-release gate

The existing `v0.4.2-test1` pre-release is a controlled preview for gathering real-network evidence, not proof that the public-network milestone has passed. No later release should be published automatically from an ordinary push. A new release may be published only when Windows CI is green, production application and Node bundles exist, version/project audits pass, the ZIP and SHA-256 pass verification, instructions are included, and there is a real publicly reachable bootstrap path. Pull requests to `main` must already reproduce the production application/Node build and pass staged archive verification before merge; the production Windows Node runtime smoke must also prove exact-build health telemetry, persistent Peer-ID continuity and authenticated TCP + QUIC-v1 libp2p handshakes through the separately built Netprobe, while artifact upload remains a post-merge `main` action. The local/CI Netprobe results are explicitly not substitutes for independent-country public-network evidence. Promotion beyond the test release additionally requires fresh schema-v3 machine-readable PASS evidence for the required real-network scenarios from the exact release client and Node version and exact source commit, with independent countries and networks/operators recorded and one stable public bootstrap Peer ID across the promotion evidence. Those five manifests must also remain bound to the single `SESSION_INFO.json` that created them: stable promotion rejects cross-directory manifest substitution, mixed endpoint pairs, changed country/network metadata, a different exact build/source commit, or bootstrap addresses outside the paired TCP/QUIC session identity. Stable promotion also requires one schema-2 Client A and one schema-2 Client B Netprobe record whose session-scoped host and default-route network fingerprints differ; raw MachineGuid/network context is hashed locally and is not stored in the evidence bundle. A PASS value alone is insufficient: every PASS check used for stable promotion must carry a concrete non-empty `check_evidence` note, and both file-transfer SHA-256 checks must contain the observed full 64-character digest. Stable promotion also requires a continuous Node soak history; the release gate binds that history to the same bootstrap Peer ID, Node version and exact source commit used by the network manifests and rejects restarts, stale samples and monitoring gaps. Public/community Node operators can pin identity storage explicitly, malformed existing identities fail startup rather than silently rotating the Peer ID, and the bundled deployment preflights reject non-public/special-use endpoints and unsafe state-path collisions before launch. The bundled Windows startup-task installer stages the Node/launcher into a dedicated protected state tree, requires identity/health to remain inside it, rejects existing reparse-point storage at install time, applies protected SYSTEM+Administrators-only ACLs, runs the Node as SYSTEM at boot with restart policy, and optionally creates only the scoped TCP/UDP firewall rules needed for the configured port; uninstall preserves identity/state. The readiness validator additionally requires TCP and QUIC bootstrap addresses to describe the same host, port and Peer ID and binds them to a fresh health snapshot; it rejects non-globally-routable endpoints before readiness can pass, requires DNS evidence to resolve only to public addresses, and its TCP socket probe is a reachability check only, so QUIC success still requires the real libp2p transport scenario. Signed GossipSub events are accepted only when their payload identity matches the authenticated libp2p source, and file-transfer control state is rejected when it is not owned by the requesting peer. The verified Windows artifact includes a fail-closed Node soak collector that validates exact captured bytes before accepting them as evidence, deduplicates unchanged snapshots and refuses conflicting samples with the same timestamp. Promotion-quality collected copies are additionally sealed to that artifact's verified Node and `BUILD_INFO.json` SHA-256 values, and the final artifact promotion preflight requires those hashes to match before PASS, preventing accidental same-version/same-source build substitution. It also includes a schema-v3 report editor so testers do not need to keep JSON and Markdown synchronized by hand; the editor refuses PASS/FAIL without an evidence note and refuses file PASS results without the full SHA-256 digest. The exact-build session bootstrap verifies the packaged Node against `BUILD_INFO.json`, rejects mismatched TCP/QUIC bootstrap identity and non-independent endpoint metadata, then stages the complete five-scenario PENDING workspace and moves it into place only after successful creation. The bundled `check-promotion-evidence.ps1` ties verified artifact provenance, that coherent session, the evidence-rich transport/NAT manifest set, dual-client host/network separation and the exact-build-bound public-Node soak history together and emits PASS only when version, source commit, endpoint metadata, evidence quality, bootstrap identity and Node/BUILD_INFO hashes all match. Network evidence validation rejects oversized manifests before parsing and requires genuine JSON integer/string types plus canonical scenario/result casing, preventing PowerShell coercion from turning malformed evidence into trusted promotion input. Windows CI embeds schema-v2 `BUILD_INFO.json` in each test archive and verifies that its exact complete staged-file inventory, commit/version, Node/Netprobe/installer/test-tool/frontend-lock/Rust-lock provenance and every recorded SHA-256/byte size match the packaged files before upload; ZIP entry paths and pre-extraction resource budgets are validated before extraction, so traversal, duplicate/case-colliding names, oversized expansion and high-ratio decompression bombs fail before the archive is expanded. Before the ZIP is produced, the staged runtime smoke verifies the packaged Node and Netprobe hashes from that metadata and executes the exact staged Node binary twice with one temporary persistent identity before probing both direct transports. The Node and Netprobe embed the build source commit, while real-network manifests use schema v3, preventing evidence gathered from one `0.4.2` commit from promoting a different `0.4.2` build. Frontend dependency resolution is deterministic through the committed `package-lock.json` and `npm ci`. Rust dependency resolution is likewise pinned by committed `src-tauri/Cargo.lock`; CI and local/build helpers validate or build with `--locked`, CI/local preflight also enforce `cargo fmt --check`, and release verification requires the packaged Cargo lockfile to match that committed build input. GitHub Actions are pinned to full commit SHAs and checkout credentials are not persisted.

## 0.5.0 — Rooms 2.0
- full room-member synchronization
- accurate per-room user count