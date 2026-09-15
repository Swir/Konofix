$ErrorActionPreference = 'Stop'

$checker = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
    throw "Node health checker not found: $checker"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-node-health-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

function Write-Snapshot {
    param(
        [string]$Name,
        [hashtable]$Overrides = @{}
    )
    $snapshot = [ordered]@{
        schema = 1
        status = 'running'
        version = '0.4.2'
        peer_id = '12D3KooWTestPeerId'
        uptime_seconds = 120
        connected_peers = 2
        timestamp_unix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    }
    foreach ($key in $Overrides.Keys) { $snapshot[$key] = $Overrides[$key] }
    $path = Join-Path $tempRoot ($Name + '.json')
    $snapshot | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}

function Expect-Pass {
    param([string]$Name, [string]$Path, [switch]$RequirePeer)
    try {
        & $checker -Path $Path -MaxAgeSeconds 120 -RequirePeer:$RequirePeer
    } catch {
        throw "Expected PASS: $Name. Checker error: $($_.Exception.Message)"
    }
    Write-Host "PASS fixture accepted: $Name"
}

function Expect-Reject {
    param([string]$Name, [scriptblock]$Action)
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw "Expected rejection: $Name" }
    Write-Host "Invalid fixture rejected: $Name"
}

try {
    $valid = Write-Snapshot 'valid'
    Expect-Pass 'valid health snapshot' $valid -RequirePeer

    Expect-Reject 'missing snapshot' { & $checker -Path (Join-Path $tempRoot 'missing.json') }

    $malformed = Join-Path $tempRoot 'malformed.json'
    Set-Content -LiteralPath $malformed -Value '{not-json' -Encoding utf8
    Expect-Reject 'malformed JSON' { & $checker -Path $malformed }

    foreach ($case in @(
        @{ Name='unsupported schema'; Overrides=@{schema=2} },
        @{ Name='stopped node'; Overrides=@{status='stopped'} },
        @{ Name='empty peer id'; Overrides=@{peer_id=''} },
        @{ Name='negative peers'; Overrides=@{connected_peers=-1} },
        @{ Name='stale snapshot'; Overrides=@{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-600)} },
        @{ Name='future snapshot'; Overrides=@{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+120)} }
    )) {
        $path = Write-Snapshot ($case.Name -replace ' ','-') $case.Overrides
        Expect-Reject $case.Name { & $checker -Path $path -MaxAgeSeconds 120 }
    }

    $noPeers = Write-Snapshot 'no-peers' @{connected_peers=0}
    Expect-Pass 'zero peers allowed without RequirePeer' $noPeers
    Expect-Reject 'RequirePeer rejects zero peers' { & $checker -Path $noPeers -MaxAgeSeconds 120 -RequirePeer }

    Write-Host 'Konofix Node health checker self-tests passed.'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
