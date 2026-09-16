param(
    [Parameter(Mandatory = $true)][string[]]$Manifest,
    [string[]]$RequiredScenario = @('TCP','QUIC','Relay','DCUtR','CGNAT'),
    [switch]$RequireAllChecks,
    [int]$MaxAgeDays = 30,
    [string]$ExpectedBuildVersion = '',
    [string]$ExpectedNodeVersion = '',
    [string]$ExpectedSourceCommit = '',
    [switch]$RequireSingleBootstrapPeer,
    [int64]$MaxManifestBytes = 262144
)

$ErrorActionPreference = 'Stop'
$allowed = @('LAN','TCP','QUIC','Relay','DCUtR','CGNAT')
$requiredChecks = @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','relay_observed','dcutr_direct_upgrade','nickname_conflict')
$coreChecks = @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','nickname_conflict')
$allowedResults = @('PASS','FAIL','PENDING','N/A')

function Get-StrictJsonInt64 {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field
    )

    if ($null -eq $Value) { throw "Evidence field '$Field' cannot be null." }
    $typeCode = [System.Type]::GetTypeCode($Value.GetType())
    $integralTypes = @(
        [System.TypeCode]::SByte, [System.TypeCode]::Byte,
        [System.TypeCode]::Int16, [System.TypeCode]::UInt16,
        [System.TypeCode]::Int32, [System.TypeCode]::UInt32,
        [System.TypeCode]::Int64, [System.TypeCode]::UInt64
    )
    if ($typeCode -notin $integralTypes) {
        throw "Evidence field '$Field' must be a JSON integer."
    }
    try {
        return [Convert]::ToInt64($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        throw "Evidence field '$Field' is outside the supported signed 64-bit integer range."
    }
}

function Get-StrictJsonString {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field,
        [switch]$AllowEmpty
    )

    if ($Value -isnot [string]) { throw "Evidence field '$Field' must be a JSON string." }
    if (-not $AllowEmpty -and [string]::IsNullOrWhiteSpace($Value)) {
        throw "Evidence field '$Field' cannot be empty or whitespace."
    }
    return [string]$Value
}

function Get-RequiredProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        throw "Missing required field '$Name' in $Path"
    }
    return $property.Value
}

function Convert-StrictManifestJson {
    param(
        [Parameter(Mandatory = $true)][string]$Raw,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not $Raw.TrimStart().StartsWith('{', [System.StringComparison]::Ordinal)) {
        throw "Network evidence root must be a JSON object: $Path"
    }

    try {
        $convertCommand = Get-Command ConvertFrom-Json -ErrorAction Stop
        if ($convertCommand.Parameters.ContainsKey('DateKind')) {
            # PowerShell 7.5+ otherwise converts ISO-8601 JSON strings to DateTime values,
            # which destroys the original JSON token type before our strict schema check.
            return $Raw | ConvertFrom-Json -DateKind String
        }
        return $Raw | ConvertFrom-Json
    } catch {
        throw "Invalid JSON manifest: $Path`n$($_.Exception.Message)"
    }
}

function Test-OrdinalEqual([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [System.StringComparison]::Ordinal)
}

if ($MaxManifestBytes -lt 1024 -or $MaxManifestBytes -gt 1048576) { throw 'MaxManifestBytes must be between 1024 and 1048576.' }
if ($MaxAgeDays -lt 0 -or $MaxAgeDays -gt 3650) { throw 'MaxAgeDays must be between 0 and 3650.' }
if ($PSBoundParameters.ContainsKey('ExpectedBuildVersion') -and [string]::IsNullOrWhiteSpace($ExpectedBuildVersion)) { throw 'ExpectedBuildVersion cannot be empty or whitespace when explicitly supplied.' }
if ($PSBoundParameters.ContainsKey('ExpectedNodeVersion') -and [string]::IsNullOrWhiteSpace($ExpectedNodeVersion)) { throw 'ExpectedNodeVersion cannot be empty or whitespace when explicitly supplied.' }
if ($PSBoundParameters.ContainsKey('ExpectedSourceCommit')) {
    if ([string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) { throw 'ExpectedSourceCommit cannot be empty or whitespace when explicitly supplied.' }
    if ($ExpectedSourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'ExpectedSourceCommit must be a canonical lowercase 40-character Git commit SHA.' }
}

$reports = @()
foreach ($path in $Manifest) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest not found: $path" }
    $manifestFile = Get-Item -LiteralPath $path
    if ($manifestFile.Length -gt $MaxManifestBytes) {
        throw "Network evidence manifest is too large (path=$path bytes=$($manifestFile.Length) limit=$MaxManifestBytes)."
    }

    $raw = Get-Content -LiteralPath $path -Raw
    $data = Convert-StrictManifestJson -Raw $raw -Path $path
    if ($data -isnot [pscustomobject]) { throw "Network evidence root must be a JSON object: $path" }

    $schema = Get-StrictJsonInt64 -Value (Get-RequiredProperty $data 'schema_version' $path) -Field 'schema_version'
    if ($schema -ne 3) { throw "Unsupported schema_version in ${path}: $schema. Regenerate evidence with the current tool." }

    $createdUtc = Get-StrictJsonString -Value (Get-RequiredProperty $data 'created_utc' $path) -Field 'created_utc'
    $scenario = Get-StrictJsonString -Value (Get-RequiredProperty $data 'scenario' $path) -Field 'scenario'
    $buildVersion = Get-StrictJsonString -Value (Get-RequiredProperty $data 'build_version' $path) -Field 'build_version'
    $nodeVersion = Get-StrictJsonString -Value (Get-RequiredProperty $data 'node_version' $path) -Field 'node_version'
    $sourceCommit = Get-StrictJsonString -Value (Get-RequiredProperty $data 'source_commit' $path) -Field 'source_commit'
    $clientA = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_a' $path) -Field 'client_a'
    $clientB = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_b' $path) -Field 'client_b'
    $bootstrap = Get-StrictJsonString -Value (Get-RequiredProperty $data 'bootstrap' $path) -Field 'bootstrap'
    $overall = Get-StrictJsonString -Value (Get-RequiredProperty $data 'overall' $path) -Field 'overall'

    if ($allowed -cnotcontains $scenario) { throw "Invalid scenario in ${path}: $scenario" }
    if ($sourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw "Missing or invalid source_commit in $path" }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildVersion) -and -not (Test-OrdinalEqual $buildVersion $ExpectedBuildVersion)) { throw "Evidence build version $buildVersion does not match target build $ExpectedBuildVersion in $path" }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedNodeVersion) -and -not (Test-OrdinalEqual $nodeVersion $ExpectedNodeVersion)) { throw "Evidence Node version $nodeVersion does not match target Node $ExpectedNodeVersion in $path" }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -and -not (Test-OrdinalEqual $sourceCommit $ExpectedSourceCommit)) { throw "Evidence source commit $sourceCommit does not match target commit $ExpectedSourceCommit in $path" }
    if ($clientA.Trim().ToLowerInvariant() -eq $clientB.Trim().ToLowerInvariant()) { throw "Two different client endpoints must be recorded in $path" }
    if ($bootstrap -cnotmatch '^/(ip4|ip6|dns|dns4|dns6)/.+/p2p/[A-Za-z0-9]+$') { throw "Invalid bootstrap multiaddress in $path" }
    if (-not (Test-OrdinalEqual $overall 'PASS')) { throw "Manifest is not PASS: $path (overall=$overall)" }

    $created = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($createdUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$created)) {
        throw "Invalid created_utc in $path"
    }
    $age = [DateTimeOffset]::UtcNow - $created.ToUniversalTime()
    if ($age.TotalMinutes -lt -5) { throw "Evidence timestamp is in the future: $path" }
    if ($MaxAgeDays -gt 0 -and $age.TotalDays -gt $MaxAgeDays) { throw "Evidence is older than $MaxAgeDays days: $path" }

    if ($scenario -ne 'LAN') {
        $clientACountry = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_a_country' $path) -Field 'client_a_country'
        $clientBCountry = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_b_country' $path) -Field 'client_b_country'
        $clientANetwork = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_a_network' $path) -Field 'client_a_network'
        $clientBNetwork = Get-StrictJsonString -Value (Get-RequiredProperty $data 'client_b_network' $path) -Field 'client_b_network'
        if ($clientACountry.Trim().ToLowerInvariant() -eq $clientBCountry.Trim().ToLowerInvariant()) { throw "Internet evidence must use different countries: $path" }
        if ($clientANetwork.Trim().ToLowerInvariant() -eq $clientBNetwork.Trim().ToLowerInvariant()) { throw "Internet evidence must use independent networks/operators: $path" }
    }

    $checks = Get-RequiredProperty $data 'checks' $path
    if ($checks -isnot [pscustomobject]) { throw "Evidence field 'checks' must be a JSON object in $path" }
    foreach ($name in $requiredChecks) {
        $property = $checks.PSObject.Properties[$name]
        if ($null -eq $property -or $null -eq $property.Value) { throw "Missing check '$name' in $path" }
        $resultValue = Get-StrictJsonString -Value $property.Value -Field "checks.$name"
        if ($allowedResults -cnotcontains $resultValue) { throw "Invalid result for '$name' in $path" }
    }
    foreach ($name in $coreChecks) { if (-not (Test-OrdinalEqual ([string]$checks.$name) 'PASS')) { throw "Core check '$name' must be PASS in $path" } }
    if ($scenario -eq 'Relay' -and -not (Test-OrdinalEqual ([string]$checks.relay_observed) 'PASS')) { throw "Relay evidence must record relay_observed=PASS in $path" }
    if ($scenario -eq 'DCUtR' -and -not (Test-OrdinalEqual ([string]$checks.dcutr_direct_upgrade) 'PASS')) { throw "DCUtR evidence must record dcutr_direct_upgrade=PASS in $path" }
    if ($scenario -eq 'CGNAT' -and -not (Test-OrdinalEqual ([string]$checks.relay_observed) 'PASS')) { throw "CGNAT evidence must prove relay operation in $path" }
    if ($RequireAllChecks) {
        foreach ($name in $requiredChecks) {
            $resultValue = [string]$checks.$name
            if ($resultValue -cne 'PASS' -and $resultValue -cne 'N/A') { throw "Required check '$name' is incomplete in $path" }
        }
    }

    $notesProperty = $data.PSObject.Properties['notes']
    if ($null -ne $notesProperty -and $null -ne $notesProperty.Value) {
        $notes = Get-StrictJsonString -Value $notesProperty.Value -Field 'notes' -AllowEmpty
        if ($notes.Length -gt 8000) { throw "Evidence field 'notes' is too long in $path" }
    }

    $checkEvidenceProperty = $data.PSObject.Properties['check_evidence']
    if ($null -ne $checkEvidenceProperty -and $null -ne $checkEvidenceProperty.Value) {
        if ($checkEvidenceProperty.Value -isnot [pscustomobject]) { throw "Evidence field 'check_evidence' must be a JSON object in $path" }
        foreach ($property in $checkEvidenceProperty.Value.PSObject.Properties) {
            if ($requiredChecks -cnotcontains $property.Name) { throw "Unknown check_evidence key '$($property.Name)' in $path" }
            $evidenceText = Get-StrictJsonString -Value $property.Value -Field "check_evidence.$($property.Name)" -AllowEmpty
            if ($evidenceText.Length -gt 2000) { throw "Evidence note for '$($property.Name)' exceeds 2000 characters in $path" }
        }
    }

    $reports += [pscustomobject]@{
        scenario = $scenario
        build_version = $buildVersion
        node_version = $nodeVersion
        source_commit = $sourceCommit
        bootstrap = $bootstrap
        overall = $overall
    }
}

foreach ($scenario in $RequiredScenario) {
    if ($allowed -cnotcontains $scenario) { throw "Unknown required scenario: $scenario" }
    if (-not ($reports | Where-Object { $_.scenario -ceq $scenario -and $_.overall -ceq 'PASS' })) { throw "No passing manifest supplied for required scenario: $scenario" }
}
$versions = @($reports | ForEach-Object { $_.build_version } | Sort-Object -Unique -CaseSensitive)
$nodeVersions = @($reports | ForEach-Object { $_.node_version } | Sort-Object -Unique -CaseSensitive)
$sourceCommits = @($reports | ForEach-Object { $_.source_commit } | Sort-Object -Unique -CaseSensitive)
if ($versions.Count -ne 1) { throw "Evidence mixes client builds: $($versions -join ', ')" }
if ($nodeVersions.Count -ne 1) { throw "Evidence mixes Node builds: $($nodeVersions -join ', ')" }
if ($sourceCommits.Count -ne 1) { throw "Evidence mixes source commits: $($sourceCommits -join ', ')" }

$bootstrapPeerIds = @($reports | ForEach-Object { if ($_.bootstrap -cmatch '/p2p/([^/]+)$') { $Matches[1] } } | Sort-Object -Unique -CaseSensitive)
if ($RequireSingleBootstrapPeer -and $bootstrapPeerIds.Count -ne 1) { throw "Promotion evidence must target one stable public Node Peer ID; found: $($bootstrapPeerIds -join ', ')" }

Write-Host 'Network evidence gate passed.'
Write-Host "Client build: $($versions[0])"
Write-Host "Node build: $($nodeVersions[0])"
Write-Host "Source commit: $($sourceCommits[0])"
Write-Host "Passing manifests: $($reports.Count)"
Write-Host "Scenarios: $((@($reports.scenario | Sort-Object -Unique -CaseSensitive)) -join ', ')"
if ($bootstrapPeerIds.Count -gt 0) { Write-Host "Bootstrap Peer IDs: $($bootstrapPeerIds -join ', ')" }
