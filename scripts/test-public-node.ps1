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

$ipv4 = (& $tool -PublicHost '8.8.8.8' -Port 46666 -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($ipv4.address_prefix -ceq '/ip4/8.8.8.8') 'IPv4 prefix is wrong.'
Assert-True ($ipv4.port -eq 46666) 'Custom port was not preserved.'

$ipv6 = (& $tool -PublicHost '[2606:4700:4700::1111]' -StateDirectory $tempState -AsJson) | ConvertFrom-Json
Assert-True ($ipv6.address_prefix -ceq '/ip6/2606:4700:4700::1111') 'IPv6 prefix is wrong.'

Assert-Fails 'private IPv4 rejection' 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
  & $tool -PublicHost '192.168.10.20' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'CGNAT rejection' 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
  & $tool -PublicHost '100.64.1.2' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'documentation IPv4 rejection' 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
  & $tool -PublicHost '203.0.113.10' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'documentation IPv6 rejection' 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
  & $tool -PublicHost '2001:db8::1' -StateDirectory $tempState -AsJson | Out-Null
}

$lab = (& $tool -PublicHost '192.168.10.20' -StateDirectory $tempState -AllowPrivateAddress -AsJson) | ConvertFrom-Json
Assert-True ($lab.address_prefix -ceq '/ip4/192.168.10.20') 'AllowPrivateAddress must permit controlled lab addresses.'

$samePath = Join-Path $tempState 'state.dat'
Assert-Fails 'identity/health collision rejection' 'Identity and health files must be different paths' {
  & $tool -PublicHost '8.8.8.8' -IdentityFile $samePath -HealthFile $samePath -AsJson | Out-Null
}
Assert-Fails 'reserved DNS rejection' 'local, single-label, or reserved for testing/documentation' {
  & $tool -PublicHost 'node.example' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'single-label DNS rejection' 'local, single-label, or reserved for testing/documentation' {
  & $tool -PublicHost 'intranet' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'invalid host rejection' 'Invalid public host' {
  & $tool -PublicHost 'node.example.com/path' -StateDirectory $tempState -AsJson | Out-Null
}

Write-Host 'OK - public Node deployment preflight rejects unsafe address/state configurations and produces deterministic launch arguments.' -ForegroundColor Green
