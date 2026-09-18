param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$MaxAgeSeconds = 120,

    [int]$MaxFutureSkewSeconds = 30,

    [switch]$RequirePeer,

    [int]$MinConnectedPeers = 0,

    [string]$ExpectedVersion = '',

    [string]$ExpectedPeerId = '',

    [string]$ExpectedSourceCommit = '',

    [int64]$MinUptimeSeconds = 0,

    [int64]$MaxSnapshotBytes = 65536,

    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

function Get-StrictJsonInt64 {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field
    )

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

function Get-StrictJsonString {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field
    )

    if ($Value -isnot [string]) {
        throw "Health snapshot field '$Field' must be a JSON string."
    }
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Health snapshot field '$Field' cannot be empty or whitespace."
    }
    return $Value
}

function Test-OrdinalEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals($Left, $Right, [System.StringComparison]::Ordinal)
}

function Test-SourceCommitFormat {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value -eq 'unknown' -or $Value -cmatch '^[0-9a-f]{40}$'
}

function Read-BoundedSnapshotText {
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotPath,
        [Parameter(Mandatory = $true)][int64]$MaxBytes
    )

    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    try {
        $stream = [System.IO.File]::Open(
            $SnapshotPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            $share
        )
    } catch {
        throw "Health snapshot could not be opened: $($_.Exception.GetBaseException().Message)"
    }

    try {
        if ($stream.Length -gt $MaxBytes) {
            throw "Health snapshot is too large (bytes=$($stream.Length) limit=$MaxBytes)."
        }

        $buffer = [byte[]]::new([int]$MaxBytes + 1)
        $totalRead = 0
        while ($totalRead -lt $buffer.Length) {
            $read = $stream.Read($buffer, $totalRead, $buffer.Length - $totalRead)
            if ($read -eq 0) { break }
            $totalRead += $read
        }
        if ($totalRead -gt $MaxBytes) {
            throw "Health snapshot is too large (bytes>=$totalRead limit=$MaxBytes)."
        }

        try {
            $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
            $text = $utf8.GetString($buffer, 0, $totalRead)
        } catch {
            throw "Health snapshot is not valid UTF-8: $($_.Exception.GetBaseException().Message)"
        }

        return [pscustomobject]@{
            Text = $text
            Bytes = [int64]$totalRead
        }
    } finally {
        $stream.Dispose()
    }
}

if ($MaxAgeSeconds -lt 10 -or $MaxAgeSeconds -gt 86400) { throw 'MaxAgeSeconds must be between 10 and 86400.' }
if ($MaxFutureSkewSeconds -lt 0 -or $MaxFutureSkewSeconds -gt 300) { throw 'MaxFutureSkewSeconds must be between 0 and 300.' }
if ($MinUptimeSeconds -lt 0) { throw 'MinUptimeSeconds cannot be negative.' }
if ($MinConnectedPeers -lt 0) { throw 'MinConnectedPeers cannot be negative.' }
if ($MaxSnapshotBytes -lt 1024 -or $MaxSnapshotBytes -gt 1048576) { throw 'MaxSnapshotBytes must be between 1024 and 1048576.' }
if ($PSBoundParameters.ContainsKey('ExpectedVersion') -and [string]::IsNullOrWhiteSpace($ExpectedVersion)) { throw 'ExpectedVersion cannot be empty or whitespace when explicitly supplied.' }
if ($PSBoundParameters.ContainsKey('ExpectedPeerId') -and [string]::IsNullOrWhiteSpace($ExpectedPeerId)) { throw 'ExpectedPeerId cannot be empty or whitespace when explicitly supplied.' }
if ($PSBoundParameters.ContainsKey('ExpectedSourceCommit')) {
    if ([string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) { throw 'ExpectedSourceCommit cannot be empty or whitespace when explicitly supplied.' }
    if ($ExpectedSourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'ExpectedSourceCommit must be a canonical lowercase 40-character Git commit SHA.' }
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Health snapshot not found: $Path" }
$snapshot = Read-BoundedSnapshotText -SnapshotPath $Path -MaxBytes $MaxSnapshotBytes
$snapshotText = [string]$snapshot.Text
try { $health = $snapshotText | ConvertFrom-Json } catch { throw "Health snapshot is not valid JSON: $($_.Exception.Message)" }

$required = @('schema', 'status', 'version', 'source_commit', 'peer_id', 'uptime_seconds', 'connected_peers', 'timestamp_unix')
foreach ($field in $required) { if ($null -eq $health.$field) { throw "Health snapshot is missing required field: $field" } }

$schema = Get-StrictJsonInt64 -Value $health.schema -Field 'schema'
if ($schema -ne 2) { throw "Unsupported health snapshot schema: $schema" }

$status = Get-StrictJsonString -Value $health.status -Field 'status'
$version = Get-StrictJsonString -Value $health.version -Field 'version'
$sourceCommit = Get-StrictJsonString -Value $health.source_commit -Field 'source_commit'
$peerId = Get-StrictJsonString -Value $health.peer_id -Field 'peer_id'
if (-not (Test-SourceCommitFormat $sourceCommit)) { throw "Health snapshot source_commit is not a canonical lowercase Git SHA or 'unknown': $sourceCommit" }

if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and -not (Test-OrdinalEqual $version $ExpectedVersion)) { throw "Konofix Node version mismatch (expected=$ExpectedVersion actual=$version)." }
if (-not [string]::IsNullOrWhiteSpace($ExpectedPeerId) -and -not (Test-OrdinalEqual $peerId $ExpectedPeerId)) { throw "Konofix Node Peer ID mismatch (expected=$ExpectedPeerId actual=$peerId)." }
if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -and -not (Test-OrdinalEqual $sourceCommit $ExpectedSourceCommit)) { throw "Konofix Node source commit mismatch (expected=$ExpectedSourceCommit actual=$sourceCommit)." }
if (-not (Test-OrdinalEqual $status 'running')) { throw "Konofix Node is not running according to the snapshot (status=$status)." }

$uptime = Get-StrictJsonInt64 -Value $health.uptime_seconds -Field 'uptime_seconds'
if ($uptime -lt 0) { throw 'Node uptime cannot be negative.' }
if ($uptime -lt $MinUptimeSeconds) { throw "Konofix Node uptime is below the required stability window (uptime=${uptime}s required=${MinUptimeSeconds}s)." }

$timestamp = Get-StrictJsonInt64 -Value $health.timestamp_unix -Field 'timestamp_unix'
if ($timestamp -le 0) { throw 'Health snapshot timestamp must be a positive Unix timestamp.' }
if ($uptime -gt $timestamp) { throw "Node uptime is impossible for the snapshot timestamp (uptime=${uptime}s timestamp=${timestamp})." }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$age = $now - $timestamp
if ($age -lt -$MaxFutureSkewSeconds) { throw "Health snapshot timestamp is unexpectedly in the future (age=${age}s, allowed_skew=${MaxFutureSkewSeconds}s)." }
if ($age -gt $MaxAgeSeconds) { throw "Konofix Node health snapshot is stale (age=${age}s, limit=${MaxAgeSeconds}s)." }

$peerCount = Get-StrictJsonInt64 -Value $health.connected_peers -Field 'connected_peers'
if ($peerCount -lt 0) { throw 'Connected peer count cannot be negative.' }
$requiredPeers = $MinConnectedPeers
if ($RequirePeer -and $requiredPeers -lt 1) { $requiredPeers = 1 }
if ($peerCount -lt $requiredPeers) { throw "Konofix Node does not meet the required connected-peer quorum (connected=$peerCount required=$requiredPeers)." }

$result = [ordered]@{
    schema = [int64]$schema
    status = $status
    version = $version
    source_commit = $sourceCommit
    peer_id = $peerId
    uptime_seconds = [int64]$uptime
    connected_peers = [int64]$peerCount
    timestamp_unix = [int64]$timestamp
    snapshot_age_seconds = [int64]$age
    required_peers = [int64]$requiredPeers
    snapshot_bytes = [int64]$snapshot.Bytes
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4 -Compress
    return
}

Write-Host "Konofix Node healthy: version=$version source_commit=$sourceCommit peer_id=$peerId uptime=${uptime}s connected_peers=$peerCount required_peers=$requiredPeers snapshot_age=${age}s max_age=${MaxAgeSeconds}s future_skew_limit=${MaxFutureSkewSeconds}s snapshot_bytes=$($snapshot.Bytes) max_snapshot_bytes=$MaxSnapshotBytes"
