param(
  [Parameter(Mandatory=$true)]
  [string]$Bootstrap,
  [switch]$ValidateOnly,
  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

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
    throw 'Peer ID is missing or is not a valid base58-style libp2p Peer ID.'
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

if ($AsJson) {
  $parsed | ConvertTo-Json -Compress
} else {
  Write-Host '=== Konofix Chat 0.4.2 - INTERNET PRECHECK ===' -ForegroundColor Cyan
  Write-Host "Bootstrap: $($parsed.address)"
  Write-Host "Host: $($parsed.host)  Port: $($parsed.port)  Transport: $($parsed.transport)" -ForegroundColor Yellow
  Write-Host "Peer ID: $($parsed.peer_id)" -ForegroundColor DarkGray
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
  Write-Host 'OK: bootstrap multiaddr structure and Peer ID passed strict validation.' -ForegroundColor Green
  if ($ValidateOnly) {
    Write-Host 'INFO: reachability was intentionally skipped.' -ForegroundColor DarkYellow
  } else {
    Write-Host 'Next: add the multiaddr in Network settings -> Bootstrap and run the test on two independent Internet connections.' -ForegroundColor Green
  }
}
