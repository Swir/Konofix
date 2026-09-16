[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BuildInfoPath,

  [Parameter(Mandatory = $true)]
  [string[]]$NetworkEvidence,

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

function Read-BuildInfo([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "BUILD_INFO file is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -le 0) { throw "BUILD_INFO file is empty: $Path" }
  if ($item.Length -gt $MaxBuildInfoBytes) {
    throw "BUILD_INFO exceeds the maximum allowed size of $MaxBuildInfoBytes bytes: $Path"
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  if (-not $raw.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) {
    throw "BUILD_INFO root must be a JSON object: $Path"
  }
  try { return $raw | ConvertFrom-Json } catch { throw "BUILD_INFO is not valid JSON: $($_.Exception.Message)" }
}

$scriptRoot = $PSScriptRoot
$networkValidator = Join-Path $scriptRoot 'validate-network-test-report.ps1'
$soakValidator = Join-Path $scriptRoot 'validate-node-soak.ps1'
foreach ($tool in @($networkValidator, $soakValidator)) {
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
    throw "Required promotion validator is missing: $tool"
  }
}

$buildInfoFullPath = [IO.Path]::GetFullPath($BuildInfoPath)
$buildInfo = Read-BuildInfo $buildInfoFullPath
if ($buildInfo -isnot [pscustomobject]) { throw 'BUILD_INFO root must be a JSON object.' }
$schema = Get-StrictInt64 (Get-RequiredProperty $buildInfo 'schema' $buildInfoFullPath) 'schema'
if ($schema -ne 1) { throw "Unsupported BUILD_INFO schema: $schema" }
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
if (-not (Test-Path -LiteralPath $nodeBinaryPath -PathType Leaf)) {
  throw "Node binary referenced by BUILD_INFO is missing beside the artifact metadata: $nodeBinaryPath"
}
$actualNodeBytes = [int64](Get-Item -LiteralPath $nodeBinaryPath).Length
if ($actualNodeBytes -ne $nodeBytes) {
  throw "Node binary size does not match BUILD_INFO. expected=$nodeBytes actual=$actualNodeBytes"
}
$actualNodeHash = (Get-FileHash -LiteralPath $nodeBinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not [string]::Equals($actualNodeHash, $nodeHash, [StringComparison]::Ordinal)) {
  throw "Node binary SHA-256 does not match BUILD_INFO. expected=$nodeHash actual=$actualNodeHash"
}

if ($NetworkEvidence.Count -eq 0) { throw 'At least one network-evidence manifest is required.' }
if ($NodeSoakEvidence.Count -eq 0) { throw 'At least one Node-soak snapshot is required.' }

& $networkValidator `
  -Manifest $NetworkEvidence `
  -RequireAllChecks `
  -MaxAgeDays $NetworkEvidenceMaxAgeDays `
  -ExpectedBuildVersion $version `
  -ExpectedNodeVersion $version `
  -ExpectedSourceCommit $commit `
  -RequireSingleBootstrapPeer

$bootstrapPeers = @()
foreach ($manifestPath in $NetworkEvidence) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $bootstrap = [string]$manifest.bootstrap
  $match = [regex]::Match($bootstrap, '/p2p/([^/]+)$')
  if (-not $match.Success) { throw "Validated network evidence has no terminal bootstrap Peer ID: $manifestPath" }
  $bootstrapPeers += $match.Groups[1].Value
}
$bootstrapPeers = @($bootstrapPeers | Sort-Object -Unique -CaseSensitive)
if ($bootstrapPeers.Count -ne 1) { throw 'Promotion evidence must reference exactly one bootstrap Peer ID.' }
$bootstrapPeer = $bootstrapPeers[0]

& $soakValidator `
  -Snapshot $NodeSoakEvidence `
  -MinSpanSeconds $NodeSoakMinSpanSeconds `
  -MaxGapSeconds $NodeSoakMaxGapSeconds `
  -MaxAgeSeconds $NodeSoakMaxAgeSeconds `
  -ExpectedVersion $version `
  -ExpectedPeerId $bootstrapPeer `
  -ExpectedSourceCommit $commit `
  -RequirePeerObserved

$result = [ordered]@{
  schema = 1
  status = 'PASS'
  product = $product
  version = $version
  source_commit = $commit
  bootstrap_peer_id = $bootstrapPeer
  network_manifest_count = $NetworkEvidence.Count
  node_soak_snapshot_count = $NodeSoakEvidence.Count
  node_binary_bytes = $actualNodeBytes
  node_binary_sha256 = $actualNodeHash
}

if ($AsJson) {
  $result | ConvertTo-Json -Depth 3
  return
}

Write-Host '=== Konofix Stable Promotion Evidence ===' -ForegroundColor Cyan
Write-Host "Build version:       $version"
Write-Host "Source commit:       $commit"
Write-Host "Bootstrap Peer ID:   $bootstrapPeer"
Write-Host "Network manifests:   $($NetworkEvidence.Count)"
Write-Host "Node soak snapshots: $($NodeSoakEvidence.Count)"
Write-Host "Node SHA-256:        $actualNodeHash"
Write-Host 'PASS - packaged Node bytes, network scenarios and public-Node soak evidence match the exact verified Windows build.' -ForegroundColor Green
