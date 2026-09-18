[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionInfoPath,
    [Parameter(Mandatory = $true)][string[]]$Manifest,
    [string]$ExpectedBuildVersion = '',
    [string]$ExpectedNodeVersion = '',
    [string]$ExpectedSourceCommit = '',
    [string]$ExpectedBuildInfoSha256 = '',
    [string]$ExpectedNodeSha256 = '',
    [string]$ExpectedBootstrapPeerId = '',
    [ValidateRange(1024, 1048576)][int64]$MaxSessionInfoBytes = 262144,
    [switch]$RequirePassingEvidence,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-RequiredProperty {
    param($Object, [string]$Name, [string]$Label)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { throw "$Label is missing required field '$Name'." }
    return $property.Value
}

function Get-StrictString {
    param($Value, [string]$Field, [switch]$AllowEmpty)
    if ($Value -isnot [string]) { throw "Session field '$Field' must be a JSON string." }
    if (-not $AllowEmpty -and [string]::IsNullOrWhiteSpace($Value)) { throw "Session field '$Field' cannot be empty or whitespace." }
    return [string]$Value
}

function Get-StrictInt64 {
    param($Value, [string]$Field)
    if ($null -eq $Value) { throw "Session field '$Field' cannot be null." }
    $typeCode = [System.Type]::GetTypeCode($Value.GetType())
    $integralTypes = @(
        [System.TypeCode]::SByte, [System.TypeCode]::Byte,
        [System.TypeCode]::Int16, [System.TypeCode]::UInt16,
        [System.TypeCode]::Int32, [System.TypeCode]::UInt32,
        [System.TypeCode]::Int64, [System.TypeCode]::UInt64
    )
    if ($typeCode -notin $integralTypes) { throw "Session field '$Field' must be a JSON integer." }
    try { return [Convert]::ToInt64($Value, [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw "Session field '$Field' is outside the supported signed 64-bit integer range." }
}

function Read-BoundedJsonObject([string]$Path, [int64]$MaxBytes, [string]$Label) {
    Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "$Label is missing: $Path"
    $item = Get-Item -LiteralPath $Path
    Assert-True ($item.Length -gt 0) "$Label is empty: $Path"
    Assert-True ($item.Length -le $MaxBytes) "$Label exceeds the maximum supported size of $MaxBytes bytes: $Path"
    $raw = Get-Content -LiteralPath $Path -Raw
    Assert-True ($raw.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) "$Label root must be a JSON object: $Path"
    try {
        $convert = Get-Command ConvertFrom-Json -ErrorAction Stop
        $value = if ($convert.Parameters.ContainsKey('DateKind')) { $raw | ConvertFrom-Json -DateKind String } else { $raw | ConvertFrom-Json }
    } catch {
        throw "$Label is not valid JSON: $($_.Exception.Message)"
    }
    Assert-True ($value -is [pscustomobject]) "$Label root must be a JSON object: $Path"
    return $value
}

function Parse-Bootstrap([string]$Address) {
    $internetTest = Join-Path $PSScriptRoot 'internet-test.ps1'
    Assert-True (Test-Path -LiteralPath $internetTest -PathType Leaf) "Required bootstrap validator is missing: $internetTest"
    $json = (& $internetTest -Bootstrap $Address -ValidateOnly -AsJson -RequirePublicHost -RequireDnsResolution | Out-String).Trim()
    Assert-True (-not [string]::IsNullOrWhiteSpace($json)) "Bootstrap validation returned no structured result: $Address"
    try { $parsed = $json | ConvertFrom-Json } catch { throw "Bootstrap validation returned invalid JSON for '$Address'." }
    Assert-True ([bool]$parsed.public_host_validated) "Bootstrap did not pass the globally-routable public-host policy: $Address"
    return $parsed
}

function Assert-OptionalPin([string]$Name, [string]$Actual, [string]$Expected, [string]$Pattern = '') {
    if ([string]::IsNullOrWhiteSpace($Expected)) { return }
    if (-not [string]::IsNullOrWhiteSpace($Pattern) -and $Expected -cnotmatch $Pattern) { throw "$Name pin has an invalid canonical format." }
    Assert-True ([string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) "$Name mismatch. expected=$Expected actual=$Actual"
}

$sessionFullPath = [IO.Path]::GetFullPath($SessionInfoPath)
$sessionDirectory = [IO.Path]::GetFullPath((Split-Path $sessionFullPath -Parent))
$session = Read-BoundedJsonObject -Path $sessionFullPath -MaxBytes $MaxSessionInfoBytes -Label 'SESSION_INFO.json'
$schema = Get-StrictInt64 (Get-RequiredProperty $session 'schema_version' 'SESSION_INFO.json') 'schema_version'
Assert-True ($schema -eq 1) "Unsupported SESSION_INFO schema: $schema"
$product = Get-StrictString (Get-RequiredProperty $session 'product' 'SESSION_INFO.json') 'product'
Assert-True ([string]::Equals($product, 'Konofix Chat', [StringComparison]::Ordinal)) "Unexpected SESSION_INFO product: $product"
$buildVersion = Get-StrictString (Get-RequiredProperty $session 'build_version' 'SESSION_INFO.json') 'build_version'
$nodeVersion = Get-StrictString (Get-RequiredProperty $session 'node_version' 'SESSION_INFO.json') 'node_version'
$sourceCommit = Get-StrictString (Get-RequiredProperty $session 'source_commit' 'SESSION_INFO.json') 'source_commit'
Assert-True ($sourceCommit -cmatch '^[0-9a-f]{40}$') 'SESSION_INFO source_commit must be a canonical lowercase 40-character Git SHA.'
$buildInfoHash = Get-StrictString (Get-RequiredProperty $session 'build_info_sha256' 'SESSION_INFO.json') 'build_info_sha256'
$nodeHash = Get-StrictString (Get-RequiredProperty $session 'node_sha256' 'SESSION_INFO.json') 'node_sha256'
Assert-True ($buildInfoHash -cmatch '^[0-9a-f]{64}$') 'SESSION_INFO build_info_sha256 must be canonical lowercase hexadecimal.'
Assert-True ($nodeHash -cmatch '^[0-9a-f]{64}$') 'SESSION_INFO node_sha256 must be canonical lowercase hexadecimal.'
$bootstrapPeer = Get-StrictString (Get-RequiredProperty $session 'bootstrap_peer_id' 'SESSION_INFO.json') 'bootstrap_peer_id'
$tcpBootstrap = Get-StrictString (Get-RequiredProperty $session 'tcp_bootstrap' 'SESSION_INFO.json') 'tcp_bootstrap'
$quicBootstrap = Get-StrictString (Get-RequiredProperty $session 'quic_bootstrap' 'SESSION_INFO.json') 'quic_bootstrap'

Assert-OptionalPin 'Build version' $buildVersion $ExpectedBuildVersion
Assert-OptionalPin 'Node version' $nodeVersion $ExpectedNodeVersion
Assert-OptionalPin 'Source commit' $sourceCommit $ExpectedSourceCommit '^[0-9a-f]{40}$'
Assert-OptionalPin 'BUILD_INFO SHA-256' $buildInfoHash $ExpectedBuildInfoSha256 '^[0-9a-f]{64}$'
Assert-OptionalPin 'Node SHA-256' $nodeHash $ExpectedNodeSha256 '^[0-9a-f]{64}$'
Assert-OptionalPin 'Bootstrap Peer ID' $bootstrapPeer $ExpectedBootstrapPeerId

$tcp = Parse-Bootstrap $tcpBootstrap
$quic = Parse-Bootstrap $quicBootstrap
Assert-True ([string]$tcp.transport -ceq 'tcp') 'SESSION_INFO tcp_bootstrap must use TCP.'
Assert-True ([string]$quic.transport -ceq 'quic-v1') 'SESSION_INFO quic_bootstrap must use UDP/QUIC v1.'
Assert-True ([string]$tcp.host_protocol -ceq [string]$quic.host_protocol -and [string]$tcp.host -ceq [string]$quic.host) 'SESSION_INFO TCP and QUIC bootstraps must describe the same host.'
Assert-True ([int]$tcp.port -eq [int]$quic.port) 'SESSION_INFO TCP and QUIC bootstraps must use the same port.'
Assert-True ([string]$tcp.peer_id -ceq [string]$quic.peer_id) 'SESSION_INFO TCP and QUIC bootstraps must use the same Peer ID.'
Assert-True ([string]$tcp.peer_id -ceq $bootstrapPeer) 'SESSION_INFO bootstrap_peer_id does not match its bootstrap addresses.'

$clientA = Get-RequiredProperty $session 'client_a' 'SESSION_INFO.json'
$clientB = Get-RequiredProperty $session 'client_b' 'SESSION_INFO.json'
Assert-True ($clientA -is [pscustomobject] -and $clientB -is [pscustomobject]) 'SESSION_INFO client_a/client_b must be JSON objects.'
$aId = Get-StrictString (Get-RequiredProperty $clientA 'id' 'SESSION_INFO client_a') 'client_a.id'
$aCountry = Get-StrictString (Get-RequiredProperty $clientA 'country' 'SESSION_INFO client_a') 'client_a.country'
$aNetwork = Get-StrictString (Get-RequiredProperty $clientA 'network' 'SESSION_INFO client_a') 'client_a.network'
$bId = Get-StrictString (Get-RequiredProperty $clientB 'id' 'SESSION_INFO client_b') 'client_b.id'
$bCountry = Get-StrictString (Get-RequiredProperty $clientB 'country' 'SESSION_INFO client_b') 'client_b.country'
$bNetwork = Get-StrictString (Get-RequiredProperty $clientB 'network' 'SESSION_INFO client_b') 'client_b.network'
Assert-True (-not [string]::Equals($aId.Trim(), $bId.Trim(), [StringComparison]::OrdinalIgnoreCase)) 'SESSION_INFO requires two different client endpoints.'
Assert-True (-not [string]::Equals($aCountry.Trim(), $bCountry.Trim(), [StringComparison]::OrdinalIgnoreCase)) 'SESSION_INFO requires clients in different countries.'
Assert-True (-not [string]::Equals($aNetwork.Trim(), $bNetwork.Trim(), [StringComparison]::OrdinalIgnoreCase)) 'SESSION_INFO requires independent client networks/operators.'

$inventory = @(Get-RequiredProperty $session 'manifests' 'SESSION_INFO.json')
Assert-True ($inventory.Count -eq 5) "SESSION_INFO must inventory exactly five manifests; found $($inventory.Count)."
$inventoryNames = @()
$inventoryByName = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
foreach ($entry in $inventory) {
    Assert-True ($entry -is [pscustomobject]) 'SESSION_INFO manifest inventory entries must be JSON objects.'
    $name = Get-StrictString (Get-RequiredProperty $entry 'path' 'SESSION_INFO manifest inventory') 'manifests.path'
    Assert-True ([IO.Path]::GetFileName($name) -ceq $name) "SESSION_INFO manifest inventory path must be a file name only: $name"
    Assert-True ($name -cmatch '^network-test-(tcp|quic|relay|dcutr|cgnat)-.+\.json$') "SESSION_INFO manifest inventory contains an unexpected path: $name"
    $bytes = Get-StrictInt64 (Get-RequiredProperty $entry 'bytes' 'SESSION_INFO manifest inventory') 'manifests.bytes'
    Assert-True ($bytes -gt 0) "SESSION_INFO manifest inventory bytes must be positive: $name"
    $sha256 = Get-StrictString (Get-RequiredProperty $entry 'sha256' 'SESSION_INFO manifest inventory') 'manifests.sha256'
    Assert-True ($sha256 -cmatch '^[0-9a-f]{64}$') "SESSION_INFO manifest inventory SHA-256 must be canonical lowercase hexadecimal: $name"
    Assert-True (-not $inventoryByName.ContainsKey($name)) "SESSION_INFO manifest inventory contains a duplicate path: $name"
    $inventoryByName.Add($name, [pscustomobject]@{ bytes = $bytes; sha256 = $sha256 })
    $inventoryNames += $name
}
$inventoryNames = @($inventoryNames | Sort-Object -Unique -CaseSensitive)
Assert-True ($inventoryNames.Count -eq 5) 'SESSION_INFO manifest inventory must contain five unique paths.'

$manifestPaths = @()
foreach ($path in $Manifest) {
    Assert-True (-not [string]::IsNullOrWhiteSpace($path)) 'Manifest path cannot be empty or whitespace.'
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Manifest not found: $path"
    $manifestItem = Get-Item -LiteralPath $path
    $manifestFullPath = $manifestItem.FullName
    $manifestDirectory = [IO.Path]::GetFullPath((Split-Path $manifestFullPath -Parent))
    Assert-True ([string]::Equals($manifestDirectory, $sessionDirectory, [StringComparison]::OrdinalIgnoreCase)) "Session manifest must reside beside SESSION_INFO.json; cross-directory evidence is rejected: $manifestFullPath"
    $manifestName = [IO.Path]::GetFileName($manifestFullPath)
    Assert-True ($inventoryByName.ContainsKey($manifestName)) "Supplied manifest is absent from SESSION_INFO inventory: $manifestName"
    $binding = $inventoryByName[$manifestName]
    Assert-True ([int64]$manifestItem.Length -eq [int64]$binding.bytes) "Manifest byte count does not match SESSION_INFO inventory: $manifestName"
    $actualManifestHash = (Get-FileHash -LiteralPath $manifestFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ([string]::Equals($actualManifestHash, [string]$binding.sha256, [StringComparison]::Ordinal)) "Manifest SHA-256 does not match SESSION_INFO inventory: $manifestName"
    $manifestPaths += $manifestFullPath
}
$manifestPaths = @($manifestPaths | Sort-Object -Unique)
Assert-True ($manifestPaths.Count -eq 5) "A network test session must contain exactly five unique manifests; found $($manifestPaths.Count)."
$suppliedNames = @($manifestPaths | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object -Unique -CaseSensitive)
Assert-True ($suppliedNames.Count -eq 5) 'Supplied session manifests must have five unique file names.'
for ($i = 0; $i -lt $inventoryNames.Count; $i++) {
    Assert-True ($inventoryNames[$i] -ceq $suppliedNames[$i]) "Supplied manifest set does not match SESSION_INFO inventory. expected=$($inventoryNames -join ',') actual=$($suppliedNames -join ',')"
}

$expectedScenarios = @('CGNAT','DCUtR','QUIC','Relay','TCP')
$seen = @{}
foreach ($path in $manifestPaths) {
    $data = Read-BoundedJsonObject -Path $path -MaxBytes 262144 -Label 'Network manifest'
    $scenario = Get-StrictString (Get-RequiredProperty $data 'scenario' $path) 'manifest.scenario'
    Assert-True ($scenario -cin $expectedScenarios) "Unexpected session scenario '$scenario' in $path"
    Assert-True (-not $seen.ContainsKey($scenario)) "Duplicate session scenario '$scenario'."
    $seen[$scenario] = $true

    $manifestBuild = Get-StrictString (Get-RequiredProperty $data 'build_version' $path) 'manifest.build_version'
    $manifestNode = Get-StrictString (Get-RequiredProperty $data 'node_version' $path) 'manifest.node_version'
    $manifestCommit = Get-StrictString (Get-RequiredProperty $data 'source_commit' $path) 'manifest.source_commit'
    Assert-True ($manifestBuild -ceq $buildVersion) "$scenario build version does not match SESSION_INFO."
    Assert-True ($manifestNode -ceq $nodeVersion) "$scenario Node version does not match SESSION_INFO."
    Assert-True ($manifestCommit -ceq $sourceCommit) "$scenario source commit does not match SESSION_INFO."

    foreach ($binding in @(
        @{ Field = 'client_a'; Expected = $aId },
        @{ Field = 'client_b'; Expected = $bId },
        @{ Field = 'client_a_country'; Expected = $aCountry },
        @{ Field = 'client_b_country'; Expected = $bCountry },
        @{ Field = 'client_a_network'; Expected = $aNetwork },
        @{ Field = 'client_b_network'; Expected = $bNetwork }
    )) {
        $actual = Get-StrictString (Get-RequiredProperty $data $binding.Field $path) "manifest.$($binding.Field)"
        Assert-True ($actual -ceq [string]$binding.Expected) "$scenario $($binding.Field) does not match SESSION_INFO."
    }

    $manifestBootstrap = Get-StrictString (Get-RequiredProperty $data 'bootstrap' $path) 'manifest.bootstrap'
    $expectedBootstrap = if ($scenario -ceq 'QUIC') { $quicBootstrap } else { $tcpBootstrap }
    Assert-True ($manifestBootstrap -ceq $expectedBootstrap) "$scenario bootstrap does not match the paired SESSION_INFO bootstrap."
}
foreach ($scenario in $expectedScenarios) { Assert-True ($seen.ContainsKey($scenario)) "SESSION_INFO is missing scenario: $scenario" }

if ($RequirePassingEvidence) {
    $validator = Join-Path $PSScriptRoot 'validate-network-test-report.ps1'
    Assert-True (Test-Path -LiteralPath $validator -PathType Leaf) "Required network evidence validator is missing: $validator"
    & $validator `
        -Manifest $manifestPaths `
        -RequireAllChecks `
        -ExpectedBuildVersion $buildVersion `
        -ExpectedNodeVersion $nodeVersion `
        -ExpectedSourceCommit $sourceCommit `
        -RequireSingleBootstrapPeer | Out-Null
}

$result = [ordered]@{
    schema = 2
    status = 'PASS'
    build_version = $buildVersion
    node_version = $nodeVersion
    source_commit = $sourceCommit
    bootstrap_peer_id = $bootstrapPeer
    public_host_validated = $true
    client_a = $aId
    client_b = $bId
    manifest_count = $manifestPaths.Count
    passing_evidence_required = [bool]$RequirePassingEvidence
}
if ($AsJson) { $result | ConvertTo-Json -Depth 3; return }
Write-Host 'Network test session consistency passed.' -ForegroundColor Green
Write-Host "Build: $buildVersion / $sourceCommit"
Write-Host "Bootstrap Peer ID: $bootstrapPeer"
Write-Host 'Public bootstrap policy: PASS'
Write-Host "Clients: $aId <-> $bId"
Write-Host "Manifests: $($manifestPaths.Count)"
