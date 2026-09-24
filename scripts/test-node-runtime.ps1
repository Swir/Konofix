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

    # GITHUB_SHA is the synthetic merge commit on pull_request events. It is
    # not evidence of the source actually checked out for this build.
    $expectedPin = $env:KONOFIX_SOURCE_SHA
    if ($null -ne $expectedPin -and $expectedPin -cnotmatch '^[0-9a-f]{40}$') {
        throw 'KONOFIX_SOURCE_SHA must be a full lowercase source commit.'
    }

    Push-Location $projectRoot
    try {
        # Under StrictMode, $LASTEXITCODE may not exist yet in a fresh pwsh
        # process. Seed it before the first native command so source resolution
        # remains deterministic on clean Windows CI runners.
        $LASTEXITCODE = 1
        $commit = (& git rev-parse --verify HEAD 2>$null | Select-Object -First 1)
        $gitExitCode = $LASTEXITCODE
        if ($gitExitCode -eq 0 -and $commit -and $commit.Trim() -cmatch '^[0-9a-f]{40}$') {
            $commit = $commit.Trim()
            if ($null -ne $expectedPin -and
                -not [string]::Equals($expectedPin, $commit, [System.StringComparison]::Ordinal)) {
                throw 'KONOFIX_SOURCE_SHA does not match the checked-out source commit.'
            }
            return $commit
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
        [Parameter(Mandatory = $true)][string]$Transport,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedPeerId,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceCommit
    )

    $target = if ($Transport -ceq 'tcp') {
        "/ip4/127.0.0.1/tcp/$Port/p2p/$ExpectedPeerId"
    } else {
        "/ip4/127.0.0.1/udp/$Port/quic-v1/p2p/$ExpectedPeerId"
    }
    $output = & $probe '--transport' $Transport '--target' $target '--timeout-ms' '5000' '--json'
    if ($LASTEXITCODE -ne 0) {
        throw "Konofix Netprobe $Transport smoke failed with exit code $LASTEXITCODE."
    }
    $result = ($output -join "`n") | ConvertFrom-Json
    if (-not $result.success -or
        $result.transport -cne $Transport -or
        $result.target -cne $target -or
        $result.authenticated_peer_id -cne $ExpectedPeerId -or
        $result.version -cne $ExpectedVersion -or
        $result.source_commit -cne $ExpectedSourceCommit) {
        throw "Konofix Netprobe $Transport returned unexpected identity/provenance metadata."
    }
    return $result
}

$expectedSourceCommit = Get-ExpectedSourceCommit
$expectedVersion = if ($artifactMode) { [string]$buildInfo.version } else {
    ((Get-Content (Join-Path $projectRoot 'src-tauri\Cargo.toml') | Select-String '^version\s*=\s*"([^"]+)"').Matches.Groups[1].Value)
}
if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    throw 'Could not determine the expected Konofix Node version.'
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('konofix-node-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

$nodeRun = $null
try {
    $healthPath = Join-Path $tempRoot 'node-health.json'
    $identityPath = Join-Path $tempRoot 'node.key'
    $nodeRun = Start-SmokeNode -HealthPath $healthPath -IdentityPath $identityPath
    $snapshot = Wait-RunningSnapshot -HealthPath $healthPath -Process $nodeRun.Process
    if ($snapshot.version -cne $expectedVersion) {
        throw "Konofix Node runtime version '$($snapshot.version)' does not match expected '$expectedVersion'."
    }
    if ($snapshot.source_commit -cne $expectedSourceCommit) {
        throw "Konofix Node runtime source commit '$($snapshot.source_commit)' does not match expected '$expectedSourceCommit'."
    }
    if ([string]::IsNullOrWhiteSpace([string]$snapshot.peer_id)) {
        throw 'Konofix Node runtime did not expose a Peer ID.'
    }
    $peerId = [string]$snapshot.peer_id

    & $healthValidator -HealthPath $healthPath -ExpectedVersion $expectedVersion -ExpectedPeerId $peerId -ExpectedSourceCommit $expectedSourceCommit -RequirePeer:$false | Out-Null
    $tcp = Invoke-TransportProbe -Transport 'tcp' -Port $nodeRun.Port -ExpectedPeerId $peerId -ExpectedVersion $expectedVersion -ExpectedSourceCommit $expectedSourceCommit
    $quic = Invoke-TransportProbe -Transport 'quic' -Port $nodeRun.Port -ExpectedPeerId $peerId -ExpectedVersion $expectedVersion -ExpectedSourceCommit $expectedSourceCommit
    if ($tcp.authenticated_peer_id -cne $quic.authenticated_peer_id) {
        throw 'TCP and QUIC smoke probes authenticated different Node identities.'
    }
    Write-Host "Konofix Node runtime smoke passed: version=$expectedVersion source_commit=$expectedSourceCommit peer_id=$peerId tcp=PASS quic=PASS"
} finally {
    Stop-SmokeNode -Process $nodeRun.Process
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}