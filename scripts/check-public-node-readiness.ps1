[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TcpBootstrap,

    [Parameter(Mandatory = $true)]
    [string]$QuicBootstrap,

    [Parameter(Mandatory = $true)]
    [string]$HealthPath,

    [string]$ExpectedVersion = '',
    [string]$ExpectedSourceCommit = '',

    [ValidateRange(0, 2147483647)]
    [int64]$MinUptimeSeconds = 300,

    [ValidateRange(0, 1000000)]
    [int]$MinConnectedPeers = 0,

    [ValidateRange(250, 60000)]
    [int]$ConnectTimeoutMs = 5000,

    [switch]$SkipTcpReachability,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$internetTest = Join-Path $PSScriptRoot 'internet-test.ps1'
$healthCheck = Join-Path $PSScriptRoot 'check-node-health.ps1'
foreach ($requiredScript in @($internetTest, $healthCheck)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Required Konofix validation script is missing: $requiredScript"
    }
}

function Parse-Bootstrap([string]$Address) {
    $jsonText = (& $internetTest -Bootstrap $Address -ValidateOnly -AsJson -RequirePublicHost -RequireDnsResolution | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        throw "Bootstrap validation returned no structured result for: $Address"
    }
    try {
        return $jsonText | ConvertFrom-Json
    } catch {
        throw "Bootstrap validation returned invalid JSON for '$Address': $($_.Exception.Message)"
    }
}

function Test-TcpReachability([string]$HostName, [int]$PortValue, [int]$TimeoutMs) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        try {
            $task = $client.ConnectAsync($HostName, $PortValue)
            if (-not $task.Wait($TimeoutMs)) {
                throw "connection timed out after ${TimeoutMs}ms"
            }
            if (-not $client.Connected) {
                throw 'socket did not reach the connected state'
            }
        } catch {
            throw "Public Node TCP endpoint $HostName`:$PortValue is not reachable: $($_.Exception.GetBaseException().Message)"
        }
    } finally {
        $client.Dispose()
    }
}

$tcp = Parse-Bootstrap $TcpBootstrap
$quic = Parse-Bootstrap $QuicBootstrap

if (-not $tcp.public_host_validated -or -not $quic.public_host_validated) {
    throw 'Public Node readiness requires globally routable bootstrap endpoints.'
}

if ([string]$tcp.transport -cne 'tcp') {
    throw "TcpBootstrap must use TCP; parsed transport is '$($tcp.transport)'."
}
if ([string]$quic.transport -cne 'quic-v1') {
    throw "QuicBootstrap must use UDP/QUIC v1; parsed transport is '$($quic.transport)'."
}

if ([string]$tcp.host_protocol -cne [string]$quic.host_protocol -or [string]$tcp.host -cne [string]$quic.host) {
    throw "TCP and QUIC bootstrap addresses must describe the same public host. TCP=$($tcp.host_protocol)/$($tcp.host) QUIC=$($quic.host_protocol)/$($quic.host)"
}
if ([int]$tcp.port -ne [int]$quic.port) {
    throw "TCP and QUIC bootstrap addresses must use the same port. TCP=$($tcp.port) QUIC=$($quic.port)"
}
if ([string]$tcp.peer_id -cne [string]$quic.peer_id) {
    throw "TCP and QUIC bootstrap addresses must use the same Konofix Node Peer ID. TCP=$($tcp.peer_id) QUIC=$($quic.peer_id)"
}

$healthArgs = @{
    Path = $HealthPath
    ExpectedPeerId = [string]$tcp.peer_id
    MinUptimeSeconds = $MinUptimeSeconds
    MinConnectedPeers = $MinConnectedPeers
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $healthArgs.ExpectedVersion = $ExpectedVersion
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
    $healthArgs.ExpectedSourceCommit = $ExpectedSourceCommit
}

& $healthCheck @healthArgs *> $null

try {
    $health = Get-Content -LiteralPath $HealthPath -Raw | ConvertFrom-Json
} catch {
    throw "Health snapshot became unreadable after validation: $($_.Exception.Message)"
}

$tcpReachable = $false
if (-not $SkipTcpReachability) {
    Test-TcpReachability -HostName ([string]$tcp.host) -PortValue ([int]$tcp.port) -TimeoutMs $ConnectTimeoutMs
    $tcpReachable = $true
}

$resolvedAddresses = @($tcp.resolved_addresses)
if ($resolvedAddresses.Count -eq 0 -and $tcp.host_protocol -in @('ip4', 'ip6')) {
    $resolvedAddresses = @([string]$tcp.host)
}

$result = [ordered]@{
    schema = 2
    ready = $true
    peer_id = [string]$tcp.peer_id
    public_host_protocol = [string]$tcp.host_protocol
    public_host = [string]$tcp.host
    public_host_validated = $true
    dns_resolution_checked = [bool]$tcp.dns_resolution_checked
    resolved_addresses = @($resolvedAddresses)
    port = [int]$tcp.port
    tcp_bootstrap = [string]$tcp.address
    quic_bootstrap = [string]$quic.address
    tcp_reachability_checked = (-not $SkipTcpReachability)
    tcp_reachable = $tcpReachable
    quic_multiaddr_validated = $true
    quic_handshake_proven = $false
    node_version = [string]$health.version
    source_commit = [string]$health.source_commit
    uptime_seconds = [int64]$health.uptime_seconds
    connected_peers = [int64]$health.connected_peers
    health_timestamp_unix = [int64]$health.timestamp_unix
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4 -Compress
    return
}

Write-Host '=== Konofix Public Node Readiness ===' -ForegroundColor Cyan
Write-Host "Peer ID:          $($result.peer_id)"
Write-Host "Public endpoint:  $($result.public_host):$($result.port)"
Write-Host "Node version:     $($result.node_version)"
Write-Host "Source commit:    $($result.source_commit)"
Write-Host "Uptime:           $($result.uptime_seconds)s"
Write-Host "Connected peers:  $($result.connected_peers)"
Write-Host "TCP multiaddr:    $($result.tcp_bootstrap)"
Write-Host "QUIC multiaddr:   $($result.quic_bootstrap)"
if ($result.resolved_addresses.Count -gt 0) {
    Write-Host "Public address(es): $($result.resolved_addresses -join ', ')"
}
if ($SkipTcpReachability) {
    Write-Host 'TCP reachability: skipped by request' -ForegroundColor DarkYellow
} else {
    Write-Host 'TCP reachability: reachable from this tester' -ForegroundColor Green
}
Write-Host 'Public-host gate: globally routable endpoint policy passed.' -ForegroundColor Green
Write-Host 'QUIC structure:   valid and identity-aligned' -ForegroundColor Green
Write-Host 'QUIC handshake:   not claimed by this PowerShell probe; prove it with the Konofix/libp2p real-network scenario.' -ForegroundColor DarkYellow
Write-Host 'READY: public-host policy, identity, health, TCP/QUIC endpoint pairing and requested local readiness checks passed.' -ForegroundColor Green
