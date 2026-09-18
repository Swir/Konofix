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

$manifestDirectory = Split-Path $manifestFull -Parent
$manifestName = [IO.Path]::GetFileName($manifestFull)
$sessionInfoPath = Join-Path $manifestDirectory 'SESSION_INFO.json'
$sessionValidator = Join-Path $PSScriptRoot 'validate-network-test-session.ps1'
$sessionData = $null
$sessionInventoryEntry = $null
$sessionManifestPaths = @()
$originalSessionBytes = $null

try {
    $data = Get-Content -LiteralPath $manifestFull -Raw | ConvertFrom-Json
} catch {
    throw "Network test manifest is not valid JSON: $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $sessionInfoPath -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $sessionValidator -PathType Leaf)) {
        throw "Session-aware evidence edit requires validator: $sessionValidator"
    }
    $sessionItem = Get-Item -LiteralPath $sessionInfoPath
    if ($sessionItem.Length -le 0 -or $sessionItem.Length -gt 262144) {
        throw 'SESSION_INFO.json is empty or exceeds the 262144-byte safety limit.'
    }
    $originalSessionBytes = [IO.File]::ReadAllBytes($sessionInfoPath)
    try {
        $sessionData = Get-Content -LiteralPath $sessionInfoPath -Raw | ConvertFrom-Json
    } catch {
        throw "SESSION_INFO.json is not valid JSON: $($_.Exception.Message)"
    }
    if ($sessionData -isnot [pscustomobject] -or [int]$sessionData.schema_version -ne 1 -or [string]$sessionData.product -cne 'Konofix Chat') {
        throw 'SESSION_INFO.json does not describe a supported Konofix test session.'
    }
    $inventory = @($sessionData.manifests)
    if ($inventory.Count -ne 5) { throw 'SESSION_INFO.json must inventory exactly five manifests.' }
    $matches = @($inventory | Where-Object { [string]$_.path -ceq $manifestName })
    if ($matches.Count -ne 1) { throw "Current manifest must occur exactly once in SESSION_INFO inventory: $manifestName" }
    $sessionInventoryEntry = $matches[0]
    $sessionManifestPaths = @($inventory | ForEach-Object {
        $name = [string]$_.path
        if ([IO.Path]::GetFileName($name) -cne $name) { throw "Unsafe SESSION_INFO manifest path: $name" }
        Join-Path $manifestDirectory $name
    })
    & $sessionValidator -SessionInfoPath $sessionInfoPath -Manifest $sessionManifestPaths | Out-Null

    if ([string]$sessionData.build_version -cne [string]$data.build_version -or
        [string]$sessionData.node_version -cne [string]$data.node_version -or
        [string]$sessionData.source_commit -cne [string]$data.source_commit -or
        [string]$sessionData.client_a.id -cne [string]$data.client_a -or
        [string]$sessionData.client_b.id -cne [string]$data.client_b -or
        [string]$sessionData.client_a.country -cne [string]$data.client_a_country -or
        [string]$sessionData.client_b.country -cne [string]$data.client_b_country -or
        [string]$sessionData.client_a.network -cne [string]$data.client_a_network -or
        [string]$sessionData.client_b.network -cne [string]$data.client_b_network) {
        throw 'Manifest identity/provenance fields do not match sibling SESSION_INFO.json.'
    }
    $expectedBootstrap = if ([string]$data.scenario -ceq 'QUIC') { [string]$sessionData.quic_bootstrap } else { [string]$sessionData.tcp_bootstrap }
    if ([string]$data.bootstrap -cne $expectedBootstrap) {
        throw 'Manifest bootstrap does not match sibling SESSION_INFO.json.'
    }
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
$sessionTemp = Join-Path $directory ('.network-session-' + [Guid]::NewGuid().ToString('N') + '.json')
$originalManifestBytes = [IO.File]::ReadAllBytes($manifestFull)
$markdownExisted = Test-Path -LiteralPath $markdownFull -PathType Leaf
$originalMarkdownBytes = if ($markdownExisted) { [IO.File]::ReadAllBytes($markdownFull) } else { $null }
$manifestCommitted = $false
$markdownCommitted = $false
$sessionCommitted = $false

try {
    $data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestTemp -Encoding utf8
    Set-Content -LiteralPath $markdownTemp -Value $markdown -Encoding utf8

    if ($Finalize) {
        & $validator -Manifest $manifestTemp -RequiredScenario @([string]$data.scenario) | Out-Null
    }

    if ($null -ne $sessionData) {
        $newManifestItem = Get-Item -LiteralPath $manifestTemp
        $newManifestHash = (Get-FileHash -LiteralPath $manifestTemp -Algorithm SHA256).Hash.ToLowerInvariant()
        $sessionInventoryEntry.bytes = [int64]$newManifestItem.Length
        $sessionInventoryEntry.sha256 = $newManifestHash
        $sessionData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sessionTemp -Encoding utf8
    }

    Move-Item -LiteralPath $manifestTemp -Destination $manifestFull -Force
    $manifestCommitted = $true
    Move-Item -LiteralPath $markdownTemp -Destination $markdownFull -Force
    $markdownCommitted = $true
    if ($null -ne $sessionData) {
        Move-Item -LiteralPath $sessionTemp -Destination $sessionInfoPath -Force
        $sessionCommitted = $true
        & $sessionValidator -SessionInfoPath $sessionInfoPath -Manifest $sessionManifestPaths | Out-Null
    }
} catch {
    $failure = $_
    if ($manifestCommitted) { [IO.File]::WriteAllBytes($manifestFull, $originalManifestBytes) }
    if ($markdownCommitted) {
        if ($markdownExisted) { [IO.File]::WriteAllBytes($markdownFull, $originalMarkdownBytes) }
        else { Remove-Item -LiteralPath $markdownFull -Force -ErrorAction SilentlyContinue }
    }
    if ($sessionCommitted -and $null -ne $originalSessionBytes) {
        [IO.File]::WriteAllBytes($sessionInfoPath, $originalSessionBytes)
    }
    throw $failure
} finally {
    Remove-Item -LiteralPath $manifestTemp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $markdownTemp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sessionTemp -Force -ErrorAction SilentlyContinue
}

Write-Host "Recorded $Check=$Result; overall=$($data.overall)" -ForegroundColor Green
Write-Host "Manifest: $manifestFull"
Write-Host "Report:   $markdownFull"
if ($Finalize) { Write-Host 'Final schema-v3 scenario validation passed.' -ForegroundColor Green }
