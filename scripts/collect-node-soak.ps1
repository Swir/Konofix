[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HealthFile,

    [string]$OutputDirectory = '',

    [ValidateRange(5, 3600)]
    [int]$IntervalSeconds = 60,

    [ValidateRange(1, 604800)]
    [int]$DurationSeconds = 3600,

    [ValidateRange(10, 86400)]
    [int]$MaxAgeSeconds = 120,

    [ValidateRange(0, 300)]
    [int]$MaxFutureSkewSeconds = 30,

    [ValidateRange(1, 10)]
    [int]$ReadAttempts = 3,

    [ValidateRange(10, 5000)]
    [int]$ReadRetryDelayMilliseconds = 250,

    [string]$ExpectedVersion = '',
    [string]$ExpectedPeerId = '',
    [string]$ExpectedSourceCommit = '',

    [string]$BuildInfoPath = '',
    [string]$NodeBinaryPath = '',

    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$validator = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    throw "Node health validator not found: $validator"
}

function Get-FullPath([string]$Value, [string]$Label) {
    try {
        return [IO.Path]::GetFullPath($Value)
    } catch {
        throw "Invalid $Label path '$Value': $($_.Exception.Message)"
    }
}

function Get-RequiredString($Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        throw "$Label is missing required string field '$Name'."
    }
    return [string]$property.Value
}

$healthFull = Get-FullPath $HealthFile 'health file'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'evidence\node-soak'
}
$outputFull = Get-FullPath $OutputDirectory 'output directory'

if ([StringComparer]::OrdinalIgnoreCase.Equals($healthFull, $outputFull)) {
    throw 'Health file and output directory cannot use the same path.'
}
if (Test-Path -LiteralPath $outputFull -PathType Leaf) {
    throw "Output directory path points to a file: $outputFull"
}
New-Item -ItemType Directory -Force -Path $outputFull | Out-Null

$bindingRequested = -not [string]::IsNullOrWhiteSpace($BuildInfoPath) -or -not [string]::IsNullOrWhiteSpace($NodeBinaryPath)
if ($bindingRequested -and ([string]::IsNullOrWhiteSpace($BuildInfoPath) -or [string]::IsNullOrWhiteSpace($NodeBinaryPath))) {
    throw 'Exact-build soak capture requires both BuildInfoPath and NodeBinaryPath.'
}

$binding = $null
if ($bindingRequested) {
    $buildInfoFull = Get-FullPath $BuildInfoPath 'BUILD_INFO file'
    $nodeBinaryFull = Get-FullPath $NodeBinaryPath 'Node binary'
    if (-not (Test-Path -LiteralPath $buildInfoFull -PathType Leaf)) { throw "BUILD_INFO file not found: $buildInfoFull" }
    if (-not (Test-Path -LiteralPath $nodeBinaryFull -PathType Leaf)) { throw "Node binary not found: $nodeBinaryFull" }
    try { $buildInfo = Get-Content -LiteralPath $buildInfoFull -Raw | ConvertFrom-Json } catch { throw "BUILD_INFO is not valid JSON: $($_.Exception.Message)" }
    if ($buildInfo -isnot [pscustomobject]) { throw 'BUILD_INFO root must be a JSON object.' }
    $buildVersion = Get-RequiredString $buildInfo 'version' 'BUILD_INFO'
    $buildCommit = Get-RequiredString $buildInfo 'commit' 'BUILD_INFO'
    if ($buildCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'BUILD_INFO commit must be a canonical lowercase 40-character Git SHA.' }
    if ($null -eq $buildInfo.node -or $buildInfo.node -isnot [pscustomobject]) { throw 'BUILD_INFO node metadata must be a JSON object.' }
    $expectedNodeHash = Get-RequiredString $buildInfo.node 'sha256' 'BUILD_INFO node metadata'
    if ($expectedNodeHash -cnotmatch '^[0-9a-f]{64}$') { throw 'BUILD_INFO node.sha256 must be a canonical lowercase SHA-256.' }
    if ($null -eq $buildInfo.node.bytes) { throw 'BUILD_INFO node metadata is missing bytes.' }
    try { $expectedNodeBytes = [Convert]::ToInt64($buildInfo.node.bytes, [Globalization.CultureInfo]::InvariantCulture) } catch { throw 'BUILD_INFO node.bytes must be a signed 64-bit integer.' }
    $nodeItem = Get-Item -LiteralPath $nodeBinaryFull
    if ([int64]$nodeItem.Length -ne $expectedNodeBytes) { throw "Node binary size does not match BUILD_INFO (expected=$expectedNodeBytes actual=$($nodeItem.Length))." }
    $actualNodeHash = (Get-FileHash -LiteralPath $nodeBinaryFull -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($actualNodeHash, $expectedNodeHash, [StringComparison]::Ordinal)) { throw "Node binary SHA-256 does not match BUILD_INFO (expected=$expectedNodeHash actual=$actualNodeHash)." }
    $buildInfoHash = (Get-FileHash -LiteralPath $buildInfoFull -Algorithm SHA256).Hash.ToLowerInvariant()
    $binding = [pscustomobject]@{
        version = $buildVersion
        commit = $buildCommit
        node_sha256 = $actualNodeHash
        build_info_sha256 = $buildInfoHash
    }
}

function Invoke-HealthValidation([string]$Path) {
    $args = @{
        Path = $Path
        MaxAgeSeconds = $MaxAgeSeconds
        MaxFutureSkewSeconds = $MaxFutureSkewSeconds
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) { $args.ExpectedVersion = $ExpectedVersion }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPeerId)) { $args.ExpectedPeerId = $ExpectedPeerId }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) { $args.ExpectedSourceCommit = $ExpectedSourceCommit }
    & $validator @args | Out-Null
}

function Save-ValidatedSnapshot {
    $lastError = $null
    for ($attempt = 1; $attempt -le $ReadAttempts; $attempt++) {
        $scratch = Join-Path $outputFull ('.capture-' + [Guid]::NewGuid().ToString('N') + '.json')
        try {
            if (-not (Test-Path -LiteralPath $healthFull -PathType Leaf)) { throw "Health snapshot not found: $healthFull" }

            Copy-Item -LiteralPath $healthFull -Destination $scratch -Force
            Invoke-HealthValidation -Path $scratch

            $snapshot = Get-Content -LiteralPath $scratch -Raw | ConvertFrom-Json
            if ($null -ne $binding) {
                $snapshotVersion = [string]$snapshot.version
                $snapshotCommit = [string]$snapshot.source_commit
                if (-not [string]::Equals($snapshotVersion, $binding.version, [StringComparison]::Ordinal)) {
                    throw "Health snapshot version does not match BUILD_INFO (snapshot=$snapshotVersion build=$($binding.version))."
                }
                if (-not [string]::Equals($snapshotCommit, $binding.commit, [StringComparison]::Ordinal)) {
                    throw "Health snapshot source commit does not match BUILD_INFO (snapshot=$snapshotCommit build=$($binding.commit))."
                }
                $snapshot | Add-Member -NotePropertyName evidence_binding_schema -NotePropertyValue 1 -Force
                $snapshot | Add-Member -NotePropertyName node_binary_sha256 -NotePropertyValue $binding.node_sha256 -Force
                $snapshot | Add-Member -NotePropertyName build_info_sha256 -NotePropertyValue $binding.build_info_sha256 -Force
                $snapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $scratch -Encoding UTF8
            }

            $timestamp = [Convert]::ToInt64($snapshot.timestamp_unix, [Globalization.CultureInfo]::InvariantCulture)
            $peerText = [string]$snapshot.peer_id
            $peerSafe = $peerText -replace '[^A-Za-z0-9]', ''
            if ([string]::IsNullOrWhiteSpace($peerSafe)) { $peerSafe = 'peer' }
            if ($peerSafe.Length -gt 16) { $peerSafe = $peerSafe.Substring(0, 16) }
            $destination = Join-Path $outputFull ("{0}-{1}.json" -f $timestamp, $peerSafe)

            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $candidateHash = (Get-FileHash -LiteralPath $scratch -Algorithm SHA256).Hash
                $existingHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
                Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
                if ([string]::Equals($candidateHash, $existingHash, [StringComparison]::OrdinalIgnoreCase)) {
                    Write-Host "Duplicate health snapshot skipped: $destination"
                    return $false
                }
                throw "Conflicting health snapshots share timestamp $timestamp. Existing evidence was not overwritten: $destination"
            }

            Move-Item -LiteralPath $scratch -Destination $destination
            $bindingLabel = if ($null -ne $binding) { ' exact-build-bound=true' } else { '' }
            Write-Host "Captured validated Node health snapshot: $destination$bindingLabel"
            return $true
        } catch {
            $lastError = $_.Exception.Message
            Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
            if ($lastError.StartsWith('Conflicting health snapshots', [StringComparison]::Ordinal)) { break }
            if ($attempt -lt $ReadAttempts) { Start-Sleep -Milliseconds $ReadRetryDelayMilliseconds }
        }
    }

    throw "Could not capture a valid Node health snapshot after $ReadAttempts attempt(s): $lastError"
}

$timer = [Diagnostics.Stopwatch]::StartNew()
$newSamples = 0
$duplicates = 0

while ($true) {
    if (Save-ValidatedSnapshot) { $newSamples++ } else { $duplicates++ }

    if ($Once) { break }
    if ($timer.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

$timer.Stop()
Write-Host "Node soak collection finished: new_samples=$newSamples duplicates=$duplicates elapsed_seconds=$([Math]::Round($timer.Elapsed.TotalSeconds, 1)) output=$outputFull exact_build_binding=$($null -ne $binding)" -ForegroundColor Green
