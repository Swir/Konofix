# Public Konofix Node soak evidence

A single healthy snapshot is not enough to prove that a public bootstrap/relay node is stable. Before stable promotion, Konofix validates a time series of Node health snapshots and rejects evidence that hides a restart, identity change, version/source-commit change, long monitoring gap, stale final sample, impossible uptime cadence, or a switch to a different packaged Node build.

## Collect snapshots

Start the public Node with a persistent identity and health output:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com --status-interval 30 --health-file C:\Konofix\health.json
```

The preferred collector is `collect-node-soak.ps1`. It copies the health file to a private scratch path, validates that exact copy with the normal Node-health validator, then moves only validated bytes into the evidence directory. Re-reading the same snapshot is deduplicated; a different snapshot that claims the same Unix timestamp is rejected instead of overwriting evidence. Short read/replace races are retried, while persistent malformed, stale, wrong-version, wrong-commit or wrong-Peer-ID state fails closed.

For promotion-quality evidence, also pass the exact Windows artifact's `BUILD_INFO.json` and the `konofix-node.exe` that it seals. The collector verifies the Node size and SHA-256 against `BUILD_INFO.json`, verifies the health snapshot version/source commit against that build, and stamps every collected snapshot with `evidence_binding_schema=1`, `node_binary_sha256`, and `build_info_sha256`. This prevents a soak history captured for another same-version/same-source build from being silently reused for final promotion.

Use the version and full source commit from the same Windows artifact, and the stable Peer ID printed by the public Node/readiness check:

```powershell
.\scripts\collect-node-soak.ps1 `
  -HealthFile 'C:\Konofix\health.json' `
  -OutputDirectory 'C:\Konofix\soak-evidence' `
  -DurationSeconds 3600 `
  -IntervalSeconds 60 `
  -ExpectedVersion '0.4.2' `
  -ExpectedPeerId '12D3KooW...' `
  -ExpectedSourceCommit '0123456789abcdef0123456789abcdef01234567' `
  -BuildInfoPath 'C:\Konofix\artifact\BUILD_INFO.json' `
  -NodeBinaryPath 'C:\Konofix\artifact\konofix-node.exe'
```

`-BuildInfoPath` and `-NodeBinaryPath` are an all-or-nothing pair. Supplying only one is rejected. The collector also rejects a binary whose byte length or SHA-256 does not match `BUILD_INFO.json`, or health telemetry whose version/source commit does not match that build.

For a one-shot capture, such as a deployment diagnostic, add `-Once`. The collector never edits the Node health file and never overwrites previously collected evidence.

For release evidence, keep the Node identity file unchanged and collect snapshots from the same process window. A one-hour window is the current default minimum for stable-promotion validation; longer unattended runs are encouraged before wider deployment.

## Validate the soak

For promotion-quality evidence, pin the exact Node and `BUILD_INFO.json` hashes as well as the source commit and Peer ID:

```powershell
$files = (Get-ChildItem 'C:\Konofix\soak-evidence\*.json').FullName
.\scripts\validate-node-soak.ps1 `
  -Snapshot $files `
  -ExpectedVersion '0.4.2' `
  -ExpectedPeerId '12D3KooW...' `
  -ExpectedSourceCommit '0123456789abcdef0123456789abcdef01234567' `
  -ExpectedNodeSha256 '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' `
  -ExpectedBuildInfoSha256 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' `
  -MinSpanSeconds 3600 `
  -MaxGapSeconds 180 `
  -MaxAgeSeconds 300 `
  -RequirePeerObserved
```

The exact-build hash parameters are also an all-or-nothing pair. Stable promotion supplies both automatically from the verified Windows artifact. A mixed set of bound and legacy-unbound snapshots is rejected. Bound snapshots must all carry the same canonical lowercase Node and `BUILD_INFO.json` SHA-256 values.

The validator requires:

- schema-v2 health snapshots with real JSON integer/string types,
- `status` equal to `running`,
- one case-sensitive Node version across the full window,
- one canonical source commit across the full window,
- one case-sensitive Peer ID across the full window,
- one exact Node binary SHA-256 and one exact `BUILD_INFO.json` SHA-256 when artifact binding is required,
- no mixing of exact-build-bound and legacy-unbound snapshots,
- a fresh final snapshot,
- a minimum observation span,
- bounded gaps between consecutive samples,
- monotonically increasing uptime with cadence consistent with timestamps,
- no restart inside the evidence window,
- non-negative peer counts,
- at least one connected peer when `-RequirePeerObserved` is requested.

`source_commit=unknown` is tolerated only for non-promotion local diagnostics. It cannot satisfy `-ExpectedSourceCommit` and therefore cannot be used as stable-promotion evidence. Legacy unbound snapshots remain readable for local diagnostics but cannot satisfy the final exact-build promotion preflight.

## Stable promotion gate

The final artifact-level promotion preflight is `check-promotion-evidence.ps1`. It verifies the packaged `konofix-node.exe` against `BUILD_INFO.json`, verifies the coherent cross-country session and authenticated dual-client Netprobe evidence, and now requires every public-Node soak sample to carry the exact same Node and `BUILD_INFO.json` hashes:

```powershell
$network = (Get-ChildItem '.\evidence\network\*.json').FullName
$soak = (Get-ChildItem '.\evidence\node-soak\*.json').FullName
$clientProbes = (Get-ChildItem '.\evidence\client-netprobe\*.json').FullName

.\scripts\check-promotion-evidence.ps1 `
  -BuildInfoPath '.\artifact\BUILD_INFO.json' `
  -SessionInfoPath '.\evidence\network\SESSION_INFO.json' `
  -NetworkEvidence $network `
  -ClientNetprobeEvidence $clientProbes `
  -NodeSoakEvidence $soak
```

The source-level `release-gate.ps1` continues to provide repository/build preflight checks and source/identity soak checks. It is not a substitute for the final artifact-level promotion preflight above, because only `check-promotion-evidence.ps1` has the verified packaged Node and `BUILD_INFO.json` available for exact-build binding.

This does not make a public Node trustworthy by itself. It makes accidental evidence/build substitution fail closed and keeps the promotion decision reproducible: the real Internet tests, authenticated client probes, stability window, Node identity, source commit and exact packaged build must all agree.

## Privacy

Raw Node health snapshots contain only operational metadata: schema, process state, version, source commit, Peer ID, uptime, connected-peer count, and timestamp. Promotion-quality collected copies add only SHA-256 provenance for the Node executable and `BUILD_INFO.json`. They do not contain messages, room contents, filenames, transferred bytes, account data, contact lists, machine identifiers, or network identifiers.
