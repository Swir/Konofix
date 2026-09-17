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

# Canonical libp2p forms used by Konofix: inline identity multihash (12D3KooW...)
# and sha2-256 multihash (Qm...). These fixtures are structurally valid multihashes.
$peer = '12D3KooW9tHTtS3inCZiYykw4u5G4frbjVFqhkmJX12gSNCVeH3e'
$shaPeer = 'QmNQa1FSTXNHmrjjfgUW3Px3Vkke4oKiFWdigWkYSux2Pi'

# Structural parsing remains useful for documentation/lab fixtures.
Expect-Pass 'IPv4 TCP structure' "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
Expect-Pass 'IPv6 TCP structure' "/ip6/2001:db8::10/tcp/45555/p2p/$peer"
Expect-Pass 'DNS TCP structure' "/dns/node.example.org/tcp/45555/p2p/$peer"
Expect-Pass 'DNS4 QUIC structure' "/dns4/node.example.org/udp/45555/quic-v1/p2p/$peer"
Expect-Pass 'DNS6 QUIC structure' "/dns6/node.example.org/udp/45555/quic-v1/p2p/$peer"
Expect-Pass 'sha2-256 Peer ID structure' "/ip4/203.0.113.10/tcp/45555/p2p/$shaPeer"

# Production/public evidence must use globally routable endpoints and normal public DNS namespaces.
Expect-PassStrict 'global IPv4 TCP' "/ip4/8.8.8.8/tcp/45555/p2p/$peer"
Expect-PassStrict 'global IPv6 TCP' "/ip6/2606:4700:4700::1111/tcp/45555/p2p/$peer"
Expect-PassStrict 'public FQDN structure' "/dns/node.konofix.net/tcp/45555/p2p/$peer"
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
Expect-FailStrict 'reserved example.com documentation domain' "/dns/node.example.com/tcp/45555/p2p/$peer"
Expect-FailStrict 'reserved example.net documentation domain' "/dns/node.example.net/tcp/45555/p2p/$peer"
Expect-FailStrict 'reserved example.org documentation domain' "/dns/node.example.org/tcp/45555/p2p/$peer"
Expect-FailStrict 'special-use .alt DNS' "/dns/node.alt/tcp/45555/p2p/$peer"
Expect-FailStrict 'private-use .internal DNS' "/dns/node.internal/tcp/45555/p2p/$peer"
Expect-FailStrict 'special-use home.arpa DNS' "/dns/node.home.arpa/tcp/45555/p2p/$peer"
Expect-FailStrict 'special-use resolver.arpa DNS' "/dns/node.resolver.arpa/tcp/45555/p2p/$peer"
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
Expect-Fail 'base58-looking but empty multihash' '/dns/node.example.org/tcp/45555/p2p/11111111111111111111'
Expect-Fail 'unsupported multihash code' '/dns/node.example.org/tcp/45555/p2p/S5RBetKNu6cNYakr8cdRVHUYqGj4oY2zKiSksm6MmQ9sQL'
Expect-Fail 'wrong sha2-256 digest length' '/dns/node.example.org/tcp/45555/p2p/6PDjCUMmLhERUfKxFnbWedea1WLk9GK1inM69ep3Gfcb2'
Expect-Fail 'oversized identity multihash' '/dns/node.example.org/tcp/45555/p2p/1Eyy4V7W7v82Q6mMR35aptENGzRkm2pVwhH7uyH12tde4Kkp53AvFF2JiYpcp'
Expect-Fail 'extra TCP segment' "/dns/node.example.org/tcp/45555/p2p/$peer/extra"
Expect-Fail 'extra QUIC segment' "/dns/node.example.org/udp/45555/quic-v1/p2p/$peer/extra"

Write-Host 'Internet bootstrap precheck self-tests passed.' -ForegroundColor Cyan
