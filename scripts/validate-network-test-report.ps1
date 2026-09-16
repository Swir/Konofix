param(
    [Parameter(Mandatory = $true)][string[]]$Manifest,
    [string[]]$RequiredScenario = @('TCP','QUIC','Relay','DCUtR','CGNAT'),
    [switch]$RequireAllChecks,
    [int]$MaxAgeDays = 30,
    [string]$ExpectedBuildVersion = '',
    [string]$ExpectedNodeVersion = '',
    [string]$ExpectedSourceCommit = '',
    [switch]$RequireSingleBootstrapPeer
)

$ErrorActionPreference = 'Stop'
$allowed = @('LAN','TCP','QUIC','Relay','DCUtR','CGNAT')
$requiredChecks = @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','relay_observed','dcutr_direct_upgrade','nickname_conflict')
$coreChecks = @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','nickname_conflict')

if ($PSBoundParameters.ContainsKey('ExpectedSourceCommit')) {
    if ([string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) { throw 'ExpectedSourceCommit cannot be empty or whitespace when explicitly supplied.' }
    if ($ExpectedSourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'ExpectedSourceCommit must be a canonical lowercase 40-character Git commit SHA.' }
}

$reports = @()
foreach ($path in $Manifest) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest not found: $path" }
    try { $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { throw "Invalid JSON manifest: $path`n$($_.Exception.Message)" }
    if ($data.schema_version -ne 3) { throw "Unsupported schema_version in ${path}: $($data.schema_version). Regenerate evidence with the current tool." }
    if ($allowed -notcontains $data.scenario) { throw "Invalid scenario in ${path}: $($data.scenario)" }
    if ([string]::IsNullOrWhiteSpace($data.build_version) -or $data.build_version -eq 'unknown') { throw "Missing build version in $path" }
    if ([string]::IsNullOrWhiteSpace($data.node_version) -or $data.node_version -eq 'unknown') { throw "Missing Node version in $path" }
    if ($data.source_commit -isnot [string] -or $data.source_commit -cnotmatch '^[0-9a-f]{40}$') { throw "Missing or invalid source_commit in $path" }
    if ($ExpectedBuildVersion -and $data.build_version -ne $ExpectedBuildVersion) { throw "Evidence build version $($data.build_version) does not match target build $ExpectedBuildVersion in $path" }
    if ($ExpectedNodeVersion -and $data.node_version -ne $ExpectedNodeVersion) { throw "Evidence Node version $($data.node_version) does not match target Node $ExpectedNodeVersion in $path" }
    if ($ExpectedSourceCommit -and -not [string]::Equals([string]$data.source_commit, $ExpectedSourceCommit, [System.StringComparison]::Ordinal)) { throw "Evidence source commit $($data.source_commit) does not match target commit $ExpectedSourceCommit in $path" }
    if ([string]::IsNullOrWhiteSpace($data.client_a) -or [string]::IsNullOrWhiteSpace($data.client_b)) { throw "Two client endpoint identifiers are required in $path" }
    if ($data.client_a.Trim().ToLowerInvariant() -eq $data.client_b.Trim().ToLowerInvariant()) { throw "Two different client endpoints must be recorded in $path" }
    if ($data.bootstrap -notmatch '^/(ip4|ip6|dns|dns4|dns6)/.+/p2p/[A-Za-z0-9]+$') { throw "Invalid bootstrap multiaddress in $path" }
    if ($data.overall -ne 'PASS') { throw "Manifest is not PASS: $path (overall=$($data.overall))" }

    try { $created = [DateTimeOffset]::Parse($data.created_utc) } catch { throw "Invalid created_utc in $path" }
    $age = [DateTimeOffset]::UtcNow - $created.ToUniversalTime()
    if ($age.TotalMinutes -lt -5) { throw "Evidence timestamp is in the future: $path" }
    if ($MaxAgeDays -gt 0 -and $age.TotalDays -gt $MaxAgeDays) { throw "Evidence is older than $MaxAgeDays days: $path" }

    if ($data.scenario -ne 'LAN') {
        foreach ($field in @('client_a_country','client_b_country','client_a_network','client_b_network')) {
            if ([string]::IsNullOrWhiteSpace($data.$field)) { throw "Missing $field in $path" }
        }
        if ($data.client_a_country.Trim().ToLowerInvariant() -eq $data.client_b_country.Trim().ToLowerInvariant()) { throw "Internet evidence must use different countries: $path" }
        if ($data.client_a_network.Trim().ToLowerInvariant() -eq $data.client_b_network.Trim().ToLowerInvariant()) { throw "Internet evidence must use independent networks/operators: $path" }
    }

    if ($null -eq $data.checks) { throw "Missing checks object in $path" }
    foreach ($name in $requiredChecks) {
        $property = $data.checks.PSObject.Properties[$name]
        if ($null -eq $property) { throw "Missing check '$name' in $path" }
        if ($property.Value -notin @('PASS','FAIL','PENDING','N/A')) { throw "Invalid result for '$name' in $path" }
    }
    foreach ($name in $coreChecks) { if ($data.checks.$name -ne 'PASS') { throw "Core check '$name' must be PASS in $path" } }
    if ($data.scenario -eq 'Relay' -and $data.checks.relay_observed -ne 'PASS') { throw "Relay evidence must record relay_observed=PASS in $path" }
    if ($data.scenario -eq 'DCUtR' -and $data.checks.dcutr_direct_upgrade -ne 'PASS') { throw "DCUtR evidence must record dcutr_direct_upgrade=PASS in $path" }
    if ($data.scenario -eq 'CGNAT' -and $data.checks.relay_observed -ne 'PASS') { throw "CGNAT evidence must prove relay operation in $path" }
    if ($RequireAllChecks) { foreach ($name in $requiredChecks) { if ($data.checks.$name -notin @('PASS','N/A')) { throw "Required check '$name' is incomplete in $path" } } }
    $reports += $data
}

foreach ($scenario in $RequiredScenario) {
    if ($allowed -notcontains $scenario) { throw "Unknown required scenario: $scenario" }
    if (-not ($reports | Where-Object { $_.scenario -eq $scenario -and $_.overall -eq 'PASS' })) { throw "No passing manifest supplied for required scenario: $scenario" }
}
$versions = @($reports | ForEach-Object { $_.build_version } | Sort-Object -Unique)
$nodeVersions = @($reports | ForEach-Object { $_.node_version } | Sort-Object -Unique)
$sourceCommits = @($reports | ForEach-Object { $_.source_commit } | Sort-Object -Unique -CaseSensitive)
if ($versions.Count -ne 1) { throw "Evidence mixes client builds: $($versions -join ', ')" }
if ($nodeVersions.Count -ne 1) { throw "Evidence mixes Node builds: $($nodeVersions -join ', ')" }
if ($sourceCommits.Count -ne 1) { throw "Evidence mixes source commits: $($sourceCommits -join ', ')" }

$bootstrapPeerIds = @($reports | ForEach-Object { if ($_.bootstrap -match '/p2p/([^/]+)$') { $Matches[1] } } | Sort-Object -Unique)
if ($RequireSingleBootstrapPeer -and $bootstrapPeerIds.Count -ne 1) { throw "Promotion evidence must target one stable public Node Peer ID; found: $($bootstrapPeerIds -join ', ')" }

Write-Host 'Network evidence gate passed.'
Write-Host "Client build: $($versions[0])"
Write-Host "Node build: $($nodeVersions[0])"
Write-Host "Source commit: $($sourceCommits[0])"
Write-Host "Passing manifests: $($reports.Count)"
Write-Host "Scenarios: $((@($reports.scenario | Sort-Object -Unique)) -join ', ')"
if ($bootstrapPeerIds.Count -gt 0) { Write-Host "Bootstrap Peer IDs: $($bootstrapPeerIds -join ', ')" }
