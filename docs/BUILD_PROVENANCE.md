# Build provenance

Konofix embeds one exact source revision into the Rust binaries used by the Windows desktop build, Konofix Node and Konofix Netprobe. The embedded value is exposed to the Node/Netprobe evidence paths as `KONOFIX_SOURCE_COMMIT` and is part of the exact-build release/testing model.

## Canonical implementation

The Git/source revision discovery logic is single-sourced in:

- `src-tauri/build-shared.rs`

Both Rust build-script entry points include that implementation:

- `src-tauri/build.rs` — desktop/Windows build entry point. It invokes the shared provenance setup and then the Tauri desktop build hook on Windows.
- `node-linux/build.rs` — isolated headless Linux Node/Netprobe build entry point. It invokes only the shared provenance setup and does not introduce Tauri/GUI dependencies.

The shared implementation prefers a valid 40-character `GITHUB_SHA` supplied by CI. Outside GitHub Actions it falls back to `git rev-parse HEAD`; if neither source is available, the embedded value is `unknown`. The build script also watches the relevant Git ref paths so local incremental Cargo builds do not silently retain provenance from an older commit after the repository HEAD changes.

## Fail-closed parity gate

Linux Node CI runs `scripts/check-node-linux-parity.py` before compiling the isolated target. The checker verifies more than Cargo dependency parity:

- shared package identity/build fields and shared dependency tables match the production manifest,
- the isolated manifest exposes exactly `konofix-node` and `konofix-netprobe`,
- Linux source wrappers remain canonical `include!` bridges to the production Rust binary sources,
- `src-tauri/build-shared.rs` contains the required provenance implementation and remains free of Tauri/GUI build dependencies,
- both build-script wrappers actively include the canonical shared provenance source exactly once,
- both wrappers invoke `emit_build_provenance()` exactly once,
- the isolated Linux build wrapper cannot contain a second/shadow provenance implementation,
- the desktop build wrapper still invokes its desktop build hook.

The checker has adversarial self-tests that intentionally introduce manifest drift, wrong/commented source bridges, Linux-only executable source, missing/commented build-provenance bridges, duplicated Linux provenance helpers and a missing shared provenance source. Those mutations must be rejected before the real repository parity gate runs.

## Why this matters

Stable-promotion evidence is scoped to one exact source revision rather than only to the semantic version. Allowing Windows and Linux build scripts to evolve separate source-commit logic could make otherwise valid-looking Node health, Netprobe or release evidence refer to inconsistent build identities. Keeping one implementation and testing the bridges makes such drift visible in CI.

## Verification expectations

A provenance refactor is not considered complete only because the parity self-test passes. The final pull-request head must also pass:

- Linux locked metadata, format and headless dependency gates,
- Linux Node and Netprobe tests and release build,
- authenticated Linux TCP + QUIC-v1 runtime smoke,
- Linux bundle provenance verification,
- Windows project audit, format, Clippy and all-target tests,
- production Windows Tauri/Node/Netprobe builds,
- Windows runtime smoke, staged-bundle verification, ZIP/checksum verification and adversarial release provenance checks.

These build/CI checks do not count as Real Internet Test milestone evidence. Public cross-country, independent-network, CGNAT, Relay and DCUtR evidence remains a separate release gate.