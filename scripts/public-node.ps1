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

function Test-IpInCidr([System.Net.IPAddress]$Address, [string]$Network, [int]$PrefixLength) {
  $networkAddress = [System.Net.IPAddress]::Parse($Network)
  if ($Address.AddressFamily -ne $networkAddress.AddressFamily) { return $false }

  $addressBytes = $Address.GetAddressBytes()
  $networkBytes = $networkAddress.GetAddressBytes()
  $bitCount = $addressBytes.Length * 8
  if ($PrefixLength -lt 0 -or $PrefixLength -gt $bitCount) {
    throw "Invalid CIDR prefix length $PrefixLength for $Network."
  }

  $fullBytes = [Math]::Floor($PrefixLength / 8)
  for ($i = 0; $i -lt $fullBytes; $i++) {
    if ($addressBytes[$i] -ne $networkBytes[$i]) { return $false }
  }

  $remainingBits = $PrefixLength % 8
  if ($remainingBits -eq 0) { return $true }
  $mask = [byte](0xFF -band (0xFF -shl (8 - $remainingBits)))
  return (($addressBytes[$fullBytes] -band $mask) -eq ($networkBytes[$fullBytes] -band $mask))
}

function Test-GloballyRoutableIp([System.Net.IPAddress]$Address) {
  if ($Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    foreach ($blocked in @(
      @('0.0.0.0', 8),
      @('10.0.0.0', 8),
      @('100.64.0.0', 10),
      @('127.0.0.0', 8),
      @('169.254.0.0', 16),
      @('172.16.0.0', 12),
      @('192.0.0.0', 24),
      @('192.0.2.0', 24),
      @('192.88.99.0', 24),
      @('192.168.0.0', 16),
      @('198.18.0.0', 15),
      @('198.51.100.0', 24),
      @('203.0.113.0', 24),
      @('224.0.0.0', 4),
      @('240.0.0.0', 4)
    )) {
      if (Test-IpInCidr -Address $Address -Network ([string]$blocked[0]) -PrefixLength ([int]$blocked[1])) {
        return $false
      }
    }
    return $true
  }

  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
    return $false
  }
  if ($Address.IsIPv4MappedToIPv6) {
    return Test-GloballyRoutableIp ($Address.MapToIPv4())
  }
  if ($Address.Equals([System.Net.IPAddress]::IPv6Any) -or
      $Address.Equals([System.Net.IPAddress]::IPv6Loopback) -or
      $Address.IsIPv6LinkLocal -or
      $Address.IsIPv6SiteLocal -or
      $Address.IsIPv6Multicast) {
    return $false
  }

  if (-not (Test-IpInCidr -Address $Address -Network '2000::' -PrefixLength 3)) { return $false }
  foreach ($blocked in @(
    @('2001:2::', 48),
    @('2001:db8::', 32),
    @('2001:10::', 28),
    @('2001:20::', 28),
    @('3fff::', 20)
  )) {
    if (Test-IpInCidr -Address $Address -Network ([string]$blocked[0]) -PrefixLength ([int]$blocked[1])) {
      return $false
    }
  }
  return $true
}

function Test-ReservedPublicDnsName([string]$HostName) {
  $normalized = $HostName.TrimEnd('.').ToLowerInvariant()
  foreach ($suffix in @(
    'localhost', 'local', 'invalid', 'test', 'example',
    'example.com', 'example.net', 'example.org',
    'onion', 'alt', 'arpa', 'internal'
  )) {
    if ($normalized -eq $suffix -or $normalized.EndsWith('.' + $suffix, [System.StringComparison]::Ordinal)) {
      return $true
    }
  }
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
  if (-not (Test-GloballyRoutableIp $parsedIp) -and -not $AllowPrivateAddress) {
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
  if ($labels.Count -lt 2 -or (Test-ReservedPublicDnsName $publicHostValue)) {
    throw "Public DNS name '$publicHostValue' is local, single-label, or reserved for testing/documentation/private/special use."
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
  $nonPublicResolved = @($resolved | Where-Object { -not (Test-GloballyRoutableIp $_) })
  if ($nonPublicResolved.Count -gt 0 -and -not $AllowPrivateAddress) {
    $joined = ($nonPublicResolved | ForEach-Object { $_.ToString() }) -join ', '
    throw "Public DNS name '$publicHostValue' resolves to non-public address(es): $joined"
  }
}

$nodeArgs = @(
  '--port', [string]$Port,
  '--public-host', $publicHostValue,
  '--status-interval', [string]$StatusInterval,
  '--identity-file', $identityFull,
  '--health-file', $healthFull
)
if ($AllowPrivateAddress) { $nodeArgs += '--allow-private-address' }

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
