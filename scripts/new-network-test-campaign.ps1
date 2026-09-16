[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ClientA,
    [Parameter(Mandatory = $true)][string]$ClientB,
    [Parameter(Mandatory = $true)][string]$ClientACountry,
    [Parameter(Mandatory = $true)][string]$ClientBCountry,
    [Parameter(Mandatory = $true)][string]$ClientANetwork,
    [Parameter(Mandatory = $true)][string]$ClientBNetwork,
    [Parameter(Mandatory = $true)][string]$Bootstrap,
    [string]$BuildVersion = 'unknown',
    [string]$NodeVersion = 'unknown',
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
    BuildVersion = $BuildVersion
    NodeVersion = $NodeVersion
    SourceCommit = $SourceCommit
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
Write-Host "Campaign ID: $CampaignId"
Write-Host "Directory:   $campaignDirectory"
Write-Host "Scenarios:   $($scenarios -join ', ')"
Write-Host 'All scenario reports start as PENDING. Record only observations from this same client pair/session and never copy PASS values from another campaign.' -ForegroundColor Yellow
