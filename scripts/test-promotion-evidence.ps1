$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'check-promotion-evidence.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-promotion-evidence-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

$version = '0.4.2'
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$peerId = '12D3KooWPromotionSelfTestPeer123456789'
$tcpBootstrap = "/dns/konofix.example.test/tcp/45555/p2p/$peerId"
$quicBootstrap = "/dns/konofix.example.test/udp/45555/quic-v1/p2p/$peerId"
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Fails([string]$Label, [string]$ExpectedText, [scriptblock]$Action) {
  $failed = $false
  try { & $Action | Out-Null } catch {
    $failed = $true
    if (-not $_.Exception.Message.Contains($ExpectedText)) {
      throw "$Label failed with an unexpected error: $($_.Exception.Message)"
    }
  }
  if (-not $failed) { throw "$Label was expected to fail." }
}

function New-NetworkManifest([string]$Scenario, [string]$Path) {
  $checks = [ordered]@{
    world_a_to_b = 'PASS'; world_b_to_a = 'PASS'; room_discovery = 'PASS'
    file_a_to_b_sha256 = 'PASS'; file_b_to_a_sha256 = 'PASS'; client_reconnect = 'PASS'
    node_restart_recovery = 'PASS'; relay_observed = 'N/A'; dcutr_direct_upgrade = 'N/A'
    nickname_conflict = 'PASS'
  }
  if ($Scenario -eq 'Relay' -or $Scenario -eq 'CGNAT') { $checks.relay_observed = 'PASS' }
  if ($Scenario -eq 'DCUtR') { $checks.dcutr_direct_upgrade = 'PASS' }
  $bootstrap = if ($Scenario -eq 'QUIC') { $quicBootstrap } else { $tcpBootstrap }
  [ordered]@{
    schema_version = 3
    created_utc = [DateTimeOffset]::UtcNow.ToString('o')
    scenario = $Scenario
    build_version = $version
    node_version = $version
    source_commit = $sourceCommit
    client_a = 'promotion-selftest-a'
    client_b = 'promotion-selftest-b'
    client_a_country = 'PL'
    client_b_country = 'NO'
    client_a_network = 'promotion-net-a'
    client_b_network = 'promotion-net-b'
    bootstrap = $bootstrap
    overall = 'PASS'
    checks = $checks
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function New-SoakSnapshot([string]$Path, [int64]$Timestamp, [int64]$Uptime, [int64]$Peers) {
  [ordered]@{
    schema = 2
    status = 'running'
    version = $version
    source_commit = $sourceCommit
    peer_id = $peerId
    uptime_seconds = $Uptime
    connected_peers = $Peers
    timestamp_unix = $Timestamp
  } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
}

try {
  $nodePath = Join-Path $temp 'konofix-node.exe'
  $nodeBytesFixture = [byte[]]::new(4096)
  for ($i = 0; $i -lt $nodeBytesFixture.Length; $i++) { $nodeBytesFixture[$i] = [byte]($i % 251) }
  [IO.File]::WriteAllBytes($nodePath, $nodeBytesFixture)
  $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
  [ordered]@{
    schema = 1
    product = 'Konofix Chat'
    version = $version
    commit = $sourceCommit
    node = [ordered]@{
      path = 'konofix-node.exe'
      bytes = [int64](Get-Item -LiteralPath $nodePath).Length
      sha256 = $nodeHash
    }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8
  $buildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()

  $networkPaths = @()
  foreach ($scenario in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
    $path = Join-Path $temp ("network-test-{0}-selftest.json" -f $scenario.ToLowerInvariant())
    New-NetworkManifest -Scenario $scenario -Path $path
    $networkPaths += $path
  }

  $sessionInfoPath = Join-Path $temp 'SESSION_INFO.json'
  $manifestInventory = @($networkPaths | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    [ordered]@{
      path = $item.Name
      bytes = [int64]$item.Length
      sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  [ordered]@{
    schema_version = 1
    created_utc = [DateTimeOffset]::UtcNow.ToString('o')
    product = 'Konofix Chat'
    build_version = $version
    node_version = $version
    source_commit = $sourceCommit
    build_info_sha256 = $buildInfoHash
    node_sha256 = $nodeHash
    bootstrap_peer_id = $peerId
    tcp_bootstrap = $tcpBootstrap
    quic_bootstrap = $quicBootstrap
    client_a = [ordered]@{ id = 'promotion-selftest-a'; country = 'PL'; network = 'promotion-net-a' }
    client_b = [ordered]@{ id = 'promotion-selftest-b'; country = 'NO'; network = 'promotion-net-b' }
    manifests = $manifestInventory
    notes = 'promotion session fixture'
  } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $sessionInfoPath -Encoding UTF8

  $soakPaths = @()
  $samples = @(
    @{ offset = -180; uptime = 1000; peers = 0 },
    @{ offset = -120; uptime = 1060; peers = 1 },
    @{ offset = -60; uptime = 1120; peers = 1 },
    @{ offset = 0; uptime = 1180; peers = 2 }
  )
  for ($i = 0; $i -lt $samples.Count; $i++) {
    $path = Join-Path $temp ("soak-{0}.json" -f $i)
    New-SoakSnapshot -Path $path -Timestamp ($now + $samples[$i].offset) -Uptime $samples[$i].uptime -Peers $samples[$i].peers
    $soakPaths += $path
  }

  $soakWildcard = Join-Path $temp 'soak-*.json'
  $result = (& $tool `
    -BuildInfoPath $buildInfoPath `
    -SessionInfoPath $sessionInfoPath `
    -NetworkEvidence $networkPaths `
    -NodeSoakEvidence $soakWildcard `
    -NodeSoakMinSpanSeconds 180 `
    -NodeSoakMaxGapSeconds 75 `
    -NodeSoakMaxAgeSeconds 60 `
    -AsJson) | ConvertFrom-Json

  Assert-True ($result.schema -eq 1) 'Promotion result schema must be 1.'
  Assert-True ($result.status -ceq 'PASS') 'Promotion evidence must return PASS.'
  Assert-True ($result.version -ceq $version) 'Promotion result version mismatch.'
  Assert-True ($result.source_commit -ceq $sourceCommit) 'Promotion result source commit mismatch.'
  Assert-True ($result.bootstrap_peer_id -ceq $peerId) 'Promotion result bootstrap Peer ID mismatch.'
  Assert-True ($result.network_manifest_count -eq 5) 'Promotion result must report five required network scenarios.'
  Assert-True ($result.node_soak_snapshot_count -eq 4) 'Promotion wildcard expansion must resolve all four soak snapshots.'
  Assert-True ($result.node_binary_sha256 -ceq $nodeHash) 'Promotion result Node SHA-256 mismatch.'
  Assert-True ($result.build_info_sha256 -ceq $buildInfoHash) 'Promotion result BUILD_INFO SHA-256 mismatch.'
  Assert-True ($result.coherent_test_session -eq $true) 'Promotion result must prove a coherent test session.'

  Assert-Fails 'empty wildcard rejection' 'wildcard matched no files' {
    & $tool -BuildInfoPath $buildInfoPath -SessionInfoPath $sessionInfoPath -NetworkEvidence $networkPaths -NodeSoakEvidence (Join-Path $temp 'missing-soak-*.json') -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  $originalNodeBytes = [IO.File]::ReadAllBytes($nodePath)
  $tamperedNodeBytes = [byte[]]::new($originalNodeBytes.Length + 1)
  [Array]::Copy($originalNodeBytes, $tamperedNodeBytes, $originalNodeBytes.Length)
  $tamperedNodeBytes[$tamperedNodeBytes.Length - 1] = 0x7f
  [IO.File]::WriteAllBytes($nodePath, $tamperedNodeBytes)
  Assert-Fails 'tampered Node rejection' 'size does not match BUILD_INFO' {
    & $tool -BuildInfoPath $buildInfoPath -SessionInfoPath $sessionInfoPath -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }
  [IO.File]::WriteAllBytes($nodePath, $originalNodeBytes)

  $wrongBuild = Join-Path $temp 'BUILD_INFO-wrong-commit.json'
  $bad = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
  $bad.commit = '89abcdef0123456789abcdef0123456789abcdef'
  $bad | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $wrongBuild -Encoding UTF8
  Assert-Fails 'wrong build provenance rejection' 'source commit' {
    & $tool -BuildInfoPath $wrongBuild -SessionInfoPath $sessionInfoPath -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  $stringSchema = Join-Path $temp 'BUILD_INFO-string-schema.json'
  $raw = Get-Content -LiteralPath $buildInfoPath -Raw
  $raw = $raw -replace '"schema"\s*:\s*1', '"schema": "1"'
  Set-Content -LiteralPath $stringSchema -Value $raw -Encoding UTF8
  Assert-Fails 'string schema rejection' 'must be a JSON integer' {
    & $tool -BuildInfoPath $stringSchema -SessionInfoPath $sessionInfoPath -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  $mixedSessionPath = Join-Path $temp 'SESSION_INFO-mixed-client.json'
  $mixedSession = Get-Content -LiteralPath $sessionInfoPath -Raw | ConvertFrom-Json
  $mixedSession.client_b.country = 'DE'
  $mixedSession | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $mixedSessionPath -Encoding UTF8
  Assert-Fails 'mixed session endpoint rejection' 'client_b_country does not match SESSION_INFO' {
    & $tool -BuildInfoPath $buildInfoPath -SessionInfoPath $mixedSessionPath -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  Write-Host 'OK - packaged Node bytes, exact BUILD_INFO provenance, one coherent test session, wildcard evidence resolution, all required real-network scenarios and matching public-Node soak history are combined into one fail-closed promotion preflight.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
