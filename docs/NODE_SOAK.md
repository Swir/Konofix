# Public Konofix Node soak evidence

A single healthy snapshot is not enough to prove that a public bootstrap/relay node is stable. Before stable promotion, Konofix validates a time series of Node health snapshots and rejects evidence that hides a restart, identity change, version/source-commit change, long monitoring gap, stale final sample, or impossible uptime cadence.

## Collect snapshots

Start the public Node with a persistent identity and health output:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com --status-interval 30 --health-file C:\Konofix\health.json
```

Copy each refreshed snapshot to an evidence directory without modifying the JSON content. The file names do not matter because the validator sorts samples by `timestamp_unix`.

Example collection loop for a controlled test machine:

```powershell
$source = 'C:\Konofix\health.json'
$target = 'C:\Konofix\soak-evidence'
New-Item -ItemType Directory -Force -Path $target | Out-Null
while ($true) {
  if (Test-Path $source) {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Copy-Item $source (Join-Path $target "$stamp.json") -Force
  }
  Start-Sleep -Seconds 60
}
```

For release evidence, keep the Node identity file unchanged and collect snapshots from the same process window. A one-hour window is the current default minimum for stable-promotion validation; longer unattended runs are encouraged before wider deployment.

## Validate the soak

Use the `commit` value from the Windows artifact's `BUILD_INFO.json` as the source-commit pin:

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
