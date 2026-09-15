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
- added strict `scripts/check-node-health.ps1` validation, including stale/future timestamps, stopped state, malformed data, invalid peer counts and optional `-RequirePeer`,
- added `scripts/new-network-test-report.ps1` to create consistent evidence-oriented Markdown reports for LAN, TCP, QUIC, Relay, DCUtR and CGNAT tests,
- extended network-test reports with version metadata and a machine-readable JSON manifest designed for automated release gating,
- added `scripts/validate-network-test-report.ps1` to reject malformed, incomplete, mixed-version or non-PASS network evidence and require the configured real-network scenarios,
- upgraded network evidence to schema v2 with explicit country and network/operator identity for both endpoints; Internet tests must prove different countries and independent networks,
- hardened the evidence gate with freshness/future-time validation, mandatory core PASS checks, and scenario-specific Relay/DCUtR/CGNAT assertions so an `overall=PASS` flag alone cannot authorize promotion,
- expanded the cross-country testing guide with Node health validation and reproducible PASS/FAIL reporting,
- updated the roadmap for real Internet testing and typed localization-key migration.

## 0.4.1

- rebranded the project as **Konofix Chat**,
- added **by Swir** attribution in the UI,
- added an active link to `https://github.com/Swir/Konofix`,
- changed the protocol namespace to `konofix`,
- changed temporary transfer files to `.konofixpart`,
