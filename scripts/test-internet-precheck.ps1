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

function Expect-PassStrict([string]$Name, [string]$Address) {
  try {
    & $target -Bootstrap $Address -ValidateOnly -RequirePublicHost | Out-Null
    Write-Host "PASS (public): $Name" -ForegroundColor Green
  } catch {
    throw "Expected strict PASS for '$Name', but validation failed: $($_.Exception.Message)"
  }
}

function Expect-FailStrict([string]$Name, [string]$Address) {
  $failed = $false
  try {
    & $target -Bootstrap $Address -ValidateOnly -RequirePublicHost | Out-Null
  } catch {
    $failed = $true
  }
  if (-not $failed) {
    throw "Expected strict FAIL for '$Name', but validation accepted: $Address"
  }
  Write-Host "PASS (public rejected): $Name" -ForegroundColor Green
}

$peer = '12D3KooWQ7N8jFx6tT8hVYpY3iM3x1bqL6ZpH8sR4wC2dA9eF5gK'

# Structural parsing remains useful for documentation/lab fixtures.
Expect-Pass 'IPv4 TCP structure' "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
Expect-Pass 'IPv6 TCP structure' "/ip6/2001:db8::10/tcp/45555/p2p/$peer"
Expect-Pass 'DNS TCP structure' "/dns/node.example.org/tcp/45555/p2p/$peer"
Expect-Pass 'DNS4 QUIC structure' "/dns4/node.example.org/udp/45555/quic-v1/p2p/$peer"
Expect-Pass 'DNS6 QUIC structure' "/dns6/node.example.org/udp/45555/quic-v1/p2p/$peer"

# Production/public evidence must use globally routable endpoints.
Expect-PassStrict 'global IPv4 TCP' "/ip4/8.8.8.8/tcp/45555/p2p/$peer"
Expect-PassStrict 'global IPv6 TCP' "/ip6/2606:4700:4700::1111/tcp/45555/p2p/$peer"
Expect-PassStrict 'public FQDN structure' "/dns/node.example.org/tcp/45555/p2p/$peer"
Expect-FailStrict 'RFC1918 IPv4' "/ip4/10.1.2.3/tcp/45555/p2p/$peer"
Expect-FailStrict 'CGNAT IPv4' "/ip4/100.64.1.2/tcp/45555/p2p/$peer"
Expect-FailStrict 'loopback IPv4' "/ip4/127.0.0.1/tcp/45555/p2p/$peer"
Expect-FailStrict 'link-local IPv4' "/ip4/169.254.10.20/tcp/45555/p2p/$peer"
Expect-FailStrict 'documentation IPv4 192.0.2/24' "/ip4/192.0.2.10/tcp/45555/p2p/$peer"
Expect-FailStrict 'deprecated 6to4 relay anycast IPv4' "/ip4/192.88.99.1/tcp/45555/p2p/$peer"
Expect-FailStrict 'benchmark IPv4' "/ip4/198.18.0.1/tcp/45555/p2p/$peer"
Expect-FailStrict 'documentation IPv4 198.51.100/24' "/ip4/198.51.100.20/tcp/45555/p2p/$peer"
Expect-FailStrict 'documentation IPv4 203.0.113/24' "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
Expect-FailStrict 'documentation IPv6 2001:db8::/32' "/ip6/2001:db8::10/tcp/45555/p2p/$peer"
Expect-FailStrict 'benchmark IPv6 2001:2::/48' "/ip6/2001:2::1/tcp/45555/p2p/$peer"
Expect-FailStrict 'ORCHID IPv6 2001:10::/28' "/ip6/2001:10::1/tcp/45555/p2p/$peer"
Expect-FailStrict 'ORCHIDv2 IPv6 2001:20::/28' "/ip6/2001:20::1/tcp/45555/p2p/$peer"
Expect-FailStrict 'ULA IPv6' "/ip6/fd00::10/tcp/45555/p2p/$peer"
Expect-FailStrict 'link-local IPv6' "/ip6/fe80::10/tcp/45555/p2p/$peer"
Expect-FailStrict 'single-label DNS' "/dns/localhost/tcp/45555/p2p/$peer"
Expect-FailStrict 'reserved .local DNS' "/dns/node.local/tcp/45555/p2p/$peer"
Expect-FailStrict 'reserved .test DNS' "/dns/node.test/tcp/45555/p2p/$peer"
Expect-FailStrict 'reserved .example DNS' "/dns/node.example/tcp/45555/p2p/$peer"
Expect-FailStrict 'private-use .internal DNS' "/dns/node.internal/tcp/45555/p2p/$peer"
Expect-FailStrict 'special-use home.arpa DNS' "/dns/node.home.arpa/tcp/45555/p2p/$peer"
Expect-FailStrict 'special-use .onion DNS' "/dns/node.onion/tcp/45555/p2p/$peer"

try {
  & $target -Bootstrap "/ip4/8.8.8.8/tcp/45555/p2p/$peer" -ValidateOnly -RequireDnsResolution | Out-Null
  Write-Host 'PASS: RequireDnsResolution implies strict public validation for literal IPs without performing DNS.' -ForegroundColor Green
} catch {
  throw "Expected global literal IP to pass RequireDnsResolution mode: $($_.Exception.Message)"
}

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
