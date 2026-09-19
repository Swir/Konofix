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

function Parse-Bootstrap([string]$Address, [bool]$ResolveDns) {
    $arguments = @{
        Bootstrap = $Address
        ValidateOnly = $true
        AsJson = $true
        RequirePublicHost = $true
    }
    if ($ResolveDns) {
        $arguments.RequireDnsResolution = $true
    }

    $jsonText = (& $internetTest @arguments | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        throw "Bootstrap validation returned no structured result for: $Address"
    }
    try {
        return $jsonText | ConvertFrom-Json
    } catch {
        throw "Bootstrap validation returned invalid JSON for '$Address': $($_.Exception.Message)"
    }
}

function Get-ValidatedTcpProbeTargets([object]$ParsedTcp) {
    $targets = @($ParsedTcp.resolved_addresses | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ($targets.Count -eq 0) {
        throw 'TCP readiness has no validated public IP addresses to probe.'
    }

    foreach ($target in $targets) {
        $parsedAddress = $null
        if (-not [System.Net.IPAddress]::TryParse($target, [ref]$parsedAddress)) {
            throw "TCP readiness received a non-IP validated target: $target"
        }
    }
    return @($targets)
}

function Test-TcpReachability([string[]]$ValidatedAddresses, [int]$PortValue, [int]$TimeoutMs) {
    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($targetText in $ValidatedAddresses) {
        $targetAddress = [System.Net.IPAddress]::Parse($targetText)
        $client = [System.Net.Sockets.TcpClient]::new($targetAddress.AddressFamily)
        try {
            try {
                $task = $client.ConnectAsync($targetAddress, $PortValue)
                if (-not $task.Wait($TimeoutMs)) {
                    throw "connection timed out after ${TimeoutMs}ms"
                }
                if (-not $client.Connected) {
                    throw 'socket did not reach the connected state'
                }
                return $targetText
            } catch {
                $failures.Add("$targetText=$($_.Exception.GetBaseException().Message)")
            }
        } finally {
            $client.Dispose()
        }
    }

    throw "Public Node TCP endpoint validated address set on port $PortValue is not reachable: $($failures -join '; ')"
}

# Resolve the paired public host once. QUIC parsing still enforces the same public-host
# grammar/policy, but it deliberately reuses the TCP snapshot instead of performing a
# second DNS lookup that could observe a different answer set.
$tcp = Parse-Bootstrap -Address $TcpBootstrap -ResolveDns $true
$quic = Parse-Bootstrap -Address $QuicBootstrap -ResolveDns $false

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

$tcpProbeTargets = @(Get-ValidatedTcpProbeTargets -ParsedTcp $tcp)
if ($tcp.host_protocol -in @('dns', 'dns4', 'dns6') -and -not [bool]$tcp.dns_resolution_checked) {
    throw 'DNS public Node readiness requires one validated DNS-resolution snapshot.'
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

$healthJsonText = (& $healthCheck @healthArgs -AsJson | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($healthJsonText)) {
    throw 'Health validation returned no structured result.'
}
try {
    $health = $healthJsonText | ConvertFrom-Json
} catch {
    throw "Health validation returned invalid JSON: $($_.Exception.Message)"
}

$tcpReachable = $false
$tcpReachableAddress = $null
if (-not $SkipTcpReachability) {
    $tcpReachableAddress = Test-TcpReachability -ValidatedAddresses $tcpProbeTargets -PortValue ([int]$tcp.port) -TimeoutMs $ConnectTimeoutMs
    $tcpReachable = $true
}

$result = [ordered]@{
    schema = 2
    ready = $true
    peer_id = [string]$tcp.peer_id
    public_host_protocol = [string]$tcp.host_protocol
    public_host = [string]$tcp.host
    public_host_validated = $true
    dns_resolution_checked = [bool]$tcp.dns_resolution_checked
    resolved_addresses = @($tcpProbeTargets)
    port = [int]$tcp.port
    tcp_bootstrap = [string]$tcp.address
    quic_bootstrap = [string]$quic.address
    tcp_reachability_checked = (-not $SkipTcpReachability)
    tcp_reachable = $tcpReachable
    tcp_probe_targets = @($tcpProbeTargets)
    tcp_reachable_address = $tcpReachableAddress
    quic_multiaddr_validated = $true
    quic_handshake_proven = $false
    node_version = [string]$health.version
    source_commit = [string]$health.source_commit
    uptime_seconds = [int64]$health.uptime_seconds
    connected_peers = [int64]$health.connected_peers
    health_timestamp_unix = [int64]$health.timestamp_unix
    health_snapshot_age_seconds = [int64]$health.snapshot_age_seconds
    health_snapshot_bytes = [int64]$health.snapshot_bytes
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
    Write-Host "Validated public address(es): $($result.resolved_addresses -join ', ')"
}
if ($SkipTcpReachability) {
    Write-Host 'TCP reachability: skipped by request' -ForegroundColor DarkYellow
} else {
    Write-Host "TCP reachability: reachable at validated address $($result.tcp_reachable_address)" -ForegroundColor Green
}
Write-Host 'Public-host gate: globally routable endpoint policy passed.' -ForegroundColor Green
Write-Host 'DNS binding:      TCP probe targets are the exact validated address snapshot; hostname re-resolution is not used.' -ForegroundColor Green
Write-Host 'Health binding:   readiness fields come from the exact bounded snapshot instance validated by check-node-health.ps1.' -ForegroundColor Green
Write-Host 'QUIC structure:   valid and identity-aligned' -ForegroundColor Green
Write-Host 'QUIC handshake:   not claimed by this PowerShell probe; prove it with the Konofix/libp2p real-network scenario.' -ForegroundColor DarkYellow
Write-Host 'READY: public-host policy, identity, health, TCP/QUIC endpoint pairing and requested local readiness checks passed.' -ForegroundColor Green
