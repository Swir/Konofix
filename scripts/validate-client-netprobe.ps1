[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Evidence,
    [Parameter(Mandatory = $true)][string]$SessionInfoPath,
    [Parameter(Mandatory = $true)][string]$BuildInfoPath,
    [ValidateRange(1, 365)][int]$MaxAgeDays = 30,
    [ValidateRange(1024, 1048576)][int64]$MaxEvidenceBytes = 262144,
    [switch]$RequireBothClients,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function ConvertFrom-JsonPreserveStrings([string]$Json) {
    $command = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($command.Parameters.ContainsKey('DateKind')) {
        return $Json | ConvertFrom-Json -DateKind String
    }
    return $Json | ConvertFrom-Json
}

function Read-BoundedJson([string]$Path, [int64]$MaxBytes, [string]$Label) {
    Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "$Label is missing: $Path"
    $item = Get-Item -LiteralPath $Path
    Assert-True ($item.Length -gt 0) "$Label is empty: $Path"
    Assert-True ($item.Length -le $MaxBytes) "$Label exceeds the maximum supported size of $MaxBytes bytes: $Path"
    $raw = Get-Content -LiteralPath $Path -Raw
    Assert-True ($raw.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) "$Label root must be a JSON object: $Path"
    try { return ConvertFrom-JsonPreserveStrings -Json $raw } catch { throw "$Label is not valid JSON: $Path`n$($_.Exception.Message)" }
}

function Get-RequiredString($Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    Assert-True ($null -ne $property -and $null -ne $property.Value) "$Label is missing required field '$Name'."
    Assert-True ($property.Value -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) "$Label field '$Name' must be a non-empty JSON string."
    return [string]$property.Value
}

function Get-RequiredInt64($Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    Assert-True ($null -ne $property -and $null -ne $property.Value) "$Label is missing required field '$Name'."
    $value = $property.Value
    $typeCode = [Type]::GetTypeCode($value.GetType())
    $integralTypes = @([TypeCode]::SByte,[TypeCode]::Byte,[TypeCode]::Int16,[TypeCode]::UInt16,[TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64)
    Assert-True ($typeCode -in $integralTypes) "$Label field '$Name' must be a JSON integer."
    try { return [Convert]::ToInt64($value) } catch { throw "$Label field '$Name' is outside the signed 64-bit range." }
}

function Assert-Ordinal([string]$Actual, [string]$Expected, [string]$Message) {
    Assert-True ([string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) $Message
}

function Resolve-EvidencePaths([string[]]$InputPath) {
    $resolved = @()
    foreach ($candidate in $InputPath) {
        Assert-True (-not [string]::IsNullOrWhiteSpace($candidate)) 'Client netprobe evidence path cannot be empty.'
        if ([Management.Automation.WildcardPattern]::ContainsWildcardCharacters($candidate)) {
            $matches = @(Get-ChildItem -Path $candidate -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
            Assert-True ($matches.Count -gt 0) "Client netprobe evidence wildcard matched no files: $candidate"
            $resolved += $matches
        } else {
            Assert-True (Test-Path -LiteralPath $candidate -PathType Leaf) "Client netprobe evidence file is missing: $candidate"
            $resolved += (Get-Item -LiteralPath $candidate).FullName
        }
    }
    $resolved = @($resolved | Sort-Object -Unique)
    Assert-True ($resolved.Count -gt 0) 'At least one client netprobe evidence file is required.'
    return $resolved
}

function Validate-Probe($Probe, [string]$Label, [string]$ExpectedTransport, [string]$ExpectedTarget, [string]$Version, [string]$Commit, [string]$PeerId, [DateTimeOffset]$EvidenceTime) {
    Assert-True ($Probe -is [pscustomobject]) "$Label must be a JSON object."
    Assert-True ((Get-RequiredInt64 $Probe 'schema' $Label) -eq 1) "$Label schema must be 1."
    Assert-Ordinal (Get-RequiredString $Probe 'status' $Label) 'pass' "$Label status must be pass."
    Assert-Ordinal (Get-RequiredString $Probe 'tool' $Label) 'konofix-netprobe' "$Label tool must be konofix-netprobe."
    Assert-Ordinal (Get-RequiredString $Probe 'version' $Label) $Version "$Label version does not match BUILD_INFO."
    Assert-Ordinal (Get-RequiredString $Probe 'source_commit' $Label) $Commit "$Label source_commit does not match BUILD_INFO."
    Assert-Ordinal (Get-RequiredString $Probe 'transport' $Label) $ExpectedTransport "$Label transport mismatch."
    Assert-Ordinal (Get-RequiredString $Probe 'target' $Label) $ExpectedTarget "$Label target does not match SESSION_INFO."
    Assert-Ordinal (Get-RequiredString $Probe 'expected_peer_id' $Label) $PeerId "$Label expected_peer_id mismatch."
    Assert-Ordinal (Get-RequiredString $Probe 'observed_peer_id' $Label) $PeerId "$Label observed_peer_id mismatch."
    Assert-Ordinal (Get-RequiredString $Probe 'protocol_version' $Label) '/konofix/4.0' "$Label protocol_version mismatch."
    Assert-Ordinal (Get-RequiredString $Probe 'agent_version' $Label) "Konofix-Node/$Version" "$Label agent_version mismatch."
    Assert-True ((Get-RequiredInt64 $Probe 'rtt_micros' $Label) -ge 0) "$Label rtt_micros must be non-negative."
    Assert-True ((Get-RequiredInt64 $Probe 'elapsed_millis' $Label) -ge 0) "$Label elapsed_millis must be non-negative."
    $timestamp = Get-RequiredInt64 $Probe 'timestamp_unix' $Label
    Assert-True ($timestamp -gt 0) "$Label timestamp_unix must be positive."
    $probeTime = [DateTimeOffset]::FromUnixTimeSeconds($timestamp)
    Assert-True ($probeTime -le [DateTimeOffset]::UtcNow.AddMinutes(5)) "$Label timestamp is in the future."
    Assert-True ($probeTime -ge $EvidenceTime.AddMinutes(-15) -and $probeTime -le $EvidenceTime.AddMinutes(5)) "$Label timestamp is not coherent with the evidence capture time."
}

$sessionInfoPath = [IO.Path]::GetFullPath($SessionInfoPath)
$buildInfoPath = [IO.Path]::GetFullPath($BuildInfoPath)
$session = Read-BoundedJson -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'
$buildInfo = Read-BoundedJson -Path $buildInfoPath -MaxBytes 262144 -Label 'BUILD_INFO.json'
Assert-True ($session -is [pscustomobject]) 'SESSION_INFO root must be a JSON object.'
Assert-True ($buildInfo -is [pscustomobject]) 'BUILD_INFO root must be a JSON object.'
Assert-True ((Get-RequiredInt64 $session 'schema_version' 'SESSION_INFO') -eq 1) 'Unsupported SESSION_INFO schema.'
Assert-True ((Get-RequiredInt64 $buildInfo 'schema' 'BUILD_INFO') -eq 2) 'Client netprobe evidence requires BUILD_INFO schema 2.'
Assert-Ordinal (Get-RequiredString $buildInfo 'product' 'BUILD_INFO') 'Konofix Chat' 'BUILD_INFO product mismatch.'

$version = Get-RequiredString $buildInfo 'version' 'BUILD_INFO'
$commit = Get-RequiredString $buildInfo 'commit' 'BUILD_INFO'
Assert-True ($commit -cmatch '^[0-9a-f]{40}$') 'BUILD_INFO commit must be a canonical lowercase 40-character Git SHA.'
Assert-Ordinal (Get-RequiredString $session 'build_version' 'SESSION_INFO') $version 'SESSION_INFO build_version does not match BUILD_INFO.'
Assert-Ordinal (Get-RequiredString $session 'node_version' 'SESSION_INFO') $version 'SESSION_INFO node_version does not match BUILD_INFO.'
Assert-Ordinal (Get-RequiredString $session 'source_commit' 'SESSION_INFO') $commit 'SESSION_INFO source_commit does not match BUILD_INFO.'

$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Ordinal (Get-RequiredString $session 'build_info_sha256' 'SESSION_INFO') $actualBuildInfoHash 'SESSION_INFO build_info_sha256 does not match BUILD_INFO.'
$peerId = Get-RequiredString $session 'bootstrap_peer_id' 'SESSION_INFO'
$tcpBootstrap = Get-RequiredString $session 'tcp_bootstrap' 'SESSION_INFO'
$quicBootstrap = Get-RequiredString $session 'quic_bootstrap' 'SESSION_INFO'

# The evidence validator is also a trust boundary. Do not rely only on the capture
# helper having prevalidated these addresses: imported/offline evidence must carry
# structurally valid public bootstraps and real libp2p Peer ID multihashes too.
$internetTest = Join-Path $PSScriptRoot 'internet-test.ps1'
Assert-True (Test-Path -LiteralPath $internetTest -PathType Leaf) "Required bootstrap validator is missing: $internetTest"
$tcpParsed = (& $internetTest -Bootstrap $tcpBootstrap -ValidateOnly -RequirePublicHost -AsJson) | ConvertFrom-Json
$quicParsed = (& $internetTest -Bootstrap $quicBootstrap -ValidateOnly -RequirePublicHost -AsJson) | ConvertFrom-Json
Assert-Ordinal ([string]$tcpParsed.peer_id) $peerId 'SESSION_INFO bootstrap_peer_id does not match TCP bootstrap Peer ID.'
Assert-Ordinal ([string]$quicParsed.peer_id) $peerId 'SESSION_INFO bootstrap_peer_id does not match QUIC bootstrap Peer ID.'
Assert-Ordinal ([string]$tcpParsed.transport) 'tcp' 'SESSION_INFO tcp_bootstrap must use TCP.'
Assert-Ordinal ([string]$quicParsed.transport) 'quic-v1' 'SESSION_INFO quic_bootstrap must use QUIC-v1.'

$netprobeMeta = $buildInfo.PSObject.Properties['netprobe'].Value
Assert-True ($netprobeMeta -is [pscustomobject]) 'BUILD_INFO is missing netprobe metadata.'
$netprobeRelativePath = Get-RequiredString $netprobeMeta 'path' 'BUILD_INFO.netprobe'
Assert-Ordinal $netprobeRelativePath 'konofix-netprobe.exe' 'BUILD_INFO netprobe path must be konofix-netprobe.exe.'
$netprobeBytes = Get-RequiredInt64 $netprobeMeta 'bytes' 'BUILD_INFO.netprobe'
Assert-True ($netprobeBytes -gt 0) 'BUILD_INFO netprobe.bytes must be positive.'
$netprobeHash = Get-RequiredString $netprobeMeta 'sha256' 'BUILD_INFO.netprobe'
Assert-True ($netprobeHash -cmatch '^[0-9a-f]{64}$') 'BUILD_INFO netprobe.sha256 must be canonical lowercase hexadecimal.'
$netprobePath = Join-Path (Split-Path $buildInfoPath -Parent) $netprobeRelativePath
Assert-True (Test-Path -LiteralPath $netprobePath -PathType Leaf) "Netprobe binary referenced by BUILD_INFO is missing: $netprobePath"
Assert-True ([int64](Get-Item -LiteralPath $netprobePath).Length -eq $netprobeBytes) 'konofix-netprobe.exe size does not match BUILD_INFO.'
$actualNetprobeHash = (Get-FileHash -LiteralPath $netprobePath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Ordinal $actualNetprobeHash $netprobeHash 'konofix-netprobe.exe SHA-256 does not match BUILD_INFO.'

$clientA = $session.PSObject.Properties['client_a'].Value
$clientB = $session.PSObject.Properties['client_b'].Value
Assert-True ($clientA -is [pscustomobject] -and $clientB -is [pscustomobject]) 'SESSION_INFO client metadata must contain client_a and client_b objects.'
$expectedClients = @{
    A = [ordered]@{
        id = Get-RequiredString $clientA 'id' 'SESSION_INFO.client_a'
        country = Get-RequiredString $clientA 'country' 'SESSION_INFO.client_a'
        network = Get-RequiredString $clientA 'network' 'SESSION_INFO.client_a'
    }
    B = [ordered]@{
        id = Get-RequiredString $clientB 'id' 'SESSION_INFO.client_b'
        country = Get-RequiredString $clientB 'country' 'SESSION_INFO.client_b'
        network = Get-RequiredString $clientB 'network' 'SESSION_INFO.client_b'
    }
}

$resolvedEvidence = @(Resolve-EvidencePaths $Evidence)
$rolesSeen = @()
$records = @()
foreach ($path in $resolvedEvidence) {
    $data = Read-BoundedJson -Path $path -MaxBytes $MaxEvidenceBytes -Label 'Client netprobe evidence'
    Assert-True ($data -is [pscustomobject]) "Client netprobe evidence root must be an object: $path"
    Assert-True ((Get-RequiredInt64 $data 'schema_version' $path) -eq 1) "Unsupported client netprobe evidence schema: $path"
    Assert-Ordinal (Get-RequiredString $data 'product' $path) 'Konofix Chat' "Client netprobe evidence product mismatch: $path"
    $role = Get-RequiredString $data 'client_role' $path
    Assert-True ($role -in @('A','B')) "Client netprobe evidence role must be A or B: $path"
    Assert-True ($rolesSeen -notcontains $role) "Duplicate client netprobe evidence role '$role'."
    $rolesSeen += $role
    $expected = $expectedClients[$role]
    Assert-Ordinal (Get-RequiredString $data 'client_id' $path) $expected.id "Client netprobe evidence client_id does not match SESSION_INFO for role $role."
    Assert-Ordinal (Get-RequiredString $data 'client_country' $path) $expected.country "Client netprobe evidence client_country does not match SESSION_INFO for role $role."
    Assert-Ordinal (Get-RequiredString $data 'client_network' $path) $expected.network "Client netprobe evidence client_network does not match SESSION_INFO for role $role."
    Assert-Ordinal (Get-RequiredString $data 'build_version' $path) $version "Client netprobe evidence build_version mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'source_commit' $path) $commit "Client netprobe evidence source_commit mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'build_info_sha256' $path) $actualBuildInfoHash "Client netprobe evidence BUILD_INFO hash mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'session_info_sha256' $path) $actualSessionInfoHash "Client netprobe evidence SESSION_INFO hash mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'netprobe_sha256' $path) $actualNetprobeHash "Client netprobe evidence netprobe hash mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'bootstrap_peer_id' $path) $peerId "Client netprobe evidence bootstrap Peer ID mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'tcp_bootstrap' $path) $tcpBootstrap "Client netprobe evidence TCP bootstrap mismatch: $path"
    Assert-Ordinal (Get-RequiredString $data 'quic_bootstrap' $path) $quicBootstrap "Client netprobe evidence QUIC bootstrap mismatch: $path"

    $createdRaw = Get-RequiredString $data 'created_utc' $path
    $created = [DateTimeOffset]::MinValue
    Assert-True ([DateTimeOffset]::TryParse($createdRaw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$created)) "Client netprobe evidence has invalid created_utc: $path"
    $created = $created.ToUniversalTime()
    $age = [DateTimeOffset]::UtcNow - $created
    Assert-True ($age.TotalMinutes -ge -5) "Client netprobe evidence timestamp is in the future: $path"
    Assert-True ($age.TotalDays -le $MaxAgeDays) "Client netprobe evidence is older than $MaxAgeDays days: $path"

    $tcpProbe = $data.PSObject.Properties['tcp_probe'].Value
    $quicProbe = $data.PSObject.Properties['quic_probe'].Value
    Validate-Probe -Probe $tcpProbe -Label "$path tcp_probe" -ExpectedTransport 'tcp' -ExpectedTarget $tcpBootstrap -Version $version -Commit $commit -PeerId $peerId -EvidenceTime $created
    Validate-Probe -Probe $quicProbe -Label "$path quic_probe" -ExpectedTransport 'quic-v1' -ExpectedTarget $quicBootstrap -Version $version -Commit $commit -PeerId $peerId -EvidenceTime $created

    $records += [pscustomobject]@{ role = $role; path = $path; created_utc = $createdRaw }
}

if ($RequireBothClients) {
    Assert-True ($resolvedEvidence.Count -eq 2) 'Stable promotion requires exactly two client netprobe evidence files.'
    Assert-True ($rolesSeen -contains 'A' -and $rolesSeen -contains 'B') 'Stable promotion requires authenticated TCP and QUIC evidence from both Client A and Client B.'
}

$result = [ordered]@{
    schema = 1
    status = 'PASS'
    version = $version
    source_commit = $commit
    bootstrap_peer_id = $peerId
    session_info_sha256 = $actualSessionInfoHash
    netprobe_sha256 = $actualNetprobeHash
    evidence_count = $resolvedEvidence.Count
    client_roles = @($rolesSeen | Sort-Object)
    authenticated_tcp = $true
    authenticated_quic_v1 = $true
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4
    return
}

Write-Host '=== Konofix client Netprobe evidence ===' -ForegroundColor Cyan
Write-Host "Build:      $version / $commit"
Write-Host "Peer ID:    $peerId"
Write-Host "Session:    $actualSessionInfoHash"
Write-Host "Clients:    $($result.client_roles -join ', ')"
Write-Host "Netprobe:   $actualNetprobeHash"
Write-Host 'PASS - exact-build Noise-authenticated TCP and QUIC-v1 probes match the exact test session.' -ForegroundColor Green
