param()

$ErrorActionPreference = 'Stop'
$collector = Join-Path $PSScriptRoot 'collect-node-soak.ps1'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) { throw 'Node soak collector not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-node-soak-collector-selftest-" + [Guid]::NewGuid().ToString('N'))
$health = Join-Path $temp 'health.json'
$output = Join-Path $temp 'evidence'
$peerId = '12D3KooWCollectorSelfTestStablePeer123456789'
$version = '0.4.2'
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function Write-Health([int64]$Timestamp, [int64]$Uptime, [int64]$Peers) {
    [ordered]@{
        schema = 2
        status = 'running'
        version = $version
        source_commit = $sourceCommit
        peer_id = $peerId
        uptime_seconds = $Uptime
        connected_peers = $Peers
        timestamp_unix = $Timestamp
    } | ConvertTo-Json | Set-Content -LiteralPath $health -Encoding utf8
}

function Invoke-Collector([hashtable]$Extra = @{}) {
    $args = @{
        HealthFile = $health
        OutputDirectory = $output
        Once = $true
        ReadAttempts = 1
        ExpectedVersion = $version
        ExpectedPeerId = $peerId
        ExpectedSourceCommit = $sourceCommit
    }
    foreach ($key in $Extra.Keys) { $args[$key] = $Extra[$key] }
    & $collector @args
}

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true; Write-Host "Expected rejection passed: $Name" }
    if (-not $rejected) { throw "Negative Node soak collector self-test was accepted unexpectedly: $Name" }
}

try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null

    Write-Health -Timestamp $now -Uptime 1000 -Peers 1
    Invoke-Collector | Out-Null
    $samples = @(Get-ChildItem -LiteralPath $output -Filter '*.json' -File)
    if ($samples.Count -ne 1) { throw "Collector should create exactly one sample, found $($samples.Count)." }

    Invoke-Collector | Out-Null
    $samples = @(Get-ChildItem -LiteralPath $output -Filter '*.json' -File)
    if ($samples.Count -ne 1) { throw 'Duplicate snapshot should be deduplicated instead of creating a second file.' }
    Write-Host 'Duplicate snapshot deduplication passed.'

    Write-Health -Timestamp $now -Uptime 1000 -Peers 2
    Assert-Rejected { Invoke-Collector } 'same timestamp with conflicting content'
    $samples = @(Get-ChildItem -LiteralPath $output -Filter '*.json' -File)
    if ($samples.Count -ne 1) { throw 'Conflicting snapshot must not overwrite or append evidence.' }

    Write-Health -Timestamp ($now + 1) -Uptime 1001 -Peers 2
    Invoke-Collector | Out-Null
    $samples = @(Get-ChildItem -LiteralPath $output -Filter '*.json' -File)
    if ($samples.Count -ne 2) { throw "Second valid timestamp should create a second sample, found $($samples.Count)." }

    Assert-Rejected { Invoke-Collector @{ ExpectedPeerId = '12D3KooWWrongCollectorPeer' } } 'wrong expected Peer ID'

    '{broken-json' | Set-Content -LiteralPath $health -Encoding utf8
    Assert-Rejected { Invoke-Collector } 'malformed health JSON'

    Write-Health -Timestamp ($now - 600) -Uptime 400 -Peers 1
    Assert-Rejected { Invoke-Collector @{ MaxAgeSeconds = 120 } } 'stale health snapshot'

    $scratch = @(Get-ChildItem -LiteralPath $output -Filter '.capture-*.json' -File -ErrorAction SilentlyContinue)
    if ($scratch.Count -ne 0) { throw 'Collector left temporary capture files behind after a rejection.' }

    Write-Host 'Node soak collector self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
