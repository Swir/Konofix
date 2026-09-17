$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'validate-client-netprobe.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-client-netprobe-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

$version = '0.4.2'
$commit = '0123456789abcdef0123456789abcdef01234567'
$peer = '12D3KooWClientProbeSelfTestPeer123456789'
$tcp = "/ip4/8.8.8.8/tcp/45555/p2p/$peer"
$quic = "/ip4/8.8.8.8/udp/45555/quic-v1/p2p/$peer"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Fails([string]$Label, [string]$ExpectedText, [scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch {
        $failed = $true
        if (-not $_.Exception.Message.Contains($ExpectedText)) {
            throw "$Label failed for an unexpected reason: $($_.Exception.Message)"
        }
    }
    if (-not $failed) { throw "$Label was expected to fail." }
    Write-Host "PASS (rejected): $Label" -ForegroundColor Green
}

function New-Probe([string]$Transport, [string]$Target) {
    [ordered]@{
        schema = 1
        status = 'pass'
        tool = 'konofix-netprobe'
        version = $version
        source_commit = $commit
        transport = $Transport
        target = $Target
        expected_peer_id = $peer
        observed_peer_id = $peer
        protocol_version = '/konofix/4.0'
        agent_version = "Konofix-Node/$version"
        rtt_micros = 1500
        elapsed_millis = 25
        timestamp_unix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    }
}

function Write-Evidence([string]$Role, [string]$Path, [string]$BuildInfoHash, [string]$NetprobeHash) {
    $clientId = if ($Role -ceq 'A') { 'client-a-selftest' } else { 'client-b-selftest' }
    $country = if ($Role -ceq 'A') { 'PL' } else { 'NO' }
    $network = if ($Role -ceq 'A') { 'network-a' } else { 'network-b' }
    [ordered]@{
        schema_version = 1
        created_utc = [DateTimeOffset]::UtcNow.ToString('o')
        product = 'Konofix Chat'
        client_role = $Role
        client_id = $clientId
        client_country = $country
        client_network = $network
        build_version = $version
        source_commit = $commit
        build_info_sha256 = $BuildInfoHash
        netprobe_sha256 = $NetprobeHash
        bootstrap_peer_id = $peer
        tcp_bootstrap = $tcp
        quic_bootstrap = $quic
        tcp_probe = New-Probe -Transport 'tcp' -Target $tcp
        quic_probe = New-Probe -Transport 'quic-v1' -Target $quic
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

try {
    $nodePath = Join-Path $temp 'konofix-node.exe'
    $netprobePath = Join-Path $temp 'konofix-netprobe.exe'
    [IO.File]::WriteAllBytes($nodePath, ([byte[]](0..255)))
    [IO.File]::WriteAllBytes($netprobePath, ([byte[]](255..0)))
    $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $netprobeHash = (Get-FileHash -LiteralPath $netprobePath -Algorithm SHA256).Hash.ToLowerInvariant()

    $buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
    [ordered]@{
        schema = 2
        product = 'Konofix Chat'
        version = $version
        commit = $commit
        node = [ordered]@{ path = 'konofix-node.exe'; bytes = [int64](Get-Item $nodePath).Length; sha256 = $nodeHash }
        netprobe = [ordered]@{ path = 'konofix-netprobe.exe'; bytes = [int64](Get-Item $netprobePath).Length; sha256 = $netprobeHash }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8
    $buildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $sessionPath = Join-Path $temp 'SESSION_INFO.json'
    [ordered]@{
        schema_version = 1
        created_utc = [DateTimeOffset]::UtcNow.ToString('o')
        product = 'Konofix Chat'
        build_version = $version
        node_version = $version
        source_commit = $commit
        build_info_sha256 = $buildInfoHash
        node_sha256 = $nodeHash
        bootstrap_peer_id = $peer
        tcp_bootstrap = $tcp
        quic_bootstrap = $quic
        client_a = [ordered]@{ id = 'client-a-selftest'; country = 'PL'; network = 'network-a' }
        client_b = [ordered]@{ id = 'client-b-selftest'; country = 'NO'; network = 'network-b' }
        manifests = @()
        notes = 'client netprobe validator fixture'
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sessionPath -Encoding UTF8

    $a = Join-Path $temp 'client-a-netprobe.json'
    $b = Join-Path $temp 'client-b-netprobe.json'
    Write-Evidence -Role A -Path $a -BuildInfoHash $buildInfoHash -NetprobeHash $netprobeHash
    Write-Evidence -Role B -Path $b -BuildInfoHash $buildInfoHash -NetprobeHash $netprobeHash

    $result = (& $tool -Evidence @($a,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients -AsJson) | ConvertFrom-Json
    Assert-True ($result.status -ceq 'PASS') 'Expected client probe validator PASS.'
    Assert-True ($result.evidence_count -eq 2) 'Expected exactly two client evidence records.'
    Assert-True ($result.authenticated_tcp -eq $true -and $result.authenticated_quic_v1 -eq $true) 'Expected both authenticated transport flags.'
    Assert-True ($result.netprobe_sha256 -ceq $netprobeHash) 'Netprobe hash mismatch in validator result.'

    Assert-Fails 'single-client stable gate' 'exactly two' {
        & $tool -Evidence $a -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $duplicate = Join-Path $temp 'client-duplicate.json'
    Copy-Item -LiteralPath $a -Destination $duplicate
    Assert-Fails 'duplicate role rejection' 'Duplicate client netprobe evidence role' {
        & $tool -Evidence @($a,$duplicate) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $tampered = Join-Path $temp 'client-a-tampered.json'
    $bad = Get-Content -LiteralPath $a -Raw | ConvertFrom-Json
    $bad.tcp_probe.observed_peer_id = '12D3KooWWrongPeer12345678901234567890'
    $bad | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tampered -Encoding UTF8
    Assert-Fails 'authenticated peer mismatch' 'observed_peer_id mismatch' {
        & $tool -Evidence @($tampered,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $wrongTransport = Join-Path $temp 'client-a-wrong-transport.json'
    $bad = Get-Content -LiteralPath $a -Raw | ConvertFrom-Json
    $bad.quic_probe.transport = 'tcp'
    $bad | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $wrongTransport -Encoding UTF8
    Assert-Fails 'transport mismatch' 'transport mismatch' {
        & $tool -Evidence @($wrongTransport,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $originalNetprobe = [IO.File]::ReadAllBytes($netprobePath)
    $tamperedBytes = [byte[]]::new($originalNetprobe.Length + 1)
    [Array]::Copy($originalNetprobe, $tamperedBytes, $originalNetprobe.Length)
    $tamperedBytes[$tamperedBytes.Length - 1] = 0x42
    [IO.File]::WriteAllBytes($netprobePath, $tamperedBytes)
    Assert-Fails 'tampered Netprobe binary rejection' 'size does not match BUILD_INFO' {
        & $tool -Evidence @($a,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }
    [IO.File]::WriteAllBytes($netprobePath, $originalNetprobe)

    Write-Host 'Client Netprobe evidence self-tests passed.' -ForegroundColor Cyan
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
