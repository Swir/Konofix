[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$Bootstrap,
  [switch]$ValidateOnly,
  [switch]$AsJson,
  [switch]$RequirePublicHost,
  [switch]$RequireDnsResolution
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

  # Public evidence deliberately accepts only IPv6 global-unicast space and excludes
  # documentation/benchmark/ORCHID special-use ranges that sit inside 2000::/3.
  if (-not (Test-IpInCidr -Address $Address -Network '2000::' -PrefixLength 3)) { return $false }
  foreach ($blocked in @(
    @('2001:2::', 48),
    @('2001:db8::', 32),
    @('2001:10::', 28),
    @('2001:20::', 28)
  )) {
    if (Test-IpInCidr -Address $Address -Network ([string]$blocked[0]) -PrefixLength ([int]$blocked[1])) {
      return $false
    }
  }
  return $true
}

function Test-ReservedPublicDnsName([string]$HostName) {
  $normalized = $HostName.TrimEnd('.').ToLowerInvariant()

  # Public-node evidence deliberately rejects DNS namespaces designated for
  # documentation, private/local use, alternate resolution, onion services or
  # DNS protocol infrastructure. IANA special-use status applies to subdomains too.
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

function ConvertFrom-Base58([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw 'Base58 value cannot be empty.'
  }

  $alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  $decoded = [System.Collections.Generic.List[byte]]::new()

  foreach ($character in $Value.ToCharArray()) {
    $digit = $alphabet.IndexOf($character)
    if ($digit -lt 0) {
      throw "Invalid base58 character '$character'."
    }

    $carry = [int]$digit
    for ($i = $decoded.Count - 1; $i -ge 0; $i--) {
      # PowerShell variable names are case-insensitive. Do not call this $value:
      # that would overwrite the $Value input string and break leading-zero
      # restoration for identity Peer IDs beginning with base58 '1'.
      $accumulator = ([int]$decoded[$i] * 58) + $carry
      $decoded[$i] = [byte]($accumulator -band 0xFF)
      $carry = [Math]::Floor($accumulator / 256)
    }
    while ($carry -gt 0) {
      $decoded.Insert(0, [byte]($carry -band 0xFF))
      $carry = [Math]::Floor($carry / 256)
    }
  }

  $leadingZeros = 0
  while ($leadingZeros -lt $Value.Length -and $Value[$leadingZeros] -eq '1') {
    $leadingZeros++
  }

  $result = [byte[]]::new($leadingZeros + $decoded.Count)
  for ($i = 0; $i -lt $decoded.Count; $i++) {
    $result[$leadingZeros + $i] = $decoded[$i]
  }
  return $result
}

function Read-UnsignedVarint([byte[]]$Bytes, [ref]$Offset) {
  [uint64]$value = 0
  $shift = 0
  for ($i = 0; $i -lt 10; $i++) {
    if ($Offset.Value -ge $Bytes.Length) {
      throw 'Truncated unsigned varint.'
    }
    $current = [byte]$Bytes[$Offset.Value]
    # Avoid post-increment here: PowerShell writes the old value to the success
    # pipeline, which would turn the function result into an array plus $value.
    $Offset.Value = [int]$Offset.Value + 1
    if ($shift -ge 64 -and ($current -band 0x7F) -ne 0) {
      throw 'Unsigned varint is too large.'
    }
    $value = $value -bor ([uint64]($current -band 0x7F) -shl $shift)
    if (($current -band 0x80) -eq 0) {
      return $value
    }
    $shift += 7
  }
  throw 'Unsigned varint is too long.'
}

function Test-Libp2pPeerId([string]$PeerId) {
  try {
    # PeerId::from_multihash accepts sha2-256 multihashes and short identity
    # multihashes. Decode enough of the multihash envelope here so malformed
    # base58-looking strings cannot enter release/readiness evidence as Peer IDs.
    $bytes = @(ConvertFrom-Base58 -Value $PeerId)
    if ($bytes.Count -lt 3 -or $bytes.Count -gt 64) { return $false }

    $offset = 0
    [uint64]$code = Read-UnsignedVarint -Bytes ([byte[]]$bytes) -Offset ([ref]$offset)
    [uint64]$digestLength = Read-UnsignedVarint -Bytes ([byte[]]$bytes) -Offset ([ref]$offset)
    if ($digestLength -ne [uint64]($bytes.Count - $offset)) { return $false }

    if ($code -eq 0) {
      # libp2p inlines public-key multihashes only while the digest is small.
      return $digestLength -gt 0 -and $digestLength -le 42
    }
    if ($code -eq 0x12) {
      # sha2-256 Peer IDs carry exactly one 32-byte digest.
      return $digestLength -eq 32
    }
    return $false
  } catch {
    return $false
  }
}

function Resolve-PublicDnsAddresses([string]$HostProtocol, [string]$HostName) {
  try {
    $resolved = @([System.Net.Dns]::GetHostAddresses($HostName))
  } catch {
    throw "DNS bootstrap host '$HostName' could not be resolved: $($_.Exception.GetBaseException().Message)"
  }

  if ($HostProtocol -eq 'dns4') {
    $resolved = @($resolved | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork })
  } elseif ($HostProtocol -eq 'dns6') {
    $resolved = @($resolved | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6 })
  }

  if ($resolved.Count -eq 0) {
    throw "DNS bootstrap host '$HostName' returned no addresses compatible with '$HostProtocol'."
  }

  $nonPublic = @($resolved | Where-Object { -not (Test-GloballyRoutableIp $_) })
  if ($nonPublic.Count -gt 0) {
    $joined = ($nonPublic | ForEach-Object { $_.ToString() }) -join ', '
    throw "DNS bootstrap host '$HostName' resolves to non-public address(es): $joined"
  }

  return @($resolved | ForEach-Object { $_.ToString() } | Sort-Object -Unique)
}

function Parse-KonofixBootstrap([string]$Address) {
  $value = $Address.Trim()
  if (-not $value.StartsWith('/')) {
    throw 'Bootstrap multiaddr must start with /.'
  }

  $parts = @($value.Trim('/') -split '/')
  if ($parts.Count -lt 6) {
    throw 'Bootstrap multiaddr is incomplete.'
  }

  $hostProtocol = $parts[0]
  $hostName = $parts[1]
  if ($hostProtocol -notin @('ip4', 'ip6', 'dns', 'dns4', 'dns6')) {
    throw "Unsupported host protocol '$hostProtocol'. Use ip4, ip6, dns, dns4, or dns6."
  }
  if ([string]::IsNullOrWhiteSpace($hostName)) {
    throw 'Bootstrap host is empty.'
  }

  if ($hostProtocol -in @('ip4', 'ip6')) {
    $parsedIp = $null
    if (-not [System.Net.IPAddress]::TryParse($hostName, [ref]$parsedIp)) {
      throw "Invalid $hostProtocol address '$hostName'."
    }
    if ($hostProtocol -eq 'ip4' -and $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
      throw "Host '$hostName' is not an IPv4 address."
    }
    if ($hostProtocol -eq 'ip6' -and $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
      throw "Host '$hostName' is not an IPv6 address."
    }
  } else {
    if ($hostName.Length -gt 253 -or $hostName -notmatch '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$') {
      throw "Invalid DNS bootstrap host '$hostName'."
    }
  }

  $transport = $parts[2]
  $portValue = 0
  if (-not [int]::TryParse($parts[3], [ref]$portValue) -or $portValue -lt 1 -or $portValue -gt 65535) {
    throw "Invalid bootstrap port '$($parts[3])'. Expected 1-65535."
  }

  $peerId = $null
  if ($transport -eq 'tcp') {
    if ($parts.Count -ne 6 -or $parts[4] -ne 'p2p') {
      throw 'TCP bootstrap must use /HOST/tcp/PORT/p2p/PEER_ID with no extra segments.'
    }
    $peerId = $parts[5]
  } elseif ($transport -eq 'udp') {
    if ($parts.Count -ne 7 -or $parts[4] -ne 'quic-v1' -or $parts[5] -ne 'p2p') {
      throw 'UDP bootstrap must be QUIC v1: /HOST/udp/PORT/quic-v1/p2p/PEER_ID.'
    }
    $peerId = $parts[6]
  } else {
    throw "Unsupported transport '$transport'. Konofix Internet bootstrap supports TCP or UDP/QUIC v1."
  }

  if ([string]::IsNullOrWhiteSpace($peerId) -or $peerId -notmatch '^[1-9A-HJ-NP-Za-km-z]{20,128}$') {
    throw 'Peer ID is missing or is not valid base58btc text.'
  }
  if (-not (Test-Libp2pPeerId -PeerId $peerId)) {
    throw 'Peer ID is not a supported libp2p identity/sha2-256 multihash.'
  }

  [pscustomobject]@{
    address = $value
    host_protocol = $hostProtocol
    host = $hostName
    port = $portValue
    transport = if ($transport -eq 'udp') { 'quic-v1' } else { 'tcp' }
    peer_id = $peerId
  }
}

$parsed = Parse-KonofixBootstrap $Bootstrap
$resolvedAddresses = @()
$strictPublicValidation = $RequirePublicHost -or $RequireDnsResolution

if ($strictPublicValidation) {
  if ($parsed.host_protocol -in @('ip4', 'ip6')) {
    $parsedIp = [System.Net.IPAddress]::Parse([string]$parsed.host)
    if (-not (Test-GloballyRoutableIp $parsedIp)) {
      throw "Bootstrap IP '$($parsed.host)' is not globally routable and cannot be used as public-node evidence."
    }
    $resolvedAddresses = @([string]$parsed.host)
  } else {
    if ([string]$parsed.host -notmatch '\.') {
      throw "DNS bootstrap host '$($parsed.host)' must be a fully-qualified public hostname for public-node evidence."
    }
    if (Test-ReservedPublicDnsName ([string]$parsed.host)) {
      throw "DNS bootstrap host '$($parsed.host)' uses a reserved/private/special-use suffix and cannot be used as public-node evidence."
    }
    if ($RequireDnsResolution) {
      $resolvedAddresses = @(Resolve-PublicDnsAddresses -HostProtocol ([string]$parsed.host_protocol) -HostName ([string]$parsed.host))
    }
  }
}

$parsed | Add-Member -NotePropertyName public_host_validated -NotePropertyValue ([bool]$strictPublicValidation) -Force
$parsed | Add-Member -NotePropertyName dns_resolution_checked -NotePropertyValue ([bool]($RequireDnsResolution -and $parsed.host_protocol -in @('dns', 'dns4', 'dns6'))) -Force
$parsed | Add-Member -NotePropertyName resolved_addresses -NotePropertyValue @($resolvedAddresses) -Force

if ($AsJson) {
  $parsed | ConvertTo-Json -Depth 4 -Compress
} else {
  Write-Host '=== Konofix Chat 0.4.2 - INTERNET PRECHECK ===' -ForegroundColor Cyan
  Write-Host "Bootstrap: $($parsed.address)"
  Write-Host "Host: $($parsed.host)  Port: $($parsed.port)  Transport: $($parsed.transport)" -ForegroundColor Yellow
  Write-Host "Peer ID: $($parsed.peer_id)" -ForegroundColor DarkGray
  if ($strictPublicValidation) {
    Write-Host 'Public-host policy: globally routable endpoint required.' -ForegroundColor Green
  }
  if ($resolvedAddresses.Count -gt 0) {
    Write-Host "Resolved public address(es): $($resolvedAddresses -join ', ')" -ForegroundColor DarkGray
  }
}

if (-not $ValidateOnly) {
  if ($parsed.transport -eq 'tcp') {
    $result = Test-NetConnection -ComputerName $parsed.host -Port $parsed.port -WarningAction SilentlyContinue
    if (-not $result.TcpTestSucceeded) {
      throw 'TCP port is not reachable. Check firewall, NAT, port forwarding, and the public Node process.'
    }
    if (-not $AsJson) { Write-Host 'OK: bootstrap TCP port is reachable.' -ForegroundColor Green }
  } elseif (-not $AsJson) {
    Write-Host 'INFO: Windows Test-NetConnection cannot prove a QUIC/UDP handshake. Structural validation passed; verify QUIC through Konofix/libp2p during the real test.' -ForegroundColor DarkYellow
  }
}

if (-not $AsJson) {
  Write-Host 'OK: bootstrap multiaddr structure and libp2p Peer ID passed strict validation.' -ForegroundColor Green
  if ($ValidateOnly) {
    Write-Host 'INFO: reachability was intentionally skipped.' -ForegroundColor DarkYellow
  } else {
    Write-Host 'Next: add the multiaddr in Network settings -> Bootstrap and run the test on two independent Internet connections.' -ForegroundColor Green
  }
}
