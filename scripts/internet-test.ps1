param(
  [Parameter(Mandatory=$true)]
  [string]$Bootstrap
)

$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - INTERNET PRECHECK ===' -ForegroundColor Cyan
Write-Host "Bootstrap: $Bootstrap"

$parts = $Bootstrap.Trim('/') -split '/'
$hostName = $null
$port = $null
$transport = $null
$peerId = $null
for ($i = 0; $i -lt $parts.Length - 1; $i++) {
  if ($parts[$i] -in @('ip4','ip6','dns','dns4','dns6')) { $hostName = $parts[$i+1] }
  if ($parts[$i] -eq 'tcp') { $transport = 'tcp'; $port = [int]$parts[$i+1] }
  if ($parts[$i] -eq 'udp') { $transport = 'udp'; $port = [int]$parts[$i+1] }
  if ($parts[$i] -eq 'p2p') { $peerId = $parts[$i+1] }
}

if (-not $hostName -or -not $port -or -not $peerId) {
  throw 'Nie rozpoznano pełnego multiaddr. Przykład: /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...'
}

Write-Host "Host: $hostName  Port: $port  Transport: $transport" -ForegroundColor Yellow
Write-Host "Peer ID: $peerId" -ForegroundColor DarkGray

if ($transport -eq 'tcp') {
  $r = Test-NetConnection -ComputerName $hostName -Port $port -WarningAction SilentlyContinue
  if ($r.TcpTestSucceeded) {
    Write-Host 'OK: port TCP bootstrapu jest osiągalny.' -ForegroundColor Green
  } else {
    Write-Host 'FAIL: port TCP nie odpowiada. Sprawdź firewall/NAT/port forwarding.' -ForegroundColor Red
    exit 2
  }
} else {
  Write-Host 'INFO: Windows Test-NetConnection nie potwierdza handshake QUIC/UDP. Zweryfikuj QUIC z panelu Konofix Chat.' -ForegroundColor DarkYellow
}

Write-Host 'OK: multiaddr zawiera Peer ID.' -ForegroundColor Green
Write-Host 'Następnie dodaj multiaddr w: Ustawienia sieci -> Bootstrap i wykonaj test na dwóch niezależnych łączach.' -ForegroundColor Green
