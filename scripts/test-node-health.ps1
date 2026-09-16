$ErrorActionPreference = 'Stop'

$checker = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) { throw "Node health checker not found: $checker" }
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-node-health-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

function Write-Snapshot {
    param([string]$Name, [hashtable]$Overrides = @{})
    $snapshot = [ordered]@{ schema=1; status='running'; version='0.4.2'; peer_id='12D3KooWTestPeerId'; uptime_seconds=120; connected_peers=2; timestamp_unix=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
    foreach ($key in $Overrides.Keys) { $snapshot[$key] = $Overrides[$key] }
    $path = Join-Path $tempRoot ($Name + '.json')
    $snapshot | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}
function Expect-Pass { param([string]$Name,[scriptblock]$Action) try { & $Action } catch { throw "Expected PASS: $Name. Checker error: $($_.Exception.Message)" }; Write-Host "PASS fixture accepted: $Name" }
function Expect-Reject { param([string]$Name,[scriptblock]$Action) $rejected=$false; try { & $Action } catch { $rejected=$true }; if(-not $rejected){throw "Expected rejection: $Name"}; Write-Host "Invalid fixture rejected: $Name" }

try {
    $valid=Write-Snapshot 'valid'
    Expect-Pass 'valid health snapshot' { & $checker -Path $valid -MaxAgeSeconds 120 -RequirePeer -ExpectedVersion '0.4.2' -ExpectedPeerId '12D3KooWTestPeerId' -MinUptimeSeconds 60 }
    Expect-Reject 'missing snapshot' { & $checker -Path (Join-Path $tempRoot 'missing.json') }
    $malformed=Join-Path $tempRoot 'malformed.json'; Set-Content -LiteralPath $malformed -Value '{not-json' -Encoding utf8
    Expect-Reject 'malformed JSON' { & $checker -Path $malformed }

    foreach ($case in @(
        @{Name='unsupported schema';Overrides=@{schema=2}}, @{Name='string schema';Overrides=@{schema='1'}},
        @{Name='stopped node';Overrides=@{status='stopped'}}, @{Name='uppercase running status';Overrides=@{status='RUNNING'}}, @{Name='numeric status';Overrides=@{status=1}}, @{Name='boolean status';Overrides=@{status=$true}}, @{Name='whitespace status';Overrides=@{status='   '}},
        @{Name='empty version';Overrides=@{version=''}}, @{Name='numeric version';Overrides=@{version=42}}, @{Name='boolean version';Overrides=@{version=$true}}, @{Name='whitespace version';Overrides=@{version='   '}},
        @{Name='empty peer id';Overrides=@{peer_id=''}}, @{Name='numeric peer id';Overrides=@{peer_id=123}}, @{Name='boolean peer id';Overrides=@{peer_id=$false}}, @{Name='whitespace peer id';Overrides=@{peer_id='   '}},
        @{Name='negative uptime';Overrides=@{uptime_seconds=-1}}, @{Name='string uptime';Overrides=@{uptime_seconds='120'}},
        @{Name='negative peers';Overrides=@{connected_peers=-1}}, @{Name='fractional peers';Overrides=@{connected_peers=1.5}}, @{Name='boolean peers';Overrides=@{connected_peers=$true}},
        @{Name='non-positive timestamp';Overrides=@{timestamp_unix=0}}, @{Name='string timestamp';Overrides=@{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString())}},
        @{Name='impossible uptime';Overrides=@{timestamp_unix=100;uptime_seconds=101}}, @{Name='stale snapshot';Overrides=@{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-600)}}, @{Name='future snapshot';Overrides=@{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+120)}}
    )) { $path=Write-Snapshot ($case.Name -replace ' ','-') $case.Overrides; Expect-Reject $case.Name { & $checker -Path $path -MaxAgeSeconds 120 } }

    Expect-Reject 'too-small maximum age argument' { & $checker -Path $valid -MaxAgeSeconds 9 }; Expect-Reject 'excessive maximum age argument' { & $checker -Path $valid -MaxAgeSeconds 86401 }; Expect-Pass 'maximum supported freshness window accepted' { & $checker -Path $valid -MaxAgeSeconds 86400 }
    Expect-Reject 'wrong expected version' { & $checker -Path $valid -ExpectedVersion '9.9.9' }; Expect-Reject 'case-changed expected version' { & $checker -Path $valid -ExpectedVersion '0.4.2'.ToUpperInvariant() }; Expect-Reject 'wrong expected Peer ID' { & $checker -Path $valid -ExpectedPeerId '12D3KooWWrongPeer' }; Expect-Reject 'case-changed expected Peer ID' { & $checker -Path $valid -ExpectedPeerId '12d3KooWTestPeerId' }
    Expect-Reject 'negative minimum uptime argument' { & $checker -Path $valid -MinUptimeSeconds -1 }; Expect-Reject 'insufficient stability uptime' { & $checker -Path $valid -MinUptimeSeconds 121 }; Expect-Pass 'minimum stability uptime satisfied' { & $checker -Path $valid -MinUptimeSeconds 120 }
    Expect-Reject 'negative minimum peer quorum argument' { & $checker -Path $valid -MinConnectedPeers -1 }; Expect-Pass 'minimum peer quorum satisfied' { & $checker -Path $valid -MinConnectedPeers 2 }; Expect-Reject 'insufficient peer quorum' { & $checker -Path $valid -MinConnectedPeers 3 }
    Expect-Reject 'negative future skew argument' { & $checker -Path $valid -MaxFutureSkewSeconds -1 }; Expect-Reject 'excessive future skew argument' { & $checker -Path $valid -MaxFutureSkewSeconds 301 }
    Expect-Reject 'too-small snapshot size limit' { & $checker -Path $valid -MaxSnapshotBytes 1023 }; Expect-Reject 'excessive snapshot size limit' { & $checker -Path $valid -MaxSnapshotBytes 1048577 }; Expect-Pass 'minimum supported snapshot size limit accepted' { & $checker -Path $valid -MaxSnapshotBytes 1024 }

    $oversized=Join-Path $tempRoot 'oversized.json'; $padding='x'*70000
    [ordered]@{schema=1;status='running';version='0.4.2';peer_id='12D3KooWTestPeerId';uptime_seconds=120;connected_peers=2;timestamp_unix=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();padding=$padding} | ConvertTo-Json -Compress | Set-Content -LiteralPath $oversized -Encoding utf8
    Expect-Reject 'oversized health snapshot' { & $checker -Path $oversized }; Expect-Pass 'oversized fixture accepted only with explicit larger bound' { & $checker -Path $oversized -MaxSnapshotBytes 131072 }
    $nearFuture=Write-Snapshot 'near-future' @{timestamp_unix=([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+10)}; Expect-Pass 'small configured clock skew accepted' { & $checker -Path $nearFuture -MaxFutureSkewSeconds 15 }; Expect-Reject 'strict clock skew rejects future snapshot' { & $checker -Path $nearFuture -MaxFutureSkewSeconds 0 }
    $noPeers=Write-Snapshot 'no-peers' @{connected_peers=0}; Expect-Pass 'zero peers allowed without RequirePeer' { & $checker -Path $noPeers }; Expect-Reject 'RequirePeer rejects zero peers' { & $checker -Path $noPeers -MaxAgeSeconds 120 -RequirePeer }
    Write-Host 'Konofix Node health checker self-tests passed.'
} finally { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
