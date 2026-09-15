param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$MaxAgeSeconds = 120,

    [switch]$RequirePeer
)

$ErrorActionPreference = 'Stop'

if ($MaxAgeSeconds -lt 10) {
    throw 'MaxAgeSeconds must be at least 10.'
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Health snapshot not found: $Path"
}

try {
    $health = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
} catch {
    throw "Health snapshot is not valid JSON: $($_.Exception.Message)"
}

$required = @('schema', 'status', 'version', 'peer_id', 'uptime_seconds', 'connected_peers', 'timestamp_unix')
foreach ($field in $required) {
    if ($null -eq $health.$field) {
        throw "Health snapshot is missing required field: $field"
    }
}

if ([int]$health.schema -ne 1) {
    throw "Unsupported health snapshot schema: $($health.schema)"
}

if ([string]::IsNullOrWhiteSpace([string]$health.peer_id)) {
    throw 'Health snapshot contains an empty Peer ID.'
}

if ($health.status -ne 'running') {
    throw "Konofix Node is not running according to the snapshot (status=$($health.status))."
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$age = $now - [int64]$health.timestamp_unix
if ($age -lt -30) {
    throw "Health snapshot timestamp is unexpectedly in the future (age=${age}s)."
}
if ($age -gt $MaxAgeSeconds) {
    throw "Konofix Node health snapshot is stale (age=${age}s, limit=${MaxAgeSeconds}s)."
}

$peerCount = [int]$health.connected_peers
if ($peerCount -lt 0) {
    throw 'Connected peer count cannot be negative.'
}
if ($RequirePeer -and $peerCount -lt 1) {
    throw 'Konofix Node is healthy but has no connected peers.'
}

Write-Host "Konofix Node healthy: version=$($health.version) peer_id=$($health.peer_id) uptime=$($health.uptime_seconds)s connected_peers=$peerCount snapshot_age=${age}s"
