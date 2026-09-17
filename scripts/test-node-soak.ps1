param()

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-node-soak.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw 'Node soak validator not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-node-soak-selftest-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$peerId = '12D3KooWSoakSelfTestStablePeer123456789'
$version = '0.4.2'
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$nodeHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$buildInfoHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function Write-Snapshot([string]$Path, [int64]$Timestamp, [int64]$Uptime, [int64]$Peers) {
    [ordered]@{
        schema = 2
        status = 'running'
        version = $version
        source_commit = $sourceCommit
        peer_id = $peerId
        uptime_seconds = $Uptime
        connected_peers = $Peers
        timestamp_unix = $Timestamp
        evidence_binding_schema = 1
        node_binary_sha256 = $nodeHash
        build_info_sha256 = $buildInfoHash
    } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Copy-MutatedSet([string]$Name, [scriptblock]$Mutation) {
    $dir = Join-Path $temp $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $out = @()
    foreach ($source in $script:paths) {
        $target = Join-Path $dir ([IO.Path]::GetFileName($source))
        Copy-Item -LiteralPath $source -Destination $target
        $out += $target
    }
    & $Mutation $out
    return $out
}

function Mutate-Json([string]$Path, [scriptblock]$Mutation) {
    $data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    & $Mutation $data
    $data | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true; Write-Host "Expected rejection passed: $Name" }
    if (-not $rejected) { throw "Negative Node soak self-test was accepted unexpectedly: $Name" }
}

try {
    $script:paths = @()
    $samples = @(
        @{ offset = -180; uptime = 1000; peers = 0 },
        @{ offset = -120; uptime = 1060; peers = 1 },
        @{ offset = -60; uptime = 1120; peers = 2 },
        @{ offset = 0; uptime = 1180; peers = 1 }
    )
    for ($i = 0; $i -lt $samples.Count; $i++) {
        $path = Join-Path $temp ("sample-{0}.json" -f $i)
        Write-Snapshot -Path $path -Timestamp ($now + $samples[$i].offset) -Uptime $samples[$i].uptime -Peers $samples[$i].peers
        $script:paths += $path
    }

    & $validator -Snapshot $paths -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedVersion $version -ExpectedPeerId $peerId -ExpectedSourceCommit $sourceCommit -ExpectedNodeSha256 $nodeHash -ExpectedBuildInfoSha256 $buildInfoHash -RequirePeerObserved
    Write-Host 'Positive exact-build-bound Node soak self-test passed.'

    $changedPeer = Copy-MutatedSet 'changed-peer' { param($set) Mutate-Json $set[2] { param($d) $d.peer_id = '12D3KooWChangedPeer987654321' } }
    Assert-Rejected { & $validator -Snapshot $changedPeer -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'Peer ID changed during soak'

    $changedVersion = Copy-MutatedSet 'changed-version' { param($set) Mutate-Json $set[1] { param($d) $d.version = '0.4.1' } }
    Assert-Rejected { & $validator -Snapshot $changedVersion -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'version changed during soak'

    $changedCommit = Copy-MutatedSet 'changed-commit' { param($set) Mutate-Json $set[1] { param($d) $d.source_commit = '89abcdef0123456789abcdef0123456789abcdef' } }
    Assert-Rejected { & $validator -Snapshot $changedCommit -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'source commit changed during soak'

    $changedNodeHash = Copy-MutatedSet 'changed-node-hash' { param($set) Mutate-Json $set[2] { param($d) $d.node_binary_sha256 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' } }
    Assert-Rejected { & $validator -Snapshot $changedNodeHash -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedNodeSha256 $nodeHash -ExpectedBuildInfoSha256 $buildInfoHash } 'Node binary hash changed during soak'

    $changedBuildInfoHash = Copy-MutatedSet 'changed-build-info-hash' { param($set) Mutate-Json $set[0] { param($d) $d.build_info_sha256 = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' } }
    Assert-Rejected { & $validator -Snapshot $changedBuildInfoHash -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedNodeSha256 $nodeHash -ExpectedBuildInfoSha256 $buildInfoHash } 'BUILD_INFO hash changed during soak'

    $missingBinding = Copy-MutatedSet 'missing-binding' { param($set) $d = Get-Content $set[1] -Raw | ConvertFrom-Json; $d.PSObject.Properties.Remove('node_binary_sha256'); $d | ConvertTo-Json | Set-Content -LiteralPath $set[1] -Encoding UTF8 }
    Assert-Rejected { & $validator -Snapshot $missingBinding -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedNodeSha256 $nodeHash -ExpectedBuildInfoSha256 $buildInfoHash } 'missing exact-build binding field'

    $mixedBinding = Copy-MutatedSet 'mixed-binding' { param($set) $d = Get-Content $set[3] -Raw | ConvertFrom-Json; foreach ($name in @('evidence_binding_schema','node_binary_sha256','build_info_sha256')) { $d.PSObject.Properties.Remove($name) }; $d | ConvertTo-Json | Set-Content -LiteralPath $set[3] -Encoding UTF8 }
    Assert-Rejected { & $validator -Snapshot $mixedBinding -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'mixed bound and unbound snapshots'

    Assert-Rejected { & $validator -Snapshot $paths -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedNodeSha256 $nodeHash } 'partial exact-build expectation'

    $unknownCommit = Copy-MutatedSet 'unknown-commit' { param($set) foreach ($p in $set) { Mutate-Json $p { param($d) $d.source_commit = 'unknown' } } }
    Assert-Rejected { & $validator -Snapshot $unknownCommit -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -ExpectedSourceCommit $sourceCommit } 'unknown source commit cannot satisfy promotion pin'

    $malformedCommit = Copy-MutatedSet 'malformed-commit' { param($set) Mutate-Json $set[0] { param($d) $d.source_commit = 'not-a-commit' } }
    Assert-Rejected { & $validator -Snapshot $malformedCommit -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'malformed source commit'

    $restart = Copy-MutatedSet 'restart' { param($set) Mutate-Json $set[2] { param($d) $d.uptime_seconds = 10 } }
    Assert-Rejected { & $validator -Snapshot $restart -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'uptime regression indicates restart'

    $badCadence = Copy-MutatedSet 'bad-cadence' { param($set) Mutate-Json $set[1] { param($d) $d.uptime_seconds = 1001 } }
    Assert-Rejected { & $validator -Snapshot $badCadence -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'uptime continuity mismatch'

    $duplicateTimestamp = Copy-MutatedSet 'duplicate-timestamp' { param($set) $a = Get-Content $set[0] -Raw | ConvertFrom-Json; Mutate-Json $set[1] { param($d) $d.timestamp_unix = $a.timestamp_unix; $d.uptime_seconds = $a.uptime_seconds } }
    Assert-Rejected { & $validator -Snapshot $duplicateTimestamp -MinSpanSeconds 120 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'duplicate timestamps'

    $stopped = Copy-MutatedSet 'stopped' { param($set) Mutate-Json $set[3] { param($d) $d.status = 'stopped' } }
    Assert-Rejected { & $validator -Snapshot $stopped -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'stopped snapshot'

    $stale = Copy-MutatedSet 'stale' { param($set) foreach ($p in $set) { Mutate-Json $p { param($d) $d.timestamp_unix = [int64]$d.timestamp_unix - 600 } } }
    Assert-Rejected { & $validator -Snapshot $stale -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 } 'stale latest snapshot'

    $peerless = Copy-MutatedSet 'peerless' { param($set) foreach ($p in $set) { Mutate-Json $p { param($d) $d.connected_peers = 0 } } }
    Assert-Rejected { & $validator -Snapshot $peerless -MinSpanSeconds 180 -MaxGapSeconds 75 -MaxAgeSeconds 60 -RequirePeerObserved } 'no peer observed during soak'

    Write-Host 'Node soak validator self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
