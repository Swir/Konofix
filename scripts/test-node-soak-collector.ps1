param()

$ErrorActionPreference = 'Stop'
$collector = Join-Path $PSScriptRoot 'collect-node-soak.ps1'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) { throw 'Node soak collector not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-node-soak-collector-selftest-" + [Guid]::NewGuid().ToString('N'))
$health = Join-Path $temp 'health.json'
$output = Join-Path $temp 'evidence'
$nodePath = Join-Path $temp 'konofix-node.exe'
$buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
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
        BuildInfoPath = $buildInfoPath
        NodeBinaryPath = $nodePath
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
    $nodeBytes = [byte[]]::new(2048)
    for ($i = 0; $i -lt $nodeBytes.Length; $i++) { $nodeBytes[$i] = [byte]($i % 251) }
    [IO.File]::WriteAllBytes($nodePath, $nodeBytes)
    $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{
        schema = 2
        product = 'Konofix Chat'
        version = $version
        commit = $sourceCommit
        node = [ordered]@{
            path = 'konofix-node.exe'
            bytes = [int64](Get-Item -LiteralPath $nodePath).Length
            sha256 = $nodeHash
        }
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $buildInfoPath -Encoding utf8
    $buildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Health -Timestamp $now -Uptime 1000 -Peers 1
    Invoke-Collector | Out-Null
    $samples = @(Get-ChildItem -LiteralPath $output -Filter '*.json' -File)
    if ($samples.Count -ne 1) { throw "Collector should create exactly one sample, found $($samples.Count)." }
    $sealed = Get-Content -LiteralPath $samples[0].FullName -Raw | ConvertFrom-Json
    if ([int]$sealed.evidence_binding_schema -ne 1) { throw 'Collector did not stamp the exact-build evidence binding schema.' }
    if ([string]$sealed.node_binary_sha256 -cne $nodeHash) { throw 'Collector Node SHA-256 binding mismatch.' }
    if ([string]$sealed.build_info_sha256 -cne $buildInfoHash) { throw 'Collector BUILD_INFO SHA-256 binding mismatch.' }
    Write-Host 'Exact-build soak sealing passed.'

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
    Assert-Rejected { Invoke-Collector @{ BuildInfoPath = '' } } 'partial exact-build binding configuration'

    $originalNodeBytes = [IO.File]::ReadAllBytes($nodePath)
    $tamperedNodeBytes = [byte[]]::new($originalNodeBytes.Length + 1)
    [Array]::Copy($originalNodeBytes, $tamperedNodeBytes, $originalNodeBytes.Length)
    [IO.File]::WriteAllBytes($nodePath, $tamperedNodeBytes)
    Assert-Rejected { Invoke-Collector } 'Node binary does not match BUILD_INFO'
    [IO.File]::WriteAllBytes($nodePath, $originalNodeBytes)

    $wrongBuildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
    $wrongBuildInfo.commit = '89abcdef0123456789abcdef0123456789abcdef'
    $wrongBuildPath = Join-Path $temp 'BUILD_INFO-wrong.json'
    $wrongBuildInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $wrongBuildPath -Encoding utf8
    Write-Health -Timestamp ($now + 2) -Uptime 1002 -Peers 1
    Assert-Rejected { Invoke-Collector @{ BuildInfoPath = $wrongBuildPath } } 'health source commit does not match BUILD_INFO'

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
