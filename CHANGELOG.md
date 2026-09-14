# Changelog

## 0.4.2

- restored a valid `tsconfig.json` and fixed Windows CI,
- removed the emergency source-bootstrap path from the repository,
- added the required Windows icon at `src-tauri/icons/icon.ico` for Tauri packaging,
- added `Konofix Node --public-host` / `--public-ip`,
- Node now prints ready-to-use TCP and QUIC bootstrap multiaddresses containing its Peer ID,
- `run-node.bat` asks for a public IP/DNS name and starts the Node without manual command construction,
- `internet-test.ps1` validates host, port, and Peer ID presence in a bootstrap multiaddr,
- Windows CI now builds the production application and `konofix-node.exe`,
- CI creates a ready Windows test package and stores it as a GitHub Actions artifact,
- the test package contains the application/bundle, Node, README, testing guide, and Node operator guide,
- expanded the test plan with cross-country TCP, QUIC, relay, DCUtR, and CGNAT ↔ Node ↔ CGNAT scenarios,
- added `scripts/release-gate.ps1` to block releases on version mismatch or missing required files,
- CI creates a test-release ZIP plus SHA-256 checksum,
- published the first `v0.4.2-test1` pre-release with the Windows bundle, SHA-256 checksum, and `konofix-node.exe`,
- added `scripts/verify-release.ps1` to verify SHA-256, ZIP integrity, required files, Node binary size, and Windows installer presence before publication,
- release publication now occurs only after the finished release artifact passes verification,
- added automatic operating-system locale detection with English fallback,
- added the first multilingual UI compatibility layer for English, Polish, Norwegian, German, French, Spanish, and Ukrainian,
- changed top-level repository documentation to English-only and documented English as the canonical development/release language,
- added `scripts/project-audit.mjs` and `npm run audit` to verify package/Tauri/Cargo version consistency, English fallback, and English-only repository documentation/workflow text,
- Windows CI now runs the project audit before the TypeScript/Vite build,
- added `docs/LOCALIZATION.md` with localization rules, supported languages, fallback behavior, and the typed-key migration plan,
- the project audit reports the remaining Polish-specific characters in `src/main.ts` as a runtime localization migration indicator,
- updated the roadmap for real Internet testing and typed localization-key migration.

## 0.4.1

- rebranded the project as **Konofix Chat**,
- added **by Swir** attribution in the UI,
- added an active link to `https://github.com/Swir/Konofix`,
- changed the protocol namespace to `konofix`,
- changed temporary transfer files to `.konofixpart`,
- added Windows CI and `scripts/internet-test.ps1`,
- prepared the project for real Internet ↔ Node ↔ Internet testing.

## 0.4.0

- added a Circuit Relay server to the client,
- added automatic relay-listener attempts through bootstrap peers,
- added a persistent cache of peer addresses,
- the application now attempts to reconnect to known peers during startup,
- added a standalone `konofix-node` with Kademlia DHT, AutoNAT, Circuit Relay, and GossipSub,
- Node persists its Peer ID in a local identity file,
- added `build-node.bat` and `run-node.bat`,
- expanded project checks and the Windows build scripts,
- the GUI now shows relay state in the network panel,
- updated architecture and roadmap documentation.

## 0.3.0

- P2P file transfer,
- Accept / Reject flow,
- 256 KiB chunks,
- SHA-256 verification,
- `.konofixpart` temporary files,
- progress indicator and cancellation.
