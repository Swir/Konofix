# Changelog

## 0.4.2

- restored Windows CI, Tauri packaging, production application and `konofix-node.exe` builds,
- added public-host bootstrap generation, Node launcher and strict bootstrap prechecks,
- added release gating, packaged artifact verification, ZIP + SHA-256 generation and the first `v0.4.2-test1` pre-release,
- added automatic operating-system locale detection with English fallback,
- added the first multilingual UI compatibility layer for English, Polish, Norwegian, German, French, Spanish, and Ukrainian,
- switched repository-facing documentation and operational tooling to English-only and added CI auditing for that policy,
- documented localization architecture and typed-key migration,
- added public Node status telemetry, public-host validation warnings and dual-stack-friendly `/dns/...` bootstrap generation,
- added privacy-safe JSON Node health snapshots with atomic replacement and clean-shutdown state,
- added strict `scripts/check-node-health.ps1` validation and adversarial CI coverage,
- hardened Node health validation with version/Peer ID pinning, uptime, quorum, freshness, clock-skew and bounded snapshot-size gates,
- require Node-health numeric fields to be genuine JSON integers and textual fields to be genuine non-empty JSON strings,
- use ordinal case-sensitive status/version/Peer ID comparisons and fail closed on explicitly empty identity pins,
- added reproducible Markdown + JSON real-network evidence generation and schema-v2 promotion validation for TCP/QUIC/Relay/DCUtR/CGNAT,
- bound stable-promotion evidence to exact client/Node versions and one stable public bootstrap Peer ID,
- added adversarial network-evidence CI self-tests and wired stable promotion directly to validated real-network evidence,
- added a roadmap-backed README progress bar checked by CI,
- configured per-ref Windows CI concurrency with superseded-run cancellation,
- reduced GitHub Actions token exposure by isolating `contents: write` to the post-build release-publication job,
- attempted lockfile-enforced npm CI, detected that the repository does not yet contain `package-lock.json`, and restored the green-compatible install path instead of leaving Windows CI permanently blocked; deterministic npm installs remain pending until a lockfile is committed,
- expanded cross-country testing documentation and release-gate guidance.

## 0.4.1

- rebranded the project as **Konofix Chat**,
- added **by Swir** attribution in the UI,
- added an active link to `https://github.com/Swir/Konofix`,
- changed the protocol namespace to `konofix`,
- changed temporary transfer files to `.konofixpart`.
