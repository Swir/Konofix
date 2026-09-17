$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'validate-client-netprobe.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-client-netprobe-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

$version = '0.4.2'
$commit = '0123456789abcdef0123456789abcdef01234567'
$peer = '12D3KooW9tHTtS3inCZiYykw4u5G4frbjVFqhkmJX12gSNCVeH3e'
$otherPeer = 'QmNQa1FSTXNHmrjjfgUW3Px3Vkke4oKiFWdigWkYSux2Pi'
$tcp = "/ip4/8.8.8.8/tcp/45555/p2p/$peer"
$quic = "/ip4/8.8.8.8/udp/45555/quic-v1/p2p/$peer"
$hostA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$hostB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$networkA = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
$networkB = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

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

function Write-Evidence([string]$Role, [string]$Path, [string]$BuildInfoHash, [string]$SessionInfoHash, [string]$NetprobeHash) {
    $clientId = if ($Role -ceq 'A') { 'client-a-selftest' } else { 'client-b-selftest' }
    $country = if ($Role -ceq 'A') { 'PL' } else { 'NO' }
    $network = if ($Role -ceq 'A') { 'network-a' } else { 'network-b' }
    $hostFingerprint = if ($Role -ceq 'A') { $hostA } else { $hostB }
    $networkFingerprint = if ($Role -ceq 'A') { $networkA } else { $networkB }
    [ordered]@{
        schema_version = 2
        created_utc = [DateTimeOffset]::UtcNow.ToString('o')
        product = 'Konofix Chat'
        client_role = $Role
        client_id = $clientId
        client_country = $country
        client_network = $network
        build_version = $version
        source_commit = $commit
        build_info_sha256 = $BuildInfoHash
        session_info_sha256 = $SessionInfoHash
        netprobe_sha256 = $NetprobeHash
        bootstrap_peer_id = $peer
        tcp_bootstrap = $tcp
        quic_bootstrap = $quic
        context_schema = 1
        host_fingerprint_method = 'windows-machine-guid-session-sha256-v1'
        host_fingerprint = $hostFingerprint
        network_fingerprint_method = 'windows-default-route-session-sha256-v1'
        network_fingerprint = $networkFingerprint
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
    $sessionInfoHash = (Get-FileHash -LiteralPath $sessionPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $a = Join-Path $temp 'client-a-netprobe.json'
    $b = Join-Path $temp 'client-b-netprobe.json'
    Write-Evidence -Role A -Path $a -BuildInfoHash $buildInfoHash -SessionInfoHash $sessionInfoHash -NetprobeHash $netprobeHash
    Write-Evidence -Role B -Path $b -BuildInfoHash $buildInfoHash -SessionInfoHash $sessionInfoHash -NetprobeHash $netprobeHash

    $result = (& $tool -Evidence @($a,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients -AsJson) | ConvertFrom-Json
    Assert-True ($result.status -ceq 'PASS') 'Expected client probe validator PASS.'
    Assert-True ($result.evidence_count -eq 2) 'Expected exactly two client evidence records.'
    Assert-True ($result.context_evidence_count -eq 2) 'Expected exactly two context-bound evidence records.'
    Assert-True ($result.authenticated_tcp -eq $true -and $result.authenticated_quic_v1 -eq $true) 'Expected both authenticated transport flags.'
    Assert-True ($result.distinct_hosts -eq $true) 'Expected distinct host fingerprints.'
    Assert-True ($result.distinct_network_contexts -eq $true) 'Expected distinct network fingerprints.'
    Assert-True ($result.session_info_sha256 -ceq $sessionInfoHash) 'SESSION_INFO hash mismatch in validator result.'
    Assert-True ($result.netprobe_sha256 -ceq $netprobeHash) 'Netprobe hash mismatch in validator result.'

    Assert-Fails 'single-client stable gate' 'exactly two' {
        & $tool -Evidence $a -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $duplicate = Join-Path $temp 'client-duplicate.json'
    Copy-Item -LiteralPath $a -Destination $duplicate
    Assert-Fails 'duplicate role rejection' 'Duplicate client netprobe evidence role' {
        & $tool -Evidence @($a,$duplicate) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $legacy = Join-Path $temp 'client-a-legacy.json'
    $legacyData = Get-Content -LiteralPath $a -Raw | ConvertFrom-Json
    $legacyData.schema_version = 1
    foreach ($name in @('context_schema','host_fingerprint_method','host_fingerprint','network_fingerprint_method','network_fingerprint')) {
        $legacyData.PSObject.Properties.Remove($name)
    }
    $legacyData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $legacy -Encoding UTF8
    Assert-Fails 'legacy evidence stable gate' 'schema 2' {
        & $tool -Evidence @($legacy,$b) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $sameHost = Join-Path $temp 'client-b-same-host.json'
    $sameHostData = Get-Content -LiteralPath $b -Raw | ConvertFrom-Json
    $sameHostData.host_fingerprint = $hostA
    $sameHostData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sameHost -Encoding UTF8
    Assert-Fails 'same physical host rejection' 'distinct Windows hosts' {
        & $tool -Evidence @($a,$sameHost) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $sameNetwork = Join-Path $temp 'client-b-same-network.json'
    $sameNetworkData = Get-Content -LiteralPath $b -Raw | ConvertFrom-Json
    $sameNetworkData.network_fingerprint = $networkA
    $sameNetworkData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sameNetwork -Encoding UTF8
    Assert-Fails 'same default-route network rejection' 'distinct default-route network contexts' {
        & $tool -Evidence @($a,$sameNetwork) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $badFingerprint = Join-Path $temp 'client-b-invalid-fingerprint.json'
    $badFingerprintData = Get-Content -LiteralPath $b -Raw | ConvertFrom-Json
    $badFingerprintData.host_fingerprint = 'ABC123'
    $badFingerprintData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $badFingerprint -Encoding UTF8
    Assert-Fails 'non-canonical host fingerprint rejection' 'canonical lowercase SHA-256' {
        & $tool -Evidence @($a,$badFingerprint) -SessionInfoPath $sessionPath -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $replayedSession = Join-Path $temp 'SESSION_INFO-replayed.json'
    Copy-Item -LiteralPath $sessionPath -Destination $replayedSession
    Add-Content -LiteralPath $replayedSession -Value ''
    Assert-True ((Get-FileHash -LiteralPath $replayedSession -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sessionInfoHash) 'Replay fixture must have a distinct SESSION_INFO hash.'
    Assert-Fails 'cross-session replay rejection' 'SESSION_INFO hash mismatch' {
        & $tool -Evidence @($a,$b) -SessionInfoPath $replayedSession -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $wrongIdentitySession = Join-Path $temp 'SESSION_INFO-wrong-identity.json'
    $wrongIdentity = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
    $wrongIdentity.bootstrap_peer_id = $otherPeer
    $wrongIdentity | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $wrongIdentitySession -Encoding UTF8
    Assert-Fails 'session bootstrap identity mismatch' 'does not match TCP bootstrap Peer ID' {
        & $tool -Evidence @($a,$b) -SessionInfoPath $wrongIdentitySession -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $malformedIdentitySession = Join-Path $temp 'SESSION_INFO-malformed-identity.json'
    $malformedIdentity = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
    # Keep the fake inside the base58btc alphabet so this assertion exercises the
    # multihash parser, not the earlier textual-alphabet guard.
    $fakePeer = '12D3KooW7N8jFx6tT8hVYpY3iM3x1bqL6ZpH8sR4wC2dA9eF5gK'
    $malformedIdentity.bootstrap_peer_id = $fakePeer
    $malformedIdentity.tcp_bootstrap = "/ip4/8.8.8.8/tcp/45555/p2p/$fakePeer"
    $malformedIdentity.quic_bootstrap = "/ip4/8.8.8.8/udp/45555/quic-v1/p2p/$fakePeer"
    $malformedIdentity | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $malformedIdentitySession -Encoding UTF8
    Assert-Fails 'shape-only fake Peer ID rejection' 'not a supported libp2p identity/sha2-256 multihash' {
        & $tool -Evidence @($a,$b) -SessionInfoPath $malformedIdentitySession -BuildInfoPath $buildInfoPath -RequireBothClients | Out-Null
    }

    $tampered = Join-Path $temp 'client-a-tampered.json'
    $bad = Get-Content -LiteralPath $a -Raw | ConvertFrom-Json
    $bad.tcp_probe.observed_peer_id = $otherPeer
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
