[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BuildInfoPath,

  [Parameter(Mandatory = $true)]
  [string]$SessionInfoPath,

  [Parameter(Mandatory = $true)]
  [string[]]$NetworkEvidence,

  [Parameter(Mandatory = $true)]
  [string[]]$ClientNetprobeEvidence,

  [Parameter(Mandatory = $true)]
  [string[]]$NodeSoakEvidence,

  [ValidateRange(1, 365)]
  [int]$NetworkEvidenceMaxAgeDays = 30,

  [ValidateRange(60, 604800)]
  [int]$NodeSoakMinSpanSeconds = 3600,

  [ValidateRange(10, 3600)]
  [int]$NodeSoakMaxGapSeconds = 180,

  [ValidateRange(10, 3600)]
  [int]$NodeSoakMaxAgeSeconds = 300,

  [ValidateRange(1024, 1048576)]
  [int64]$MaxBuildInfoBytes = 262144,

  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$snapshotHelper = Join-Path $PSScriptRoot 'evidence-snapshot.ps1'
if (-not (Test-Path -LiteralPath $snapshotHelper -PathType Leaf)) {
  throw "Required bounded evidence snapshot helper is missing: $snapshotHelper"
}
. $snapshotHelper

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    throw "BUILD_INFO is missing required field '$Name': $Path"
  }
  return $property.Value
}

function Get-StrictString {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Field
  )
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
    throw "BUILD_INFO field '$Field' must be a non-empty JSON string."
  }
  return [string]$Value
}

function Get-StrictInt64 {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Field
  )
  if ($null -eq $Value) { throw "BUILD_INFO field '$Field' cannot be null." }
  $typeCode = [System.Type]::GetTypeCode($Value.GetType())
  $integralTypes = @(
    [System.TypeCode]::SByte, [System.TypeCode]::Byte,
    [System.TypeCode]::Int16, [System.TypeCode]::UInt16,
    [System.TypeCode]::Int32, [System.TypeCode]::UInt32,
    [System.TypeCode]::Int64, [System.TypeCode]::UInt64
  )
  if ($typeCode -notin $integralTypes) {
    throw "BUILD_INFO field '$Field' must be a JSON integer."
  }
  try { return [Convert]::ToInt64($Value) } catch { throw "BUILD_INFO field '$Field' is outside the signed 64-bit range." }
}

function Resolve-EvidencePaths {
  param(
    [Parameter(Mandatory = $true)][string[]]$InputPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $resolved = @()
  foreach ($candidate in $InputPath) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      throw "$Label path cannot be empty or whitespace."
    }

    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($candidate)) {
      $matches = @(Get-ChildItem -Path $candidate -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
      if ($matches.Count -eq 0) {
        throw "$Label wildcard matched no files: $candidate"
      }
      $resolved += $matches
    } else {
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label file is missing: $candidate"
      }
      $resolved += (Get-Item -LiteralPath $candidate).FullName
    }
  }

  $resolved = @($resolved | Sort-Object -Unique)
  if ($resolved.Count -eq 0) { throw "$Label requires at least one file." }
  return $resolved
}

$scriptRoot = $PSScriptRoot
$networkValidator = Join-Path $scriptRoot 'validate-network-test-report.ps1'
$sessionValidator = Join-Path $scriptRoot 'validate-network-test-session.ps1'
$clientNetprobeValidator = Join-Path $scriptRoot 'validate-client-netprobe.ps1'
$soakValidator = Join-Path $scriptRoot 'validate-node-soak.ps1'
foreach ($tool in @($networkValidator, $sessionValidator, $clientNetprobeValidator, $soakValidator)) {
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
    throw "Required promotion validator is missing: $tool"
  }
}

$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $BuildInfoPath -MaxBytes $MaxBuildInfoBytes -Label 'BUILD_INFO.json'
$buildInfoFullPath = [string]$buildInfoSnapshot.Path
$buildInfo = $buildInfoSnapshot.Data
if ($buildInfo -isnot [pscustomobject]) { throw 'BUILD_INFO root must be a JSON object.' }
$schema = Get-StrictInt64 (Get-RequiredProperty $buildInfo 'schema' $buildInfoFullPath) 'schema'
if ($schema -ne 2) { throw "Stable promotion requires BUILD_INFO schema 2 with sealed Netprobe metadata; found schema $schema." }
$product = Get-StrictString (Get-RequiredProperty $buildInfo 'product' $buildInfoFullPath) 'product'
if ($product -cne 'Konofix Chat') { throw "Unexpected BUILD_INFO product: $product" }
$version = Get-StrictString (Get-RequiredProperty $buildInfo 'version' $buildInfoFullPath) 'version'
$commit = Get-StrictString (Get-RequiredProperty $buildInfo 'commit' $buildInfoFullPath) 'commit'
if ($commit -cnotmatch '^[0-9a-f]{40}$') { throw 'BUILD_INFO commit must be a canonical lowercase 40-character Git SHA.' }
$nodeMeta = Get-RequiredProperty $buildInfo 'node' $buildInfoFullPath
if ($nodeMeta -isnot [pscustomobject]) { throw 'BUILD_INFO node metadata must be a JSON object.' }
$nodePath = Get-StrictString (Get-RequiredProperty $nodeMeta 'path' $buildInfoFullPath) 'node.path'
if ($nodePath -cne 'konofix-node.exe') { throw "Unexpected BUILD_INFO Node path: $nodePath" }
$nodeBytes = Get-StrictInt64 (Get-RequiredProperty $nodeMeta 'bytes' $buildInfoFullPath) 'node.bytes'
if ($nodeBytes -le 0) { throw 'BUILD_INFO node.bytes must be positive.' }
$nodeHash = Get-StrictString (Get-RequiredProperty $nodeMeta 'sha256' $buildInfoFullPath) 'node.sha256'
if ($nodeHash -cnotmatch '^[0-9a-f]{64}$') { throw 'BUILD_INFO node.sha256 must be a canonical lowercase SHA-256.' }

$artifactRoot = Split-Path $buildInfoFullPath -Parent
$nodeBinaryPath = Join-Path $artifactRoot $nodePath
$actualBuildInfoHash = [string]$buildInfoSnapshot.Sha256
$verifiedNode = $null

try {
  $verifiedNode = Open-KonofixVerifiedExecutable `
    -Path $nodeBinaryPath `
    -ExpectedBytes $nodeBytes `
    -ExpectedSha256 $nodeHash `
    -Label 'Node binary'
  $actualNodeBytes = [int64]$verifiedNode.Bytes
  $actualNodeHash = [string]$verifiedNode.Sha256

  $resolvedNetworkEvidence = @(Resolve-EvidencePaths -InputPath $NetworkEvidence -Label 'Network evidence')
  $resolvedClientNetprobeEvidence = @(Resolve-EvidencePaths -InputPath $ClientNetprobeEvidence -Label 'Client Netprobe evidence')
  $resolvedNodeSoakEvidence = @(Resolve-EvidencePaths -InputPath $NodeSoakEvidence -Label 'Node soak evidence')

  $networkValidationJson = (& $networkValidator `
    -Manifest $resolvedNetworkEvidence `
    -RequireAllChecks `
    -MaxAgeDays $NetworkEvidenceMaxAgeDays `
    -ExpectedBuildVersion $version `
    -ExpectedNodeVersion $version `
    -ExpectedSourceCommit $commit `
    -RequireSingleBootstrapPeer `
    -AsJson | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($networkValidationJson)) {
    throw 'Network evidence validator returned no structured PASS aggregate.'
  }
  try { $networkValidation = $networkValidationJson | ConvertFrom-Json }
  catch { throw "Network evidence validator returned invalid JSON: $($_.Exception.Message)" }
  if ($networkValidation -isnot [pscustomobject] -or [string]$networkValidation.status -cne 'PASS') {
    throw 'Network evidence validator did not return the expected PASS aggregate.'
  }

  $sessionValidationJson = (& $sessionValidator `
    -SessionInfoPath $SessionInfoPath `
    -Manifest $resolvedNetworkEvidence `
    -ExpectedBuildVersion $version `
    -ExpectedNodeVersion $version `
    -ExpectedSourceCommit $commit `
    -ExpectedBuildInfoSha256 $actualBuildInfoHash `
    -ExpectedNodeSha256 $actualNodeHash `
    -AsJson | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($sessionValidationJson)) {
    throw 'Network session validator returned no structured PASS aggregate.'
  }
  try { $sessionValidation = $sessionValidationJson | ConvertFrom-Json }
  catch { throw "Network session validator returned invalid JSON: $($_.Exception.Message)" }
  if ($sessionValidation -isnot [pscustomobject] -or [string]$sessionValidation.status -cne 'PASS') {
    throw 'Network session validator did not return the expected PASS aggregate.'
  }

  $networkBootstrapProperty = $networkValidation.PSObject.Properties['bootstrap_peer_id']
  $sessionBootstrapProperty = $sessionValidation.PSObject.Properties['bootstrap_peer_id']
  if ($null -eq $networkBootstrapProperty -or $networkBootstrapProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$networkBootstrapProperty.Value)) {
    throw 'Network evidence validator PASS aggregate is missing bootstrap_peer_id.'
  }
  if ($null -eq $sessionBootstrapProperty -or $sessionBootstrapProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$sessionBootstrapProperty.Value)) {
    throw 'Network session validator PASS aggregate is missing bootstrap_peer_id.'
  }
  $networkBootstrapPeer = [string]$networkBootstrapProperty.Value
  $bootstrapPeer = [string]$sessionBootstrapProperty.Value
  if ($networkBootstrapPeer -cne $bootstrapPeer) {
    throw 'Network evidence bootstrap Peer ID changed between report and session validation.'
  }

  $networkSnapshots = @($networkValidation.manifests)
  $sessionSnapshots = @($sessionValidation.manifest_snapshots)
  if ($networkSnapshots.Count -ne $resolvedNetworkEvidence.Count -or $sessionSnapshots.Count -ne $resolvedNetworkEvidence.Count) {
    throw 'Promotion validators returned an unexpected manifest snapshot count.'
  }
  $sessionSnapshotsByName = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
  foreach ($snapshot in $sessionSnapshots) {
    $name = [IO.Path]::GetFileName([string]$snapshot.path)
    if ([string]::IsNullOrWhiteSpace($name) -or $sessionSnapshotsByName.ContainsKey($name)) {
      throw 'Network session validator returned an invalid or duplicate manifest snapshot path.'
    }
    $sessionSnapshotsByName.Add($name, $snapshot)
  }
  foreach ($snapshot in $networkSnapshots) {
    $name = [IO.Path]::GetFileName([string]$snapshot.path)
    if (-not $sessionSnapshotsByName.ContainsKey($name)) {
      throw "Network evidence validator returned a manifest absent from the validated session: $name"
    }
    $sessionSnapshot = $sessionSnapshotsByName[$name]
    if ([int64]$snapshot.bytes -ne [int64]$sessionSnapshot.bytes) {
      throw "Network evidence bytes changed between report and session validation: $name"
    }
    if ([string]$snapshot.sha256 -cne [string]$sessionSnapshot.sha256) {
      throw "Network evidence SHA-256 changed between report and session validation: $name"
    }
  }

  $clientProbeResult = (& $clientNetprobeValidator `
    -Evidence $resolvedClientNetprobeEvidence `
    -SessionInfoPath $SessionInfoPath `
    -BuildInfoPath $buildInfoFullPath `
    -MaxAgeDays $NetworkEvidenceMaxAgeDays `
    -RequireBothClients `
    -AsJson) | ConvertFrom-Json
  if ($clientProbeResult.status -cne 'PASS') { throw 'Client Netprobe evidence validator did not return PASS.' }
  if ([int]$clientProbeResult.evidence_count -ne 2) { throw 'Stable promotion requires exactly two authenticated client Netprobe evidence records.' }
  if (-not [bool]$clientProbeResult.authenticated_tcp -or -not [bool]$clientProbeResult.authenticated_quic_v1) {
    throw 'Stable promotion requires authenticated direct TCP and QUIC-v1 evidence from both clients.'
  }
  if (-not [bool]$clientProbeResult.distinct_hosts) {
    throw 'Stable promotion requires client evidence captured on two distinct Windows hosts.'
  }
  if (-not [bool]$clientProbeResult.distinct_network_contexts) {
    throw 'Stable promotion requires client evidence captured from two distinct default-route network contexts.'
  }
  if ([string]$clientProbeResult.bootstrap_peer_id -cne $bootstrapPeer) {
    throw 'Client Netprobe evidence Peer ID does not match the validated network evidence bootstrap Peer ID.'
  }

  & $soakValidator `
    -Snapshot $resolvedNodeSoakEvidence `
    -MinSpanSeconds $NodeSoakMinSpanSeconds `
    -MaxGapSeconds $NodeSoakMaxGapSeconds `
    -MaxAgeSeconds $NodeSoakMaxAgeSeconds `
    -ExpectedVersion $version `
    -ExpectedPeerId $bootstrapPeer `
    -ExpectedSourceCommit $commit `
    -ExpectedNodeSha256 $actualNodeHash `
    -ExpectedBuildInfoSha256 $actualBuildInfoHash `
    -RequirePeerObserved

  $result = [ordered]@{
    schema = 4
    status = 'PASS'
    product = $product
    version = $version
    source_commit = $commit
    bootstrap_peer_id = $bootstrapPeer
    network_manifest_count = $resolvedNetworkEvidence.Count
    client_netprobe_evidence_count = [int]$clientProbeResult.evidence_count
    authenticated_direct_tcp = [bool]$clientProbeResult.authenticated_tcp
    authenticated_direct_quic_v1 = [bool]$clientProbeResult.authenticated_quic_v1
    distinct_client_hosts = [bool]$clientProbeResult.distinct_hosts
    distinct_client_network_contexts = [bool]$clientProbeResult.distinct_network_contexts
    netprobe_sha256 = [string]$clientProbeResult.netprobe_sha256
    node_soak_snapshot_count = $resolvedNodeSoakEvidence.Count
    node_soak_exact_build_binding = $true
    node_binary_bytes = $actualNodeBytes
    node_binary_sha256 = $actualNodeHash
    build_info_sha256 = $actualBuildInfoHash
    coherent_test_session = $true
  }

  if ($AsJson) {
    $result | ConvertTo-Json -Depth 3
    return
  }

  Write-Host '=== Konofix Stable Promotion Evidence ===' -ForegroundColor Cyan
  Write-Host "Build version:            $version"
  Write-Host "Source commit:            $commit"
  Write-Host "Bootstrap Peer ID:        $bootstrapPeer"
  Write-Host "Network manifests:        $($resolvedNetworkEvidence.Count)"
  Write-Host "Client Netprobe records:  $($clientProbeResult.evidence_count)"
  Write-Host "Authenticated TCP/QUIC:   PASS / PASS"
  Write-Host 'Distinct client hosts:    PASS'
  Write-Host 'Distinct client networks: PASS'
  Write-Host "Node soak snapshots:      $($resolvedNodeSoakEvidence.Count)"
  Write-Host 'Node soak artifact bind:  PASS'
  Write-Host "Node SHA-256:             $actualNodeHash"
  Write-Host 'PASS - packaged Node/Netprobe provenance, exact-build-bound public-Node soak history, authenticated TCP+QUIC probes from two distinct Windows hosts and default-route network contexts, one coherent cross-country test session, required network scenarios and public-Node soak evidence all match the exact verified Windows build.' -ForegroundColor Green
} finally {
  if ($null -ne $verifiedNode -and $null -ne $verifiedNode.Stream) {
    $verifiedNode.Stream.Dispose()
  }
}
