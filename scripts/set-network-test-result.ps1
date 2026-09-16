[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,

    [Parameter(Mandatory = $true)]
    [ValidateSet('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','relay_observed','dcutr_direct_upgrade','nickname_conflict')]
    [string]$Check,

    [Parameter(Mandatory = $true)]
    [ValidateSet('PASS','FAIL','PENDING','N/A')]
    [string]$Result,

    [ValidateLength(0, 2000)]
    [string]$Evidence = '',

    [switch]$AllowOverwrite,
    [switch]$Finalize
)

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-network-test-report.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    throw "Network evidence validator not found: $validator"
}

$manifestFull = [IO.Path]::GetFullPath($Manifest)
if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) {
    throw "Network test manifest not found: $manifestFull"
}

try {
    $data = Get-Content -LiteralPath $manifestFull -Raw | ConvertFrom-Json
} catch {
    throw "Network test manifest is not valid JSON: $($_.Exception.Message)"
}

if ($data.schema_version -ne 3) { throw "Unsupported network evidence schema: $($data.schema_version)" }
if ($null -eq $data.checks) { throw 'Network test manifest is missing the checks object.' }
$checkProperty = $data.checks.PSObject.Properties[$Check]
if ($null -eq $checkProperty) { throw "Network test manifest is missing check '$Check'." }

if (($Result -eq 'PASS' -or $Result -eq 'FAIL') -and [string]::IsNullOrWhiteSpace($Evidence)) {
    throw "Recording $Result for '$Check' requires a non-empty evidence note."
}
if ($Result -eq 'PASS' -and $Check -in @('file_a_to_b_sha256','file_b_to_a_sha256') -and $Evidence -cnotmatch '(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])') {
    throw "Recording PASS for '$Check' requires the observed 64-character SHA-256 digest in -Evidence."
}

$oldResult = [string]$checkProperty.Value
if ($oldResult -notin @('PASS','FAIL','PENDING','N/A')) {
    throw "Network test manifest contains invalid current result '$oldResult' for '$Check'."
}
if ($oldResult -ne 'PENDING' -and $oldResult -ne $Result -and -not $AllowOverwrite) {
    throw "Check '$Check' is already '$oldResult'. Use -AllowOverwrite to replace recorded evidence deliberately."
}

$checkProperty.Value = $Result
if ($null -eq $data.PSObject.Properties['check_evidence']) {
    $data | Add-Member -NotePropertyName check_evidence -NotePropertyValue ([pscustomobject]@{})
}
$evidenceProperty = $data.check_evidence.PSObject.Properties[$Check]
if ($null -eq $evidenceProperty) {
    $data.check_evidence | Add-Member -NotePropertyName $Check -NotePropertyValue $Evidence
} else {
    $evidenceProperty.Value = $Evidence
}

$coreChecks = @(
    'world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256',
    'file_b_to_a_sha256','client_reconnect','node_restart_recovery','nickname_conflict'
)
$scenarioChecks = @()
switch ([string]$data.scenario) {
    'Relay' { $scenarioChecks = @('relay_observed') }
    'CGNAT' { $scenarioChecks = @('relay_observed') }
    'DCUtR' { $scenarioChecks = @('dcutr_direct_upgrade') }
}
$promotionChecks = @($coreChecks + $scenarioChecks | Select-Object -Unique)
$promotionResults = @($promotionChecks | ForEach-Object {
    $property = $data.checks.PSObject.Properties[$_]
    if ($null -eq $property) { throw "Network test manifest is missing promotion check '$_'." }
    [string]$property.Value
})

if (@($promotionResults | Where-Object { $_ -eq 'FAIL' }).Count -gt 0) {
    $data.overall = 'FAIL'
} elseif (@($promotionResults | Where-Object { $_ -ne 'PASS' }).Count -eq 0) {
    $data.overall = 'PASS'
} else {
    $data.overall = 'PENDING'
}

if ($Finalize -and $data.overall -ne 'PASS') {
    $remaining = @()
    for ($i = 0; $i -lt $promotionChecks.Count; $i++) {
        if ($promotionResults[$i] -ne 'PASS') { $remaining += "$($promotionChecks[$i])=$($promotionResults[$i])" }
    }
    throw "Cannot finalize network evidence until all promotion checks pass. Remaining: $($remaining -join ', ')"
}

function Escape-MarkdownCell([string]$Value) {
    if ($null -eq $Value) { return '' }
    return ($Value -replace '\|', '\|' -replace "`r?`n", '<br>')
}

$labels = [ordered]@{
    world_a_to_b = 'A -> B #WORLD message'
    world_b_to_a = 'B -> A #WORLD message'
    room_discovery = 'Room discovery'
    file_a_to_b_sha256 = 'A -> B file + SHA-256'
    file_b_to_a_sha256 = 'B -> A file + SHA-256'
    client_reconnect = 'Client reconnect'
    node_restart_recovery = 'Node restart recovery'
    relay_observed = 'Relay observed'
    dcutr_direct_upgrade = 'DCUtR/direct upgrade observed'
    nickname_conflict = 'Nickname conflict handling'
}

$rows = foreach ($name in $labels.Keys) {
    $resultValue = [string]$data.checks.PSObject.Properties[$name].Value
    $noteProperty = if ($null -ne $data.PSObject.Properties['check_evidence']) { $data.check_evidence.PSObject.Properties[$name] } else { $null }
    $note = if ($null -ne $noteProperty) { [string]$noteProperty.Value } else { '' }
    "| $($labels[$name]) | $resultValue | $(Escape-MarkdownCell $note) |"
}

$markdown = @"
# Konofix Network Test Report

- UTC: $($data.created_utc)
- Scenario: $($data.scenario)
- Build version: $($data.build_version)
- Node version: $($data.node_version)
- Source commit: ``$($data.source_commit)``
- Client A: $($data.client_a) — $($data.client_a_country) / $($data.client_a_network)
- Client B: $($data.client_b) — $($data.client_b_country) / $($data.client_b_network)
- Bootstrap: ``$($data.bootstrap)``
- Machine-readable manifest: ``$([IO.Path]::GetFileName($manifestFull))``
- Notes: $($data.notes)

## Results

| Check | Result | Evidence / notes |
| --- | --- | --- |
$($rows -join "`n")

## Outcome

Overall: **$($data.overall)**

This Markdown file is regenerated from the schema-v3 JSON manifest by `set-network-test-result.ps1`. Treat the JSON manifest as the authoritative release evidence. Stable promotion requires concrete evidence notes for PASS results, including the observed digest for SHA-256 transfer checks. Do not include identity keys, tokens, private addresses, or other secrets.
"@

$directory = Split-Path $manifestFull -Parent
$manifestTemp = Join-Path $directory ('.network-manifest-' + [Guid]::NewGuid().ToString('N') + '.json')
$markdownFull = [IO.Path]::ChangeExtension($manifestFull, '.md')
$markdownTemp = Join-Path $directory ('.network-report-' + [Guid]::NewGuid().ToString('N') + '.md')

try {
    $data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestTemp -Encoding utf8
    Set-Content -LiteralPath $markdownTemp -Value $markdown -Encoding utf8

    if ($Finalize) {
        & $validator -Manifest $manifestTemp -RequiredScenario @([string]$data.scenario) | Out-Null
    }

    Move-Item -LiteralPath $manifestTemp -Destination $manifestFull -Force
    Move-Item -LiteralPath $markdownTemp -Destination $markdownFull -Force
} finally {
    Remove-Item -LiteralPath $manifestTemp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $markdownTemp -Force -ErrorAction SilentlyContinue
}

Write-Host "Recorded $Check=$Result; overall=$($data.overall)" -ForegroundColor Green
Write-Host "Manifest: $manifestFull"
Write-Host "Report:   $markdownFull"
if ($Finalize) { Write-Host 'Final schema-v3 scenario validation passed.' -ForegroundColor Green }
