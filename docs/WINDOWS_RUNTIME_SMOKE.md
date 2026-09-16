# Windows Konofix Node runtime smoke

`test-node-runtime.ps1` executes the production `konofix-node.exe`; it is not a source-only or mocked test.

## What the smoke gate proves

The script starts the Node on an unused loopback port, waits for a schema-v2 `running` health snapshot, and validates the snapshot with the same health validator used by the public-Node test flow. It requires the health snapshot to match the expected Konofix version and exact source commit.

The first run must persist a non-empty identity file. The script then terminates the process, starts the same binary again with that identity file, and requires the Peer ID to remain identical. A changed Peer ID, version, source commit, malformed health snapshot, early process exit, or startup timeout fails the smoke gate.

This verifies executable startup, exact-build telemetry, health-file production, and persistent identity behavior. It does **not** prove Internet reachability, NAT traversal, QUIC connectivity, relay/DCUtR behavior, or cross-country operation. Those remain real-network promotion gates.

## Repository-build mode

After building the Windows Node from the repository, run:

```powershell
.\scripts\test-node-runtime.ps1
```

The default executable is `src-tauri\target\release\konofix-node.exe`. The expected version comes from `package.json`; the expected source commit comes from `GITHUB_SHA` in CI or the current Git `HEAD` locally.

A custom executable can be supplied explicitly:

```powershell
.\scripts\test-node-runtime.ps1 -NodePath 'C:\path\to\konofix-node.exe'
```

`build-windows.ps1` runs this smoke gate automatically after producing the release Node.

## Verified-artifact mode

The Windows test archive includes both `konofix-node.exe` and `scripts\test-node-runtime.ps1`. After extracting the archive, run from its root:

```powershell
.\scripts\test-node-runtime.ps1
```

When `BUILD_INFO.json` is present beside the `scripts` directory, the script switches to artifact mode. It requires schema 1 build metadata, validates the packaged Node SHA-256 against `BUILD_INFO.json`, and then validates the Node's runtime version/source commit against the same provenance record before and after the identity-preserving restart.

Windows CI performs this artifact-mode smoke before creating the final ZIP, and release verification requires the smoke script itself to be included in the provenance-tracked tool set.

## Timeout

The startup timeout defaults to 30 seconds and can be changed within the fail-safe range of 5–120 seconds:

```powershell
.\scripts\test-node-runtime.ps1 -StartupTimeoutSeconds 60
```

Temporary identity and health files are created under the system temporary directory and removed when the test finishes, including failure paths where cleanup can still run.
