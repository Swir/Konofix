# RustSec dependency-audit gate

Konofix audits the exact committed Rust dependency graph in `src-tauri/Cargo.lock` with a dedicated read-only GitHub Actions workflow.

## What the gate verifies

- `cargo-audit` is installed at the reviewed fixed version `0.22.2` with Cargo `--locked`.
- The workflow uses Rust `1.88.0`, matching the project's reviewed toolchain policy for this gate.
- External GitHub Actions are pinned to immutable 40-character commit SHAs.
- Checkout does not persist credentials and workflow permissions remain `contents: read`.
- A controlled vulnerable `rustls 0.23.44` lockfile fixture must be rejected specifically for `RUSTSEC-2026-0285` before the production lockfile is scanned.
- The fixture is derived in runner temporary storage and never changes the repository lockfile.
- The production check audits `src-tauri/Cargo.lock` directly.

The controlled fixture intentionally rewrites the single `rustls` package entry regardless of the currently safe locked version. This keeps the fail-closed proof useful after ordinary safe `rustls` upgrades while still failing if the dependency topology changes enough that the fixture is no longer trustworthy.

## When it runs

The RustSec workflow runs on pushes to `main`, pull requests that change the Rust dependency inputs or the audit-policy files, a weekly schedule, and manual dispatch. The scheduled run matters because a new advisory can be published even when the committed dependency graph has not changed.

## Policy regression tests

`scripts/check-rustsec-workflow.mjs` statically enforces the read-only/pinning/audit contract. `scripts/test-rustsec-workflow.mjs` mutates representative security controls and requires the checker to reject each mutation. Both are part of the normal `npm run audit` project gate, so Windows CI protects the RustSec workflow itself from silent policy drift.

The adversarial policy tests currently reject at least these regressions:

- granting repository write permission,
- replacing an immutable Action SHA with a floating tag,
- persisting checkout credentials,
- removing Cargo `--locked` from the cargo-audit installation,
- removing the scheduled advisory refresh,
- removing the direct audit of the committed production lockfile.

## Triage

A RustSec failure is a dependency-security signal, not an instruction to auto-upgrade blindly. Review the advisory, affected version range, patched version, actual Konofix usage and compatibility impact. Update the lockfile through a normal reviewed dependency change and require the usual Windows/Linux build and test gates before merge.

Do not suppress an advisory only to make CI green. Any exception must be explicit, narrowly scoped, documented with the upstream advisory context and revisited when dependencies change.

## Relationship to release readiness

RustSec scanning improves supply-chain security but does not provide evidence for the Real Internet Test milestone. It must not increase the 54/59 (92%) network-test score. Public-Node stability, independent-country/network testing and real TCP/QUIC/Relay/DCUtR/CGNAT evidence remain separate release-readiness gates.
