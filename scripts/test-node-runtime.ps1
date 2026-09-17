param(
    [string]$NodePath = '',
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
} elseif ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = Join-Path $projectRoot 'src-tauri\target\release\konofix-node.exe'
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Konofix Node executable not found: $NodePath"
}
$node = (Resolve-Path -LiteralPath $NodePath).Path
$healthValidator = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not (Test-Path -LiteralPath $healthValidator -PathType Leaf)) {
    throw "Node health validator not found: $healthValidator"
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
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

    $port = Get-FreeTcpPort
    $arguments = @(
        '--port', [string]$port,
        '--public-host', '127.0.0.1',
        '--status-interval', '10',
        '--health-file', $HealthPath,
        '--identity-file', $IdentityPath
    )
    return Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden
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

    Write-Host 'Node runtime smoke: first production-binary start...' -ForegroundColor Yellow
    $firstProcess = Start-SmokeNode -HealthPath $healthFirst -IdentityPath $identityPath
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
    $secondProcess = Start-SmokeNode -HealthPath $healthSecond -IdentityPath $identityPath
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

    $mode = if ($artifactMode) { 'release-bundle' } else { 'repository-build' }
    Write-Host "PASS: $mode konofix-node.exe started twice, emitted valid exact-build health telemetry, and preserved Peer ID $firstPeerId." -ForegroundColor Green
} finally {
    Stop-SmokeNode -Process $firstProcess
    Stop-SmokeNode -Process $secondProcess
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
