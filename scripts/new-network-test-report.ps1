param(
    [Parameter(Mandatory = $true)][ValidateSet('LAN','TCP','QUIC','Relay','DCUtR','CGNAT')][string]$Scenario,
    [Parameter(Mandatory = $true)][string]$ClientA,
    [Parameter(Mandatory = $true)][string]$ClientB,
    [Parameter(Mandatory = $true)][string]$Bootstrap,
    [string]$ClientACountry = '',
    [string]$ClientBCountry = '',
    [string]$ClientANetwork = '',
    [string]$ClientBNetwork = '',
    [string]$BuildVersion = 'unknown',
    [string]$NodeVersion = 'unknown',
    [string]$SourceCommit = '',
    [string]$CampaignId = '',
    [string]$OutputDirectory = 'test-results',
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'

function Get-CanonicalSourceCommit {
    param([string]$ExplicitCommit)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitCommit)) {
        $candidate = $ExplicitCommit.Trim().ToLowerInvariant()
        if ($candidate -cnotmatch '^[0-9a-f]{40}$') { throw 'SourceCommit must be a full 40-character Git commit SHA.' }
        return $candidate
    }

    $bundleRoot = Split-Path $PSScriptRoot -Parent
    $buildInfoCandidates = @(
        (Join-Path $bundleRoot 'BUILD_INFO.json'),
        (Join-Path (Get-Location) 'BUILD_INFO.json')
    ) | Select-Object -Unique
    foreach ($buildInfoPath in $buildInfoCandidates) {
        if (-not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) { continue }
        try {
            $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
            $candidate = ([string]$buildInfo.commit).Trim().ToLowerInvariant()
            if ($candidate -cmatch '^[0-9a-f]{40}$') { return $candidate }
        } catch {}
    }

    if (Get-Command git -ErrorAction SilentlyContinue) {
        try {
            $repoRoot = Split-Path $PSScriptRoot -Parent
            $candidate = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
            if ($LASTEXITCODE -eq 0 -and $candidate -cmatch '^[0-9a-f]{40}$') { return $candidate }
        } catch {}
    }

    throw 'Could not determine the exact source commit. Run this tool from the verified Windows test bundle containing BUILD_INFO.json or pass -SourceCommit explicitly.'
}

function Get-CanonicalCampaignId {
    param([string]$ExplicitCampaignId)

    if ([string]::IsNullOrWhiteSpace($ExplicitCampaignId)) {
        return [Guid]::NewGuid().ToString('N').ToLowerInvariant()
    }
    $candidate = $ExplicitCampaignId.Trim().ToLowerInvariant()
    if ($candidate -cnotmatch '^[0-9a-f]{32}$') {
        throw 'CampaignId must be a canonical lowercase 32-character hexadecimal identifier.'
    }
    return $candidate
}

if ($Bootstrap -notmatch '^/(ip4|ip6|dns|dns4|dns6)/.+/p2p/[A-Za-z0-9]+$') {
    throw 'Bootstrap must be a complete libp2p multiaddress ending in /p2p/<PeerId>.'
}
if ($ClientA.Trim().ToLowerInvariant() -eq $ClientB.Trim().ToLowerInvariant()) { throw 'Client A and Client B must identify different endpoints.' }
if ($Scenario -ne 'LAN') {
    foreach ($value in @($ClientACountry,$ClientBCountry,$ClientANetwork,$ClientBNetwork)) {
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Internet scenarios require both client countries and network/operator identifiers.' }
    }
    if ($ClientACountry.Trim().ToLowerInvariant() -eq $ClientBCountry.Trim().ToLowerInvariant()) { throw 'Internet scenarios require clients in different countries.' }
    if ($ClientANetwork.Trim().ToLowerInvariant() -eq $ClientBNetwork.Trim().ToLowerInvariant()) { throw 'Internet scenarios require independent networks/operators.' }
}

$resolvedCommit = Get-CanonicalSourceCommit -ExplicitCommit $SourceCommit
$resolvedCampaignId = Get-CanonicalCampaignId -ExplicitCampaignId $CampaignId
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$now = [DateTimeOffset]::UtcNow
$stamp = $now.ToString('yyyyMMdd-HHmmss')
$baseName = "network-test-$($Scenario.ToLowerInvariant())-$stamp"
$markdownPath = Join-Path $OutputDirectory "$baseName.md"
$jsonPath = Join-Path $OutputDirectory "$baseName.json"

$checks = [ordered]@{
    world_a_to_b = 'PENDING'; world_b_to_a = 'PENDING'; room_discovery = 'PENDING'
    file_a_to_b_sha256 = 'PENDING'; file_b_to_a_sha256 = 'PENDING'; client_reconnect = 'PENDING'
    node_restart_recovery = 'PENDING'; relay_observed = 'PENDING'; dcutr_direct_upgrade = 'PENDING'
    nickname_conflict = 'PENDING'
}

$manifest = [ordered]@{
    schema_version = 3; campaign_id = $resolvedCampaignId; created_utc = $now.ToString('o'); scenario = $Scenario
    build_version = $BuildVersion; node_version = $NodeVersion; source_commit = $resolvedCommit
    client_a = $ClientA; client_b = $ClientB
    client_a_country = $ClientACountry; client_b_country = $ClientBCountry
    client_a_network = $ClientANetwork; client_b_network = $ClientBNetwork
    bootstrap = $Bootstrap; notes = $Notes; overall = 'PENDING'; checks = $checks
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$body = @"
# Konofix Network Test Report

- UTC: $($now.ToString('u'))
- Campaign ID: ``$resolvedCampaignId``
- Scenario: $Scenario
- Build version: $BuildVersion
- Node version: $NodeVersion
- Source commit: ``$resolvedCommit``
- Client A: $ClientA — $ClientACountry / $ClientANetwork
- Client B: $ClientB — $ClientBCountry / $ClientBNetwork
- Bootstrap: ``$Bootstrap``
- Machine-readable manifest: ``$([IO.Path]::GetFileName($jsonPath))``
- Notes: $Notes

## Preconditions

- [ ] Windows build version recorded
- [ ] Exact source commit matches BUILD_INFO.json
- [ ] Campaign ID is shared by every required Internet scenario
- [ ] Public Node health check passed for the same source commit
- [ ] Bootstrap precheck passed from Client A
- [ ] Bootstrap precheck passed from Client B
- [ ] Node Peer ID is stable after restart
- [ ] Countries and independent networks/operators recorded

## Results

| Check | Result | Evidence / notes |
| --- | --- | --- |
| A -> B #WORLD message | PENDING | |
| B -> A #WORLD message | PENDING | |
| Room discovery | PENDING | |
| A -> B file + SHA-256 | PENDING | |
| B -> A file + SHA-256 | PENDING | |
| Client reconnect | PENDING | |
| Node restart recovery | PENDING | |
| Relay observed | PENDING | |
| DCUtR/direct upgrade observed | PENDING | |
| Nickname conflict handling | PENDING | |

## Outcome

Overall: **PENDING**

Record PASS/FAIL and enough evidence to reproduce failures. Keep the JSON manifest in sync with this report. Do not include identity keys, tokens, private addresses, or other secrets.
"@
Set-Content -LiteralPath $markdownPath -Value $body -Encoding UTF8
Write-Host "Created network test report: $markdownPath"
Write-Host "Created network test manifest: $jsonPath"
Write-Host "Evidence campaign ID: $resolvedCampaignId"
Write-Host "Evidence source commit: $resolvedCommit"
