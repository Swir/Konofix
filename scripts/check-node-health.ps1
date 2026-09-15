param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$MaxAgeSeconds = 120,

    [int]$MaxFutureSkewSeconds = 30,

    [switch]$RequirePeer,

    [int]$MinConnectedPeers = 0,

    [string]$ExpectedVersion = '',

    [string]$ExpectedPeerId = '',

    [int64]$MinUptimeSeconds = 0,

    [int64]$MaxSnapshotBytes = 65536
)

$ErrorActionPreference = 'Stop'

function Get-StrictJsonInt64 {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field
    )

    # ConvertFrom-Json preserves JSON integer tokens as integral CLR values. Reject
    # strings, booleans and floating-point tokens instead of allowing PowerShell's
    # permissive casts to coerce them into security-sensitive telemetry values.
    $typeCode = [System.Type]::GetTypeCode($Value.GetType())
    $integralTypes = @(
        [System.TypeCode]::SByte, [System.TypeCode]::Byte,
        [System.TypeCode]::Int16, [System.TypeCode]::UInt16,
        [System.TypeCode]::Int32, [System.TypeCode]::UInt32,
        [System.TypeCode]::Int64, [System.TypeCode]::UInt64
    )
    if ($typeCode -notin $integralTypes) {
        throw "Health snapshot field '$Field' must be a JSON integer."
    }
    try {
        return [Convert]::ToInt64($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        throw "Health snapshot field '$Field' is outside the supported signed 64-bit integer range."
    }
}

if ($MaxAgeSeconds -lt 10 -or $MaxAgeSeconds -gt 86400) {
    throw 'MaxAgeSeconds must be between 10 and 86400.'
}
if ($MaxFutureSkewSeconds -lt 0 -or $MaxFutureSkewSeconds -gt 300) {
    throw 'MaxFutureSkewSeconds must be between 0 and 300.'
}
if ($MinUptimeSeconds -lt 0) {
    throw 'MinUptimeSeconds cannot be negative.'
}
if ($MinConnectedPeers -lt 0) {
    throw 'MinConnectedPeers cannot be negative.'
}
if ($MaxSnapshotBytes -lt 1024 -or $MaxSnapshotBytes -gt 1048576) {
    throw 'MaxSnapshotBytes must be between 1024 and 1048576.'
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Health snapshot not found: $Path"
}

$snapshotFile = Get-Item -LiteralPath $Path
if ($snapshotFile.Length -gt $MaxSnapshotBytes) {
    throw "Health snapshot is too large (bytes=$($snapshotFile.Length) limit=$MaxSnapshotBytes)."
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

$schema = Get-StrictJsonInt64 -Value $health.schema -Field 'schema'
if ($schema -ne 1) {
    throw "Unsupported health snapshot schema: $schema"
}

$version = [string]$health.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'Health snapshot contains an empty version.'
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and $version -ne $ExpectedVersion) {
    throw "Konofix Node version mismatch (expected=$ExpectedVersion actual=$version)."
}

$peerId = [string]$health.peer_id
if ([string]::IsNullOrWhiteSpace($peerId)) {
    throw 'Health snapshot contains an empty Peer ID.'
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedPeerId) -and $peerId -ne $ExpectedPeerId) {
    throw "Konofix Node Peer ID mismatch (expected=$ExpectedPeerId actual=$peerId)."
}

if ($health.status -ne 'running') {
    throw "Konofix Node is not running according to the snapshot (status=$($health.status))."
}

$uptime = Get-StrictJsonInt64 -Value $health.uptime_seconds -Field 'uptime_seconds'
if ($uptime -lt 0) {
    throw 'Node uptime cannot be negative.'
}
if ($uptime -lt $MinUptimeSeconds) {
    throw "Konofix Node uptime is below the required stability window (uptime=${uptime}s required=${MinUptimeSeconds}s)."
}

$timestamp = Get-StrictJsonInt64 -Value $health.timestamp_unix -Field 'timestamp_unix'
if ($timestamp -le 0) {
    throw 'Health snapshot timestamp must be a positive Unix timestamp.'
}
if ($uptime -gt $timestamp) {
    throw "Node uptime is impossible for the snapshot timestamp (uptime=${uptime}s timestamp=${timestamp})."
}
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$age = $now - $timestamp
if ($age -lt -$MaxFutureSkewSeconds) {
    throw "Health snapshot timestamp is unexpectedly in the future (age=${age}s, allowed_skew=${MaxFutureSkewSeconds}s)."
}
if ($age -gt $MaxAgeSeconds) {
    throw "Konofix Node health snapshot is stale (age=${age}s, limit=${MaxAgeSeconds}s)."
}

$peerCount = Get-StrictJsonInt64 -Value $health.connected_peers -Field 'connected_peers'
if ($peerCount -lt 0) {
    throw 'Connected peer count cannot be negative.'
}
$requiredPeers = $MinConnectedPeers
if ($RequirePeer -and $requiredPeers -lt 1) {
    $requiredPeers = 1
}
if ($peerCount -lt $requiredPeers) {
    throw "Konofix Node does not meet the required connected-peer quorum (connected=$peerCount required=$requiredPeers)."
}

Write-Host "Konofix Node healthy: version=$version peer_id=$peerId uptime=${uptime}s connected_peers=$peerCount required_peers=$requiredPeers snapshot_age=${age}s max_age=${MaxAgeSeconds}s future_skew_limit=${MaxFutureSkewSeconds}s snapshot_bytes=$($snapshotFile.Length) max_snapshot_bytes=$MaxSnapshotBytes"
