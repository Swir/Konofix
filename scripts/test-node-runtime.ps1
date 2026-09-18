param(
    [string]$NodePath = '',
    [string]$ProbePath = '',
    [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($StartupTimeoutSeconds -lt 5 -or $StartupTimeoutSeconds -gt 120) {
    throw 'StartupTimeoutSeconds must be between 5 and 120.'
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$buildInfoPath = Join-Path $projectRoot 'BUILD_INFO.json'
$artifactMode = Test-Path -LiteralPath $buildInfoPath -PathType Leaf
$buildInfo = $null

if ($artifactMode) {
    $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
    $buildInfoSchema = [int]$buildInfo.schema
    if ($buildInfoSchema -notin @(1, 2)) {
        throw "Unsupported BUILD_INFO schema '$($buildInfo.schema)'."
    }
    if ([string]::IsNullOrWhiteSpace([string]$buildInfo.version) -or
        [string]::IsNullOrWhiteSpace([string]$buildInfo.commit)) {
        throw 'BUILD_INFO.json is missing exact build version/commit metadata.'
    }
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $NodePath = Join-Path $projectRoot ([string]$buildInfo.node.path)
    }
    if ([string]::IsNullOrWhiteSpace($ProbePath)) {
        if ($null -eq $buildInfo.netprobe -or [string]::IsNullOrWhiteSpace([string]$buildInfo.netprobe.path)) {
            throw 'BUILD_INFO.json is missing Konofix Netprobe provenance metadata.'
        }
        $ProbePath = Join-Path $projectRoot ([string]$buildInfo.netprobe.path)
    }
} else {
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $NodePath = Join-Path $projectRoot 'src-tauri\target\release\konofix-node.exe'
    }
    if ([string]::IsNullOrWhiteSpace($ProbePath)) {
        $ProbePath = Join-Path $projectRoot 'src-tauri\target\release\konofix-netprobe.exe'
    }
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Konofix Node executable not found: $NodePath"
}
if (-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)) {
    throw "Konofix Netprobe executable not found: $ProbePath"
}
$node = (Resolve-Path -LiteralPath $NodePath).Path
$probe = (Resolve-Path -LiteralPath $ProbePath).Path
$healthValidator = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not (Test-Path -LiteralPath $healthValidator -PathType Leaf)) {
    throw "Node health validator not found: $healthValidator"
}

function Get-FreeTcpUdpPort {
    for ($attempt = 0; $attempt -lt 64; $attempt++) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $udp = $null
        try {
            $listener.Start()
            $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
            try {
                $endpoint = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $port)
                $udp = [System.Net.Sockets.UdpClient]::new($endpoint)
                return $port
            } catch [System.Net.Sockets.SocketException] {
                continue
            }
        } finally {
            if ($null -ne $udp) { $udp.Dispose() }
            $listener.Stop()
        }
    }

    throw 'Could not reserve a loopback port that is free for both TCP and UDP/QUIC.'
}

function Get-ExpectedSourceCommit {
    if ($artifactMode) {
        $commit = [string]$buildInfo.commit
        if ($commit -cnotmatch '^[0-9a-f]{40}$') {
            throw "BUILD_INFO.json contains invalid commit '$commit'."
        }
        return $commit
    }

    if ($env:GITHUB_SHA -cmatch '^[0-9a-f]{40}$') {
        return $env:GITHUB_SHA
    }

    Push-Location $projectRoot
    try {
        $commit = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $commit -and $commit.Trim() -cmatch '^[0-9a-f]{40}$') {
            return $commit.Trim()
        }
    } finally {
        Pop-Location
    }
    throw 'Could not determine the exact source commit expected from the built Node.'
}

function Start-SmokeNode {
    param(
        [Parameter(Mandatory = $true)][string]$HealthPath,
        [Parameter(Mandatory = $true)][string]$IdentityPath
    )

    $port = Get-FreeTcpUdpPort
    $arguments = @(
        '--port', [string]$port,
        '--public-host', '127.0.0.1',
        '--allow-private-address',
        '--status-interval', '10',
        '--health-file', $HealthPath,
        '--identity-file', $IdentityPath
    )
    $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden
    return [pscustomobject]@{
        Process = $process
        Port = $port
    }
}

function Stop-SmokeNode {
    param([AllowNull()][System.Diagnostics.Process]$Process)
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            $Process.WaitForExit(10000) | Out-Null
        }
    } catch {
        Write-Warning "Failed to stop smoke-test Node process $($Process.Id): $($_.Exception.Message)"
    }
}

function Wait-RunningSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$HealthPath,
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $lastError = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "Konofix Node exited before producing a running health snapshot (exit code $($Process.ExitCode))."
        }
        if (Test-Path -LiteralPath $HealthPath -PathType Leaf) {
            try {
                $snapshot = Get-Content -LiteralPath $HealthPath -Raw | ConvertFrom-Json
                if ($snapshot.status -ceq 'running' -and $snapshot.peer_id -and $snapshot.version -and $snapshot.source_commit) {
                    return $snapshot
                }
            } catch {
                $lastError = $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds 200
    }

    $suffix = if ($lastError) { " Last snapshot read error: $lastError" } else { '' }
    throw "Timed out waiting for a running Konofix Node health snapshot.$suffix"
}

function Invoke-TransportProbe {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('tcp', 'quic-v1')][string]$Transport,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$PeerId,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit
    )

    $target = if ($Transport -ceq 'tcp') {
        "/ip4/127.0.0.1/tcp/$Port/p2p/$PeerId"
    } else {
        "/ip4/127.0.0.1/udp/$Port/quic-v1/p2p/$PeerId"
    }

    $output = @(& $probe --timeout 20 $target 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) {
        throw "Konofix Netprobe $Transport failed with exit code $exitCode. Output: $text"
    }

    try {
        $evidence = $text | ConvertFrom-Json
    } catch {
        throw "Konofix Netprobe $Transport returned invalid JSON: $($_.Exception.Message). Output: $text"
    }

    if ([int]$evidence.schema -ne 1 -or [string]$evidence.status -cne 'pass') {
        throw "Konofix Netprobe $Transport returned an unsupported or non-PASS evidence record."
    }
    if ([string]$evidence.transport -cne $Transport) {
        throw "Konofix Netprobe transport mismatch: expected '$Transport', got '$($evidence.transport)'."
    }
    if ([string]$evidence.expected_peer_id -cne $PeerId -or [string]$evidence.observed_peer_id -cne $PeerId) {
        throw "Konofix Netprobe Peer ID mismatch for $Transport."
    }
    if ([string]$evidence.protocol_version -cne '/konofix/4.0') {
        throw "Konofix Netprobe observed unexpected protocol version '$($evidence.protocol_version)'."
    }
    if ([string]$evidence.agent_version -cne "Konofix-Node/$ExpectedVersion") {
        throw "Konofix Netprobe observed unexpected Node agent '$($evidence.agent_version)'."
    }
    if ([string]$evidence.version -cne $ExpectedVersion) {
        throw "Konofix Netprobe build version mismatch: expected '$ExpectedVersion', got '$($evidence.version)'."
    }
    if ([string]$evidence.source_commit -cne $ExpectedCommit) {
        throw "Konofix Netprobe source commit mismatch: expected '$ExpectedCommit', got '$($evidence.source_commit)'."
    }
    if ([int64]$evidence.rtt_micros -lt 0 -or [int64]$evidence.elapsed_millis -lt 0) {
        throw "Konofix Netprobe returned invalid timing evidence for $Transport."
    }

    Write-Host "PASS: authenticated libp2p $Transport probe reached Peer ID $PeerId (RTT $($evidence.rtt_micros) us)." -ForegroundColor Green
    return $evidence
}

if ($artifactMode) {
    $expectedVersion = [string]$buildInfo.version
    $expectedNodeHash = [string]$buildInfo.node.sha256
    if ($expectedNodeHash -cnotmatch '^[0-9a-f]{64}$') {
        throw 'BUILD_INFO.json contains an invalid Node SHA-256 digest.'
    }
    $actualNodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($expectedNodeHash, $actualNodeHash, [System.StringComparison]::Ordinal)) {
        throw "Node SHA-256 mismatch: BUILD_INFO expected '$expectedNodeHash', got '$actualNodeHash'."
    }

    $expectedProbeHash = [string]$buildInfo.netprobe.sha256
    if ($expectedProbeHash -cnotmatch '^[0-9a-f]{64}$') {
        throw 'BUILD_INFO.json contains an invalid Netprobe SHA-256 digest.'
    }
    $actualProbeHash = (Get-FileHash -LiteralPath $probe -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($expectedProbeHash, $actualProbeHash, [System.StringComparison]::Ordinal)) {
        throw "Netprobe SHA-256 mismatch: BUILD_INFO expected '$expectedProbeHash', got '$actualProbeHash'."
    }
} else {
    $packagePath = Join-Path $projectRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "package.json not found: $packagePath"
    }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $expectedVersion = [string]$package.version
}
$expectedCommit = Get-ExpectedSourceCommit
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("konofix-node-runtime-" + [Guid]::NewGuid().ToString('N'))
$identityPath = Join-Path $tempRoot 'node-identity.key'
$healthFirst = Join-Path $tempRoot 'health-first.json'
$healthSecond = Join-Path $tempRoot 'health-second.json'
$firstProcess = $null
$secondProcess = $null

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host 'Node runtime smoke: checking executable help...' -ForegroundColor Yellow
    & $node --help | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "konofix-node.exe --help failed with exit code $LASTEXITCODE."
    }
    & $probe --help | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "konofix-netprobe.exe --help failed with exit code $LASTEXITCODE."
    }

    Write-Host 'Node runtime smoke: first production-binary start...' -ForegroundColor Yellow
    $firstRun = Start-SmokeNode -HealthPath $healthFirst -IdentityPath $identityPath
    $firstProcess = $firstRun.Process
    $first = Wait-RunningSnapshot -HealthPath $healthFirst -Process $firstProcess

    & $healthValidator `
        -Path $healthFirst `
        -MaxAgeSeconds 30 `
        -ExpectedVersion $expectedVersion `
        -ExpectedPeerId ([string]$first.peer_id) `
        -ExpectedSourceCommit $expectedCommit | Out-Null

    if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
        throw 'Node did not persist its identity file.'
    }
    if ((Get-Item -LiteralPath $identityPath).Length -le 0) {
        throw 'Node persisted an empty identity file.'
    }

    $firstPeerId = [string]$first.peer_id
    Stop-SmokeNode -Process $firstProcess
    $firstProcess = $null

    Write-Host 'Node runtime smoke: restart with the same persistent identity...' -ForegroundColor Yellow
    $secondRun = Start-SmokeNode -HealthPath $healthSecond -IdentityPath $identityPath
    $secondProcess = $secondRun.Process
    $secondPort = [int]$secondRun.Port
    $second = Wait-RunningSnapshot -HealthPath $healthSecond -Process $secondProcess

    if (-not [string]::Equals($firstPeerId, [string]$second.peer_id, [System.StringComparison]::Ordinal)) {
        throw "Persistent identity regression: first Peer ID '$firstPeerId', second Peer ID '$($second.peer_id)'."
    }
    if (-not [string]::Equals($expectedVersion, [string]$second.version, [System.StringComparison]::Ordinal)) {
        throw "Version regression after restart: expected '$expectedVersion', got '$($second.version)'."
    }
    if (-not [string]::Equals($expectedCommit, [string]$second.source_commit, [System.StringComparison]::Ordinal)) {
        throw "Source-commit regression after restart: expected '$expectedCommit', got '$($second.source_commit)'."
    }

    & $healthValidator `
        -Path $healthSecond `
        -MaxAgeSeconds 30 `
        -ExpectedVersion $expectedVersion `
        -ExpectedPeerId $firstPeerId `
        -ExpectedSourceCommit $expectedCommit | Out-Null

    Write-Host 'Node runtime smoke: authenticated TCP libp2p probe...' -ForegroundColor Yellow
    Invoke-TransportProbe -Transport tcp -Port $secondPort -PeerId $firstPeerId -ExpectedVersion $expectedVersion -ExpectedCommit $expectedCommit | Out-Null

    Write-Host 'Node runtime smoke: authenticated QUIC-v1 libp2p probe...' -ForegroundColor Yellow
    Invoke-TransportProbe -Transport quic-v1 -Port $secondPort -PeerId $firstPeerId -ExpectedVersion $expectedVersion -ExpectedCommit $expectedCommit | Out-Null

    $mode = if ($artifactMode) { 'release-bundle' } else { 'repository-build' }
    Write-Host "PASS: $mode Node started twice, preserved Peer ID $firstPeerId, and completed exact-build authenticated TCP + QUIC-v1 libp2p probes." -ForegroundColor Green
} finally {
    Stop-SmokeNode -Process $firstProcess
    Stop-SmokeNode -Process $secondProcess
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
