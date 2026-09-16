param(
    [Parameter(Mandatory = $true)]
    [string[]]$Snapshot,

    [int]$MinSpanSeconds = 3600,

    [int]$MaxGapSeconds = 180,

    [int]$MaxAgeSeconds = 300,

    [int]$MaxFutureSkewSeconds = 30,

    [int]$UptimeToleranceSeconds = 15,

    [int]$MinConnectedPeers = 0,

    [switch]$RequirePeerObserved,

    [string]$ExpectedVersion = '',

    [string]$ExpectedPeerId = '',

    [int64]$MaxSnapshotBytes = 65536
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
        throw "Node soak field '$Field' must be a JSON integer."
    }
    try {
        return [Convert]::ToInt64($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        throw "Node soak field '$Field' is outside the supported signed 64-bit integer range."
    }
}

function Get-StrictJsonString {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field
    )

    if ($Value -isnot [string]) { throw "Node soak field '$Field' must be a JSON string." }
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "Node soak field '$Field' cannot be empty or whitespace." }
    return $Value
}

function Test-OrdinalEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    return [string]::Equals($Left, $Right, [System.StringComparison]::Ordinal)
}

if ($Snapshot.Count -lt 2) { throw 'Node soak validation requires at least two health snapshots.' }
if ($MinSpanSeconds -lt 60 -or $MinSpanSeconds -gt 604800) { throw 'MinSpanSeconds must be between 60 and 604800.' }
if ($MaxGapSeconds -lt 10 -or $MaxGapSeconds -gt 86400) { throw 'MaxGapSeconds must be between 10 and 86400.' }
if ($MaxAgeSeconds -lt 10 -or $MaxAgeSeconds -gt 86400) { throw 'MaxAgeSeconds must be between 10 and 86400.' }
if ($MaxFutureSkewSeconds -lt 0 -or $MaxFutureSkewSeconds -gt 300) { throw 'MaxFutureSkewSeconds must be between 0 and 300.' }
if ($UptimeToleranceSeconds -lt 0 -or $UptimeToleranceSeconds -gt 300) { throw 'UptimeToleranceSeconds must be between 0 and 300.' }
if ($MinConnectedPeers -lt 0) { throw 'MinConnectedPeers cannot be negative.' }
if ($MaxSnapshotBytes -lt 1024 -or $MaxSnapshotBytes -gt 1048576) { throw 'MaxSnapshotBytes must be between 1024 and 1048576.' }
if ($PSBoundParameters.ContainsKey('ExpectedVersion') -and [string]::IsNullOrWhiteSpace($ExpectedVersion)) { throw 'ExpectedVersion cannot be empty or whitespace when explicitly supplied.' }
if ($PSBoundParameters.ContainsKey('ExpectedPeerId') -and [string]::IsNullOrWhiteSpace($ExpectedPeerId)) { throw 'ExpectedPeerId cannot be empty or whitespace when explicitly supplied.' }

$samples = @()
foreach ($path in $Snapshot) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Node soak snapshot not found: $path" }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -gt $MaxSnapshotBytes) { throw "Node soak snapshot is too large: $path (bytes=$($file.Length) limit=$MaxSnapshotBytes)." }

    try { $health = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { throw "Node soak snapshot is not valid JSON: $path - $($_.Exception.Message)" }
    $required = @('schema', 'status', 'version', 'peer_id', 'uptime_seconds', 'connected_peers', 'timestamp_unix')
    foreach ($field in $required) { if ($null -eq $health.$field) { throw "Node soak snapshot is missing required field '$field': $path" } }

    $schema = Get-StrictJsonInt64 -Value $health.schema -Field 'schema'
    if ($schema -ne 1) { throw "Unsupported Node health snapshot schema: $schema" }

    $status = Get-StrictJsonString -Value $health.status -Field 'status'
    $version = Get-StrictJsonString -Value $health.version -Field 'version'
    $peerId = Get-StrictJsonString -Value $health.peer_id -Field 'peer_id'
    if (-not (Test-OrdinalEqual $status 'running')) { throw "Node soak snapshot is not running: $path (status=$status)." }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and -not (Test-OrdinalEqual $version $ExpectedVersion)) { throw "Node soak version mismatch (expected=$ExpectedVersion actual=$version)." }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPeerId) -and -not (Test-OrdinalEqual $peerId $ExpectedPeerId)) { throw "Node soak Peer ID mismatch (expected=$ExpectedPeerId actual=$peerId)." }

    $uptime = Get-StrictJsonInt64 -Value $health.uptime_seconds -Field 'uptime_seconds'
    $peers = Get-StrictJsonInt64 -Value $health.connected_peers -Field 'connected_peers'
    $timestamp = Get-StrictJsonInt64 -Value $health.timestamp_unix -Field 'timestamp_unix'
    if ($uptime -lt 0) { throw 'Node soak uptime cannot be negative.' }
    if ($peers -lt 0) { throw 'Node soak connected peer count cannot be negative.' }
    if ($timestamp -le 0) { throw 'Node soak timestamp must be a positive Unix timestamp.' }
    if ($uptime -gt $timestamp) { throw "Node soak uptime is impossible for snapshot timestamp (uptime=${uptime}s timestamp=${timestamp})." }
    if ($peers -lt $MinConnectedPeers) { throw "Node soak peer quorum failed (connected=$peers required=$MinConnectedPeers)." }

    $samples += [pscustomobject]@{
        path = $path
        version = $version
        peer_id = $peerId
        uptime = $uptime
        peers = $peers
        timestamp = $timestamp
    }
}

$ordered = @($samples | Sort-Object timestamp)
$versions = @($ordered | ForEach-Object version | Sort-Object -Unique -CaseSensitive)
$peerIds = @($ordered | ForEach-Object peer_id | Sort-Object -Unique -CaseSensitive)
if ($versions.Count -ne 1) { throw "Node soak snapshots contain multiple versions: $($versions -join ', ')" }
if ($peerIds.Count -ne 1) { throw "Node soak snapshots contain multiple Peer IDs: $($peerIds -join ', ')" }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$latest = $ordered[-1]
$latestAge = $now - $latest.timestamp
if ($latestAge -lt -$MaxFutureSkewSeconds) { throw "Latest Node soak snapshot is unexpectedly in the future (age=${latestAge}s allowed_skew=${MaxFutureSkewSeconds}s)." }
if ($latestAge -gt $MaxAgeSeconds) { throw "Latest Node soak snapshot is stale (age=${latestAge}s limit=${MaxAgeSeconds}s)." }

$span = $ordered[-1].timestamp - $ordered[0].timestamp
if ($span -lt $MinSpanSeconds) { throw "Node soak window is too short (span=${span}s required=${MinSpanSeconds}s)." }

$peerObserved = $false
for ($i = 0; $i -lt $ordered.Count; $i++) {
    $sample = $ordered[$i]
    if ($sample.peers -gt 0) { $peerObserved = $true }
    if (($now - $sample.timestamp) -lt -$MaxFutureSkewSeconds) { throw "Node soak snapshot is unexpectedly in the future: $($sample.path)" }
    if ($i -eq 0) { continue }

    $previous = $ordered[$i - 1]
    $timestampDelta = $sample.timestamp - $previous.timestamp
    $uptimeDelta = $sample.uptime - $previous.uptime
    if ($timestampDelta -le 0) { throw 'Node soak timestamps must be strictly increasing and unique.' }
    if ($timestampDelta -gt $MaxGapSeconds) { throw "Node soak sample gap is too large (gap=${timestampDelta}s limit=${MaxGapSeconds}s)." }
    if ($uptimeDelta -lt 0) { throw "Node restart detected inside soak window (uptime $($previous.uptime) -> $($sample.uptime))." }
    if ([Math]::Abs($uptimeDelta - $timestampDelta) -gt $UptimeToleranceSeconds) {
        throw "Node uptime continuity does not match snapshot cadence (timestamp_delta=${timestampDelta}s uptime_delta=${uptimeDelta}s tolerance=${UptimeToleranceSeconds}s)."
    }
}

if ($RequirePeerObserved -and -not $peerObserved) { throw 'Node soak evidence never observed a connected peer.' }

Write-Host "Konofix Node soak healthy: version=$($versions[0]) peer_id=$($peerIds[0]) samples=$($ordered.Count) span=${span}s max_gap=${MaxGapSeconds}s latest_age=${latestAge}s peer_observed=$peerObserved"
