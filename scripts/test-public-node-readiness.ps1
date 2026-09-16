$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'check-public-node-readiness.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    throw "Readiness validator is missing: $validator"
}

function Expect-Failure {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Contains
    )

    try {
        & $Action
    } catch {
        $message = $_.Exception.Message
        if ($message -notlike "*$Contains*") {
            throw "Expected failure containing '$Contains' but got: $message"
        }
        return
    }
    throw "Expected failure containing '$Contains' but the command succeeded."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-readiness-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
    $peer = '12D3KooWQd1w4w6m7rV8xY9ZaBcDeFgHiJkMnPqRsTuVwXyZ12'
    $otherPeer = '12D3KooWRsTuVwXyZ12Qd1w4w6m7rV8xY9ZaBcDeFgHiJkMnPq'
    $sourceCommit = '0123456789abcdef0123456789abcdef01234567'
    $tcp = "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
    $quic = "/ip4/203.0.113.10/udp/45555/quic-v1/p2p/$peer"
    $healthPath = Join-Path $tempRoot 'health.json'
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

    $health = [ordered]@{
        schema = 2
        status = 'running'
        version = '0.4.2'
        source_commit = $sourceCommit
        peer_id = $peer
        uptime_seconds = 900
        connected_peers = 2
        timestamp_unix = $now
    }
    $health | ConvertTo-Json | Set-Content -LiteralPath $healthPath -Encoding utf8

    $positiveJson = & $validator `
        -TcpBootstrap $tcp `
        -QuicBootstrap $quic `
        -HealthPath $healthPath `
        -ExpectedVersion '0.4.2' `
        -ExpectedSourceCommit $sourceCommit `
        -MinUptimeSeconds 600 `
        -MinConnectedPeers 1 `
        -SkipTcpReachability `
        -AsJson
    $positive = $positiveJson | ConvertFrom-Json
    if (-not $positive.ready -or [string]$positive.peer_id -cne $peer) {
        throw 'Positive readiness fixture did not produce the expected ready result.'
    }
    if (-not $positive.quic_multiaddr_validated -or $positive.quic_handshake_proven) {
        throw 'Readiness result must validate the QUIC address without claiming a handshake it did not perform.'
    }

    Expect-Failure -Contains 'same Konofix Node Peer ID' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap "/ip4/203.0.113.10/udp/45555/quic-v1/p2p/$otherPeer" -HealthPath $healthPath -SkipTcpReachability -AsJson | Out-Null
    }

    Expect-Failure -Contains 'same public host' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap "/ip4/198.51.100.20/udp/45555/quic-v1/p2p/$peer" -HealthPath $healthPath -SkipTcpReachability -AsJson | Out-Null
    }

    Expect-Failure -Contains 'same port' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap "/ip4/203.0.113.10/udp/45556/quic-v1/p2p/$peer" -HealthPath $healthPath -SkipTcpReachability -AsJson | Out-Null
    }

    Expect-Failure -Contains 'TcpBootstrap must use TCP' -Action {
        & $validator -TcpBootstrap $quic -QuicBootstrap $quic -HealthPath $healthPath -SkipTcpReachability -AsJson | Out-Null
    }

    Expect-Failure -Contains 'QuicBootstrap must use UDP/QUIC v1' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap $tcp -HealthPath $healthPath -SkipTcpReachability -AsJson | Out-Null
    }

    $health.status = 'stopped'
    $health.timestamp_unix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $health | ConvertTo-Json | Set-Content -LiteralPath $healthPath -Encoding utf8
    Expect-Failure -Contains 'not running' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap $quic -HealthPath $healthPath -ExpectedSourceCommit $sourceCommit -SkipTcpReachability -AsJson | Out-Null
    }

    $health.status = 'running'
    $health.timestamp_unix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $health | ConvertTo-Json | Set-Content -LiteralPath $healthPath -Encoding utf8
    Expect-Failure -Contains 'source commit mismatch' -Action {
        & $validator -TcpBootstrap $tcp -QuicBootstrap $quic -HealthPath $healthPath -ExpectedSourceCommit 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -SkipTcpReachability -AsJson | Out-Null
    }

    Write-Host 'OK - public Node readiness validator positive and adversarial self-tests passed.' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
