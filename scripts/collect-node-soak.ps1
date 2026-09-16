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

function Invoke-HealthValidation([string]$Path) {
    $args = @{
        Path = $Path
        MaxAgeSeconds = $MaxAgeSeconds
        MaxFutureSkewSeconds = $MaxFutureSkewSeconds
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
        $args.ExpectedVersion = $ExpectedVersion
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPeerId)) {
        $args.ExpectedPeerId = $ExpectedPeerId
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
        $args.ExpectedSourceCommit = $ExpectedSourceCommit
    }
    & $validator @args | Out-Null
}

function Save-ValidatedSnapshot {
    $lastError = $null
    for ($attempt = 1; $attempt -le $ReadAttempts; $attempt++) {
        $scratch = Join-Path $outputFull ('.capture-' + [Guid]::NewGuid().ToString('N') + '.json')
        try {
            if (-not (Test-Path -LiteralPath $healthFull -PathType Leaf)) {
                throw "Health snapshot not found: $healthFull"
            }

            Copy-Item -LiteralPath $healthFull -Destination $scratch -Force
            Invoke-HealthValidation -Path $scratch

            $snapshot = Get-Content -LiteralPath $scratch -Raw | ConvertFrom-Json
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
            Write-Host "Captured validated Node health snapshot: $destination"
            return $true
        } catch {
            $lastError = $_.Exception.Message
            Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
            if ($lastError.StartsWith('Conflicting health snapshots', [StringComparison]::Ordinal)) {
                break
            }
            if ($attempt -lt $ReadAttempts) {
                Start-Sleep -Milliseconds $ReadRetryDelayMilliseconds
            }
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
Write-Host "Node soak collection finished: new_samples=$newSamples duplicates=$duplicates elapsed_seconds=$([Math]::Round($timer.Elapsed.TotalSeconds, 1)) output=$outputFull" -ForegroundColor Green
