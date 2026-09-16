[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PublicHost,

  [ValidateRange(1, 65535)]
  [int]$Port = 45555,

  [ValidateRange(10, 3600)]
  [int]$StatusInterval = 30,

  [string]$StateDirectory = '',
  [string]$IdentityFile = '',
  [string]$HealthFile = '',
  [string]$NodePath = '',

  [switch]$AllowPrivateAddress,
  [switch]$RequireDnsResolution,
  [switch]$Start,
  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

function Test-NonPublicIp([System.Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    $a = [int]$bytes[0]
    $b = [int]$bytes[1]
    $c = [int]$bytes[2]

    if ($a -eq 0 -or $a -eq 10 -or $a -eq 127) { return $true }
    if ($a -eq 100 -and $b -ge 64 -and $b -le 127) { return $true }
    if ($a -eq 169 -and $b -eq 254) { return $true }
    if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $true }
    if ($a -eq 192 -and $b -eq 0 -and $c -eq 0) { return $true }
    if ($a -eq 192 -and $b -eq 0 -and $c -eq 2) { return $true }
    if ($a -eq 192 -and $b -eq 168) { return $true }
    if ($a -eq 198 -and ($b -eq 18 -or $b -eq 19)) { return $true }
    if ($a -eq 198 -and $b -eq 51 -and $c -eq 100) { return $true }
    if ($a -eq 203 -and $b -eq 0 -and $c -eq 113) { return $true }
    if ($a -ge 224) { return $true }
    return $false
  }

  if ($Address.Equals([System.Net.IPAddress]::IPv6Any) -or
      $Address.Equals([System.Net.IPAddress]::IPv6Loopback) -or
      $Address.IsIPv6LinkLocal -or
      $Address.IsIPv6SiteLocal -or
      $Address.IsIPv6Multicast) {
    return $true
  }

  if (([int]$bytes[0] -band 0xfe) -eq 0xfc) { return $true }
  if ($bytes.Length -ge 4 -and $bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and $bytes[2] -eq 0x0d -and $bytes[3] -eq 0xb8) { return $true }
  return $false
}

function Get-FullPath([string]$PathValue, [string]$Label) {
  try {
    return [System.IO.Path]::GetFullPath($PathValue)
  } catch {
    throw "Invalid $Label path '$PathValue': $($_.Exception.Message)"
  }
}

if ($Start -and $AsJson) {
  throw 'Use either -Start or -AsJson, not both.'
}

$publicHostValue = $PublicHost.Trim()
if ($publicHostValue.StartsWith('[') -and $publicHostValue.EndsWith(']') -and $publicHostValue.Length -gt 2) {
  $publicHostValue = $publicHostValue.Substring(1, $publicHostValue.Length - 2)
}
if ([string]::IsNullOrWhiteSpace($publicHostValue) -or $publicHostValue.Contains('/') -or $publicHostValue -match '\s') {
  throw "Invalid public host: $PublicHost"
}

$parsedIp = $null
$isIp = [System.Net.IPAddress]::TryParse($publicHostValue, [ref]$parsedIp)
if ($isIp) {
  if ($parsedIp.IsIPv4MappedToIPv6) {
    $parsedIp = $parsedIp.MapToIPv4()
  }
  $publicHostValue = $parsedIp.ToString()
  if ((Test-NonPublicIp $parsedIp) -and -not $AllowPrivateAddress) {
    throw "Public host '$publicHostValue' is private, local, CGNAT, documentation, multicast, or otherwise non-public. Use -AllowPrivateAddress only for controlled lab testing."
  }
  if ($parsedIp.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    $addressPrefix = "/ip4/$publicHostValue"
  } else {
    $addressPrefix = "/ip6/$publicHostValue"
  }
  $isDns = $false
} else {
  try {
    $idn = [System.Globalization.IdnMapping]::new()
    $publicHostValue = $idn.GetAscii($publicHostValue).TrimEnd('.').ToLowerInvariant()
  } catch {
    throw "Invalid public DNS name '$PublicHost': $($_.Exception.Message)"
  }
  if ([System.Uri]::CheckHostName($publicHostValue) -ne [System.UriHostNameType]::Dns) {
    throw "Invalid public DNS name: $PublicHost"
  }
  $labels = @($publicHostValue.Split('.', [System.StringSplitOptions]::RemoveEmptyEntries))
  $reservedDnsSuffixes = @('.localhost', '.local', '.invalid', '.test', '.example')
  if ($labels.Count -lt 2 -or $publicHostValue -ceq 'localhost' -or @($reservedDnsSuffixes | Where-Object { $publicHostValue.EndsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
    throw "Public DNS name '$publicHostValue' is local, single-label, or reserved for testing/documentation."
  }
  $addressPrefix = "/dns/$publicHostValue"
  $isDns = $true
}

if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
  $localData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localData)) {
    throw 'Could not determine LocalApplicationData. Specify -StateDirectory explicitly.'
  }
  $StateDirectory = Join-Path $localData 'Konofix Chat'
}
$stateFull = Get-FullPath $StateDirectory 'state directory'

if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
  $IdentityFile = Join-Path $stateFull 'node-identity.key'
}
if ([string]::IsNullOrWhiteSpace($HealthFile)) {
  $HealthFile = Join-Path $stateFull 'node-health.json'
}
$identityFull = Get-FullPath $IdentityFile 'identity file'
$healthFull = Get-FullPath $HealthFile 'health file'

if ([System.StringComparer]::OrdinalIgnoreCase.Equals($identityFull, $healthFull)) {
  throw 'Identity and health files must be different paths. Reusing one path could destroy the persistent Node identity.'
}
if (Test-Path $identityFull -PathType Container) {
  throw "Identity path points to a directory: $identityFull"
}
if (Test-Path $healthFull -PathType Container) {
  throw "Health path points to a directory: $healthFull"
}

$repoOrBundleRoot = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $bundleCandidate = Join-Path $repoOrBundleRoot 'konofix-node.exe'
  $sourceCandidate = Join-Path $repoOrBundleRoot 'src-tauri\target\release\konofix-node.exe'
  if (Test-Path $bundleCandidate -PathType Leaf) {
    $NodePath = $bundleCandidate
  } else {
    $NodePath = $sourceCandidate
  }
}
$nodeFull = Get-FullPath $NodePath 'Node executable'

if ([System.StringComparer]::OrdinalIgnoreCase.Equals($nodeFull, $identityFull)) {
  throw 'Identity file cannot be the Konofix Node executable.'
}
if ([System.StringComparer]::OrdinalIgnoreCase.Equals($nodeFull, $healthFull)) {
  throw 'Health file cannot be the Konofix Node executable.'
}

if ($isDns -and ($Start -or $RequireDnsResolution)) {
  try {
    $resolved = @([System.Net.Dns]::GetHostAddresses($publicHostValue))
  } catch {
    throw "Public DNS name '$publicHostValue' could not be resolved: $($_.Exception.Message)"
  }
  if ($resolved.Count -eq 0) {
    throw "Public DNS name '$publicHostValue' resolved to no addresses."
  }
  $publicResolved = @($resolved | Where-Object { -not (Test-NonPublicIp $_) })
  if ($publicResolved.Count -eq 0 -and -not $AllowPrivateAddress) {
    throw "Public DNS name '$publicHostValue' resolves only to private, local, or special-use addresses."
  }
}

$nodeArgs = @(
  '--port', [string]$Port,
  '--public-host', $publicHostValue,
  '--status-interval', [string]$StatusInterval,
  '--identity-file', $identityFull,
  '--health-file', $healthFull
)

$config = [ordered]@{
  schema = 1
  public_host = $publicHostValue
  port = $Port
  status_interval = $StatusInterval
  address_prefix = $addressPrefix
  bootstrap_tcp_template = "$addressPrefix/tcp/$Port/p2p/<PEER_ID>"
  bootstrap_quic_template = "$addressPrefix/udp/$Port/quic-v1/p2p/<PEER_ID>"
  state_directory = $stateFull
  identity_file = $identityFull
  health_file = $healthFull
  node_path = $nodeFull
  args = $nodeArgs
}

if ($AsJson) {
  $config | ConvertTo-Json -Depth 4
  return
}

Write-Host '=== Konofix Public Node Preflight ===' -ForegroundColor Cyan
Write-Host "Public host:      $publicHostValue"
Write-Host "TCP/QUIC port:    $Port"
Write-Host "Status interval:  ${StatusInterval}s"
Write-Host "Identity file:    $identityFull"
Write-Host "Health file:      $healthFull"
Write-Host "Node executable:  $nodeFull"
Write-Host "TCP template:     $($config.bootstrap_tcp_template)"
Write-Host "QUIC template:    $($config.bootstrap_quic_template)"
Write-Host 'Firewall/NAT: open or forward both TCP and UDP on the configured port.' -ForegroundColor Yellow

if (-not $Start) {
  Write-Host 'Preflight passed. Add -Start to launch the Node with this validated configuration.' -ForegroundColor Green
  return
}

if (-not (Test-Path $nodeFull -PathType Leaf)) {
  throw "Konofix Node executable is missing: $nodeFull"
}

foreach ($directory in @(
  $stateFull,
  (Split-Path $identityFull -Parent),
  (Split-Path $healthFull -Parent)
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

Write-Host 'Starting Konofix Node...' -ForegroundColor Green
& $nodeFull @nodeArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  throw "Konofix Node exited with code $exitCode."
}
