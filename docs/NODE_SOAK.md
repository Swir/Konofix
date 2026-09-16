# Public Konofix Node soak evidence

A single healthy snapshot is not enough to prove that a public bootstrap/relay node is stable. Before stable promotion, Konofix validates a time series of Node health snapshots and rejects evidence that hides a restart, identity change, version/source-commit change, long monitoring gap, stale final sample, or impossible uptime cadence.

## Collect snapshots

Start the public Node with a persistent identity and health output:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com --status-interval 30 --health-file C:\Konofix\health.json
```

The preferred collector is `collect-node-soak.ps1`. It copies the health file to a private scratch path, validates that exact copy with the normal Node-health validator, then moves only validated bytes into the evidence directory. Re-reading the same snapshot is deduplicated; a different snapshot that claims the same Unix timestamp is rejected instead of overwriting evidence. Short read/replace races are retried, while persistent malformed, stale, wrong-version, wrong-commit or wrong-Peer-ID state fails closed.

Use the version and full source commit from the Windows artifact's `BUILD_INFO.json`, and the stable Peer ID printed by the public Node/readiness check:

```powershell
.\scripts\collect-node-soak.ps1 `
  -HealthFile 'C:\Konofix\health.json' `
  -OutputDirectory 'C:\Konofix\soak-evidence' `
  -DurationSeconds 3600 `
  -IntervalSeconds 60 `
  -ExpectedVersion '0.4.2' `
  -ExpectedPeerId '12D3KooW...' `
  -ExpectedSourceCommit '0123456789abcdef0123456789abcdef01234567'
```

For a one-shot capture, such as a deployment diagnostic, add `-Once`. The collector never edits the Node health file and never overwrites previously collected evidence.

For release evidence, keep the Node identity file unchanged and collect snapshots from the same process window. A one-hour window is the current default minimum for stable-promotion validation; longer unattended runs are encouraged before wider deployment.

## Validate the soak

Use the same source-commit and Peer-ID pins used during collection:

```powershell
$files = (Get-ChildItem 'C:\Konofix\soak-evidence\*.json').FullName
.\scripts\validate-node-soak.ps1 `
  -Snapshot $files `
  -ExpectedVersion '0.4.2' `
  -ExpectedPeerId '12D3KooW...' `
  -ExpectedSourceCommit '0123456789abcdef0123456789abcdef01234567' `
  -MinSpanSeconds 3600 `
  -MaxGapSeconds 180 `
  -MaxAgeSeconds 300 `
  -RequirePeerObserved
```

The validator requires:

- schema-v2 health snapshots with real JSON integer/string types,
- `status` equal to `running`,
- one case-sensitive Node version across the full window,
- one canonical source commit across the full window,
- one case-sensitive Peer ID across the full window,
- a fresh final snapshot,
- a minimum observation span,
- bounded gaps between consecutive samples,
- monotonically increasing uptime with cadence consistent with timestamps,
- no restart inside the evidence window,
- non-negative peer counts,
- at least one connected peer when `-RequirePeerObserved` is requested.

`source_commit=unknown` is tolerated only for non-promotion local diagnostics. It cannot satisfy `-ExpectedSourceCommit` and therefore cannot be used as stable-promotion evidence.

## Stable promotion gate

Stable promotion requires both schema-v3 real-network manifests and Node soak evidence. The release gate resolves the exact target Git commit, extracts the bootstrap Peer ID from the network evidence, and requires every network manifest and every soak sample to match the same source commit, Node version and Node identity:

```powershell
$network = (Get-ChildItem '.\evidence\network\*.json').FullName
$soak = (Get-ChildItem '.\evidence\node-soak\*.json').FullName

.\scripts\release-gate.ps1 `
  -RequireNetworkEvidence `
  -NetworkEvidence $network `
  -NodeSoakEvidence $soak
```

When Git metadata is available, stable promotion also requires a clean working tree. This prevents evidence gathered for one commit from promoting another commit that happens to use the same `0.4.2` version string.

This does not make a public Node trustworthy by itself. It makes the promotion decision reproducible and fail-closed: the real Internet tests and stability window must refer to the same Node identity, release version and exact committed source.

## Privacy

Health snapshots contain only operational metadata: schema, process state, version, source commit, Peer ID, uptime, connected-peer count, and timestamp. They do not contain messages, room contents, filenames, transferred bytes, account data, or contact lists.
