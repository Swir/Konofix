$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'internet-test.ps1'

function Expect-Pass([string]$Name, [string]$Address) {
  try {
    & $target -Bootstrap $Address -ValidateOnly | Out-Null
    Write-Host "PASS: $Name" -ForegroundColor Green
  } catch {
    throw "Expected PASS for '$Name', but validation failed: $($_.Exception.Message)"
  }
}

function Expect-Fail([string]$Name, [string]$Address) {
  $failed = $false
  try {
    & $target -Bootstrap $Address -ValidateOnly | Out-Null
  } catch {
    $failed = $true
  }
  if (-not $failed) {
    throw "Expected FAIL for '$Name', but validation accepted: $Address"
  }
  Write-Host "PASS (rejected): $Name" -ForegroundColor Green
}

$peer = '12D3KooWQ7N8jFx6tT8hVYpY3iM3x1bqL6ZpH8sR4wC2dA9eF5gK'

Expect-Pass 'IPv4 TCP' "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
Expect-Pass 'IPv6 TCP' "/ip6/2001:db8::10/tcp/45555/p2p/$peer"
Expect-Pass 'DNS TCP' "/dns/node.example.org/tcp/45555/p2p/$peer"
Expect-Pass 'DNS4 QUIC' "/dns4/node.example.org/udp/45555/quic-v1/p2p/$peer"
Expect-Pass 'DNS6 QUIC' "/dns6/node.example.org/udp/45555/quic-v1/p2p/$peer"

Expect-Fail 'missing leading slash' "ip4/203.0.113.10/tcp/45555/p2p/$peer"
Expect-Fail 'unsupported transport' "/ip4/203.0.113.10/ws/45555/p2p/$peer"
Expect-Fail 'UDP without QUIC v1' "/ip4/203.0.113.10/udp/45555/p2p/$peer"
Expect-Fail 'QUIC marker on TCP' "/ip4/203.0.113.10/tcp/45555/quic-v1/p2p/$peer"
Expect-Fail 'port zero' "/ip4/203.0.113.10/tcp/0/p2p/$peer"
Expect-Fail 'port above range' "/ip4/203.0.113.10/tcp/65536/p2p/$peer"
Expect-Fail 'non-numeric port' "/ip4/203.0.113.10/tcp/notaport/p2p/$peer"
Expect-Fail 'invalid IPv4' "/ip4/999.1.2.3/tcp/45555/p2p/$peer"
Expect-Fail 'IPv6 passed as ip4' "/ip4/2001:db8::10/tcp/45555/p2p/$peer"
Expect-Fail 'invalid DNS label' "/dns/-node.example.org/tcp/45555/p2p/$peer"
Expect-Fail 'missing p2p marker' "/dns/node.example.org/tcp/45555/peer/$peer"
Expect-Fail 'invalid Peer ID alphabet' '/dns/node.example.org/tcp/45555/p2p/O0Il-not-base58'
Expect-Fail 'extra TCP segment' "/dns/node.example.org/tcp/45555/p2p/$peer/extra"
Expect-Fail 'extra QUIC segment' "/dns/node.example.org/udp/45555/quic-v1/p2p/$peer/extra"

Write-Host 'Internet bootstrap precheck self-tests passed.' -ForegroundColor Cyan
