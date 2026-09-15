param(
    [Parameter(Mandatory = $true)][string[]]$Manifest,
    [string[]]$RequiredScenario = @('TCP','QUIC','Relay','DCUtR','CGNAT'),
    [switch]$RequireAllChecks
)

$ErrorActionPreference = 'Stop'
$allowed = @('LAN','TCP','QUIC','Relay','DCUtR','CGNAT')
$requiredChecks = @(
    'world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256',
    'file_b_to_a_sha256','client_reconnect','node_restart_recovery',
    'relay_observed','dcutr_direct_upgrade','nickname_conflict'
)

$reports = @()
foreach ($path in $Manifest) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest not found: $path" }
    try { $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { throw "Invalid JSON manifest: $path`n$($_.Exception.Message)" }

    if ($data.schema_version -ne 1) { throw "Unsupported schema_version in ${path}: $($data.schema_version)" }
    if ($allowed -notcontains $data.scenario) { throw "Invalid scenario in ${path}: $($data.scenario)" }
    if ([string]::IsNullOrWhiteSpace($data.build_version) -or $data.build_version -eq 'unknown') { throw "Missing build version in $path" }
    if ([string]::IsNullOrWhiteSpace($data.node_version) -or $data.node_version -eq 'unknown') { throw "Missing Node version in $path" }
    if ([string]::IsNullOrWhiteSpace($data.client_a) -or [string]::IsNullOrWhiteSpace($data.client_b)) { throw "Both clients must be recorded in $path" }
    if ($data.client_a -eq $data.client_b) { throw "Client A and Client B must identify independent endpoints in $path" }
    if ($data.bootstrap -notmatch '^/(ip4|ip6|dns|dns4|dns6)/.+/p2p/[A-Za-z0-9]+$') { throw "Invalid bootstrap multiaddress in $path" }
    if ($data.overall -ne 'PASS') { throw "Manifest is not PASS: $path (overall=$($data.overall))" }

    foreach ($name in $requiredChecks) {
        $property = $data.checks.PSObject.Properties[$name]
        if ($null -eq $property) { throw "Missing check '$name' in $path" }
        if ($RequireAllChecks -and $property.Value -ne 'PASS') { throw "Required check '$name' is not PASS in $path" }
        if ($property.Value -notin @('PASS','FAIL','PENDING','N/A')) { throw "Invalid result for '$name' in $path" }
    }
    $reports += $data
}

foreach ($scenario in $RequiredScenario) {
    if ($allowed -notcontains $scenario) { throw "Unknown required scenario: $scenario" }
    if (-not ($reports | Where-Object { $_.scenario -eq $scenario -and $_.overall -eq 'PASS' })) {
        throw "No passing manifest supplied for required scenario: $scenario"
    }
}

$versions = @($reports | ForEach-Object { $_.build_version } | Sort-Object -Unique)
$nodeVersions = @($reports | ForEach-Object { $_.node_version } | Sort-Object -Unique)
if ($versions.Count -ne 1) { throw "Evidence mixes client builds: $($versions -join ', ')" }
if ($nodeVersions.Count -ne 1) { throw "Evidence mixes Node builds: $($nodeVersions -join ', ')" }

Write-Host "Network evidence gate passed."
Write-Host "Client build: $($versions[0])"
Write-Host "Node build: $($nodeVersions[0])"
Write-Host "Passing manifests: $($reports.Count)"
Write-Host "Scenarios: $((@($reports.scenario | Sort-Object -Unique)) -join ', ')"
