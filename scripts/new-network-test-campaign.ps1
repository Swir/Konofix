[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ClientA,
    [Parameter(Mandatory = $true)][string]$ClientB,
    [Parameter(Mandatory = $true)][string]$ClientACountry,
    [Parameter(Mandatory = $true)][string]$ClientBCountry,
    [Parameter(Mandatory = $true)][string]$ClientANetwork,
    [Parameter(Mandatory = $true)][string]$ClientBNetwork,
    [Parameter(Mandatory = $true)][string]$Bootstrap,
    [string]$BuildInfoPath = '',
    [string]$BuildVersion = '',
    [string]$NodeVersion = '',
    [string]$SourceCommit = '',
    [string]$CampaignId = '',
    [string]$OutputDirectory = 'test-results',
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'
$reporter = Join-Path $PSScriptRoot 'new-network-test-report.ps1'
if (-not (Test-Path -LiteralPath $reporter -PathType Leaf)) {
    throw "Network report generator not found: $reporter"
}

function Resolve-BuildIdentity {
    $bundleRoot = Split-Path $PSScriptRoot -Parent
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($BuildInfoPath)) {
        $candidates += [IO.Path]::GetFullPath($BuildInfoPath)
    } else {
        $candidates += (Join-Path $bundleRoot 'BUILD_INFO.json')
        $candidates += (Join-Path (Get-Location) 'BUILD_INFO.json')
    }
    $candidates = @($candidates | Select-Object -Unique)

    $buildInfo = $null
    $resolvedPath = ''
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $raw = Get-Content -LiteralPath $candidate -Raw
            if (-not $raw.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) { throw 'root is not a JSON object' }
            $parsed = $raw | ConvertFrom-Json
            if ($parsed -isnot [pscustomobject]) { throw 'root is not a JSON object' }
            if ([int]$parsed.schema -ne 1) { throw "unsupported schema $($parsed.schema)" }
            if ([string]$parsed.product -cne 'Konofix Chat') { throw "unexpected product '$($parsed.product)'" }
            $version = [string]$parsed.version
            $commit = [string]$parsed.commit
            if ([string]::IsNullOrWhiteSpace($version)) { throw 'version is empty' }
            if ($commit -cnotmatch '^[0-9a-f]{40}$') { throw 'commit is not a canonical lowercase 40-character SHA' }
            $buildInfo = [pscustomobject]@{ version = $version; commit = $commit }
            $resolvedPath = $candidate
            break
        } catch {
            if (-not [string]::IsNullOrWhiteSpace($BuildInfoPath)) {
                throw "BUILD_INFO is invalid: $candidate`n$($_.Exception.Message)"
            }
        }
    }

    $resolvedBuildVersion = $BuildVersion.Trim()
    $resolvedNodeVersion = $NodeVersion.Trim()
    $resolvedSourceCommit = $SourceCommit.Trim().ToLowerInvariant()

    if ($null -ne $buildInfo) {
        if (-not [string]::IsNullOrWhiteSpace($resolvedBuildVersion) -and $resolvedBuildVersion -cne $buildInfo.version) {
            throw "BuildVersion '$resolvedBuildVersion' does not match verified BUILD_INFO version '$($buildInfo.version)'."
        }
        if (-not [string]::IsNullOrWhiteSpace($resolvedNodeVersion) -and $resolvedNodeVersion -cne $buildInfo.version) {
            throw "NodeVersion '$resolvedNodeVersion' does not match verified BUILD_INFO version '$($buildInfo.version)'."
        }
        if (-not [string]::IsNullOrWhiteSpace($resolvedSourceCommit) -and $resolvedSourceCommit -cne $buildInfo.commit) {
            throw "SourceCommit '$resolvedSourceCommit' does not match verified BUILD_INFO commit '$($buildInfo.commit)'."
        }
        $resolvedBuildVersion = $buildInfo.version
        $resolvedNodeVersion = $buildInfo.version
        $resolvedSourceCommit = $buildInfo.commit
    }

    if ([string]::IsNullOrWhiteSpace($resolvedBuildVersion) -or $resolvedBuildVersion -ceq 'unknown') {
        throw 'Could not determine BuildVersion. Run from the verified Windows test bundle containing BUILD_INFO.json or pass an exact BuildVersion.'
    }
    if ([string]::IsNullOrWhiteSpace($resolvedNodeVersion) -or $resolvedNodeVersion -ceq 'unknown') {
        throw 'Could not determine NodeVersion. Run from the verified Windows test bundle containing BUILD_INFO.json or pass an exact NodeVersion.'
    }
    if ($resolvedSourceCommit -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Could not determine SourceCommit. Run from the verified Windows test bundle containing BUILD_INFO.json or pass the exact lowercase 40-character SHA.'
    }

    return [pscustomobject]@{
        BuildVersion = $resolvedBuildVersion
        NodeVersion = $resolvedNodeVersion
        SourceCommit = $resolvedSourceCommit
        BuildInfoPath = $resolvedPath
    }
}

$identity = Resolve-BuildIdentity

if ([string]::IsNullOrWhiteSpace($CampaignId)) {
    $CampaignId = [Guid]::NewGuid().ToString('N').ToLowerInvariant()
} else {
    $CampaignId = $CampaignId.Trim().ToLowerInvariant()
    if ($CampaignId -cnotmatch '^[0-9a-f]{32}$') {
        throw 'CampaignId must be a canonical lowercase 32-character hexadecimal identifier.'
    }
}

$campaignDirectory = Join-Path $OutputDirectory ("campaign-$CampaignId")
if (Test-Path -LiteralPath $campaignDirectory) {
    $existing = @(Get-ChildItem -LiteralPath $campaignDirectory -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        throw "Campaign output directory is not empty: $campaignDirectory"
    }
}
New-Item -ItemType Directory -Force -Path $campaignDirectory | Out-Null

$common = @{
    ClientA = $ClientA
    ClientB = $ClientB
    ClientACountry = $ClientACountry
    ClientBCountry = $ClientBCountry
    ClientANetwork = $ClientANetwork
    ClientBNetwork = $ClientBNetwork
    Bootstrap = $Bootstrap
    BuildVersion = $identity.BuildVersion
    NodeVersion = $identity.NodeVersion
    SourceCommit = $identity.SourceCommit
    CampaignId = $CampaignId
    OutputDirectory = $campaignDirectory
    Notes = $Notes
}

$scenarios = @('TCP','QUIC','Relay','DCUtR','CGNAT')
try {
    foreach ($scenario in $scenarios) {
        & $reporter -Scenario $scenario @common
    }

    $manifests = @(Get-ChildItem -LiteralPath $campaignDirectory -Filter '*.json' -File | Sort-Object Name)
    if ($manifests.Count -ne $scenarios.Count) {
        throw "Campaign generation expected $($scenarios.Count) manifests but found $($manifests.Count)."
    }

    $observedScenarios = @()
    foreach ($manifest in $manifests) {
        $data = Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json
        if ([string]$data.campaign_id -cne $CampaignId) {
            throw "Generated manifest has a mismatched campaign_id: $($manifest.FullName)"
        }
        if ([string]$data.build_version -cne $identity.BuildVersion -or [string]$data.node_version -cne $identity.NodeVersion -or [string]$data.source_commit -cne $identity.SourceCommit) {
            throw "Generated manifest lost verified build identity: $($manifest.FullName)"
        }
        $observedScenarios += [string]$data.scenario
    }
    foreach ($scenario in $scenarios) {
        if ($observedScenarios -cnotcontains $scenario) { throw "Campaign is missing generated scenario: $scenario" }
    }
} catch {
    Remove-Item -LiteralPath $campaignDirectory -Recurse -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host '=== Konofix Real-Network Test Campaign ===' -ForegroundColor Cyan
Write-Host "Campaign ID:  $CampaignId"
Write-Host "Build version: $($identity.BuildVersion)"
Write-Host "Node version:  $($identity.NodeVersion)"
Write-Host "Source commit: $($identity.SourceCommit)"
if (-not [string]::IsNullOrWhiteSpace($identity.BuildInfoPath)) { Write-Host "BUILD_INFO:    $($identity.BuildInfoPath)" }
Write-Host "Directory:     $campaignDirectory"
Write-Host "Scenarios:     $($scenarios -join ', ')"
Write-Host 'All scenario reports start as PENDING. Record only observations from this same client pair/session and never copy PASS values from another campaign.' -ForegroundColor Yellow
