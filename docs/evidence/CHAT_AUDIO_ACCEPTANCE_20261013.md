# Owner-reported private audio acceptance — 2026-10-13

## Accepted candidate

- Application version embedded in the installer: `0.6.0-5`.
- PR: [#197](https://github.com/Swir/Konofix/pull/197).
- PR head: `1716e8d44052ca3b99ac515ab712dbfd831eb29e`.
- Actual CI build source / synthetic PR merge: `fde52e572e029e6e5691df8aea197dc1eaf083fe`.
- Build parents: main `0e735d057a6cdc0012000162d6c471ebe8e48761` and the PR head above.
- Windows workflow: [38415180641](https://github.com/Swir/Konofix/actions/runs/38415180641), SUCCESS.
- Linux workflow: `38415181157`, SUCCESS; RustSec workflow: `38415180632`, SUCCESS.
- Windows artifact ID: `11826830657`.
- Original installer: `Konofix Chat_0.6.0-5_x64-setup.exe`.
- Local delivery copy: `Konofix-Chat-audio-fix-1716e8d-setup.exe`; verified identical bytes.
- Installer size: `10265777` bytes.
- Installer SHA-256: `12e91c5ec9097d7cdce249c0a48bb5c5c7734c7cb025887874c5aacef1d42f65`.
- Authenticode: not signed. All 40 sealed bundle inventory entries and the release ZIP checksum were verified after download.

## User report and publication request

In the continuing two-PC support session, the project owner was asked specifically whether the latest `audio-fix-1716e8d` installer had been tested, whether private voice was audible on both PCs, and whether the post-hangup error no longer returned. The owner explicitly answered yes: tested and working, and requested publication as stable with updated feature documentation.

This is **USER-REPORTED PASS for bidirectional private voice and absence of the reported post-hangup error**, plus owner approval to prepare a stable chat release. It is not an independently instrumented audio measurement. In the preceding support report, the owner had separately confirmed audible WORLD voice while private voice was still failing; that earlier statement is not silently relabeled as a fresh test of every feature in this candidate.

## Evidence boundary

No new network topology, country pair, NAT classification, selected ICE candidate, file-size/hash observation, 60-second timing trace, room-voice participant count, large-scale load or soak record accompanies this confirmation. Do not infer any of those results. Earlier positive text/file reports remain historical, not exact-build retests of every mode.

The 0.6.0 stable installer must be rebuilt with stable version metadata and validated by CI. It will have a different source commit and checksum; the accepted alpha bytes above must never be presented as the new stable binary. Release assets and `BUILD_INFO.json` identify that new build. The application behavior is carried forward, with version metadata, release tooling and documentation changes distinguished from the tested candidate.

The independent Global Beta evidence scope remains **56/67 (83.6%)**. This record grants no load, public-Node, cross-country transport, failover or continuous-soak checklist credit.
