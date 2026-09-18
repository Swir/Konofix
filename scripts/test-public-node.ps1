$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'public-node.ps1'
$tempState = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-public-node-test-" + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Fails([string]$Label, [string]$ExpectedText, [scriptblock]$Action) {
  $failed = $false
  try {
    & $Action
  } catch {
    $failed = $true
    if (-not $_.Exception.Message.Contains($ExpectedText)) {
      throw "$Label failed with an unexpected error: $($_.Exception.Message)"
    }
  }
  if (-not $failed) { throw "$Label was expected to fail." }
}

Write-Host '=== Konofix Public Node preflight self-tests ===' -ForegroundColor Cyan

$dns = (& $tool -PublicHost 'NODE.GitHub.COM' -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($dns.schema -eq 1) 'DNS config schema must be 1.'
Assert-True ($dns.public_host -ceq 'node.github.com') 'DNS host must be normalized to lower-case ASCII.'
Assert-True ($dns.address_prefix -ceq '/dns/node.github.com') 'DNS multiaddr prefix is wrong.'
Assert-True ($dns.bootstrap_tcp_template -ceq '/dns/node.github.com/tcp/45555/p2p/<PEER_ID>') 'TCP bootstrap template is wrong.'
Assert-True ($dns.bootstrap_quic_template -ceq '/dns/node.github.com/udp/45555/quic-v1/p2p/<PEER_ID>') 'QUIC bootstrap template is wrong.'
Assert-True ($dns.args -contains '--identity-file') 'Launch arguments must pin the identity file.'
Assert-True ($dns.args -contains '--health-file') 'Launch arguments must pin the health file.'
Assert-True (-not ($dns.args -contains '--allow-private-address')) 'Public launch arguments must not enable the lab-only address override.'

$ipv4 = (& $tool -PublicHost '8.8.8.8' -Port 46666 -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($ipv4.address_prefix -ceq '/ip4/8.8.8.8') 'IPv4 prefix is wrong.'
Assert-True ($ipv4.port -eq 46666) 'Custom port was not preserved.'

$mappedPublic = (& $tool -PublicHost '::ffff:8.8.8.8' -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($mappedPublic.public_host -ceq '8.8.8.8') 'IPv4-mapped IPv6 public literals must normalize to IPv4.'
Assert-True ($mappedPublic.address_prefix -ceq '/ip4/8.8.8.8') 'IPv4-mapped IPv6 public literals must use an ip4 multiaddr.'

$fqdn = (& $tool -PublicHost 'NODE.GitHub.COM.' -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($fqdn.public_host -ceq 'node.github.com') 'A trailing DNS root dot must be normalized away.'

$ipv6 = (& $tool -PublicHost '[2606:4700:4700::1111]' -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($ipv6.address_prefix -ceq '/ip6/2606:4700:4700::1111') 'IPv6 prefix is wrong.'

foreach ($case in @(
  @('private IPv4 rejection', '192.168.10.20'),
  @('IPv4-mapped private IPv6 rejection', '::ffff:192.168.10.20'),
  @('CGNAT rejection', '100.64.1.2'),
  @('protocol-assignment IPv4 rejection', '192.0.0.1'),
  @('documentation IPv4 rejection', '203.0.113.10'),
  @('deprecated relay-anycast IPv4 rejection', '192.88.99.1'),
  @('benchmark IPv4 rejection', '198.18.0.1'),
  @('reserved IPv4 rejection', '240.0.0.1'),
  @('documentation IPv6 rejection', '2001:db8::1'),
  @('benchmark IPv6 rejection', '2001:2::1'),
  @('ORCHIDv1 IPv6 rejection', '2001:10::1'),
  @('ORCHIDv2 IPv6 rejection', '2001:20::1'),
  @('RFC 9637 documentation IPv6 rejection', '3fff::1'),
  @('ULA IPv6 rejection', 'fd00::1')
)) {
  $label = [string]$case[0]
  $hostValue = [string]$case[1]
  Assert-Fails $label 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
    & $tool -PublicHost $hostValue -StateDirectory $tempState -AsJson | Out-Null
  }
}

$lab = (& $tool -PublicHost '192.168.10.20' -StateDirectory $tempState -AllowPrivateAddress -AsJson) | ConvertFrom-Json
Assert-True ($lab.address_prefix -ceq '/ip4/192.168.10.20') 'AllowPrivateAddress must permit controlled lab addresses.'
Assert-True ($lab.args -contains '--allow-private-address') 'Lab launch arguments must explicitly forward the raw Node lab-only override.'

$samePath = Join-Path $tempState 'state.dat'
Assert-Fails 'identity/health collision rejection' 'Identity and health files must be different paths' {
  & $tool -PublicHost '8.8.8.8' -IdentityFile $samePath -HealthFile $samePath -AsJson | Out-Null
}

foreach ($reservedName in @(
  'node.example',
  'node.example.com',
  'node.example.net',
  'node.example.org',
  'bootstrap.internal',
  'relay.onion',
  'resolver.alt',
  'router.home.arpa',
  'printer.local',
  'localhost'
)) {
  Assert-Fails "reserved DNS rejection: $reservedName" 'local, single-label, or reserved for testing/documentation/private/special use' {
    & $tool -PublicHost $reservedName -StateDirectory $tempState -AsJson | Out-Null
  }
}

Assert-Fails 'single-label DNS rejection' 'local, single-label, or reserved for testing/documentation/private/special use' {
  & $tool -PublicHost 'intranet' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'invalid host rejection' 'Invalid public host' {
  & $tool -PublicHost 'node.example.com/path' -StateDirectory $tempState -AsJson | Out-Null
}

Write-Host 'OK - public Node deployment preflight rejects non-global literal/special-use DNS endpoints, unsafe state configurations and produces deterministic launch arguments.' -ForegroundColor Green
