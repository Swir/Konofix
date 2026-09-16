$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'check-promotion-evidence.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-promotion-evidence-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

$version = '0.4.2'
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$peerId = '12D3KooWPromotionSelfTestPeer123456789'
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
    bootstrap = "/dns/konofix.example.test/tcp/45555/p2p/$peerId"
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
  $buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
  [ordered]@{
    schema = 1
    product = 'Konofix Chat'
    version = $version
    commit = $sourceCommit
    node = [ordered]@{
      path = 'konofix-node.exe'
      bytes = 1234567
      sha256 = ('a' * 64)
    }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8

  $networkPaths = @()
  foreach ($scenario in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
    $path = Join-Path $temp "$($scenario.ToLowerInvariant()).json"
    New-NetworkManifest -Scenario $scenario -Path $path
    $networkPaths += $path
  }

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

  $result = (& $tool `
    -BuildInfoPath $buildInfoPath `
    -NetworkEvidence $networkPaths `
    -NodeSoakEvidence $soakPaths `
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
  Assert-True ($result.node_soak_snapshot_count -eq 4) 'Promotion result soak snapshot count mismatch.'

  $wrongBuild = Join-Path $temp 'BUILD_INFO-wrong-commit.json'
  $bad = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
  $bad.commit = '89abcdef0123456789abcdef0123456789abcdef'
  $bad | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $wrongBuild -Encoding UTF8
  Assert-Fails 'wrong build provenance rejection' 'source commit' {
    & $tool -BuildInfoPath $wrongBuild -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  $stringSchema = Join-Path $temp 'BUILD_INFO-string-schema.json'
  $raw = Get-Content -LiteralPath $buildInfoPath -Raw
  $raw = $raw -replace '"schema"\s*:\s*1', '"schema": "1"'
  Set-Content -LiteralPath $stringSchema -Value $raw -Encoding UTF8
  Assert-Fails 'string schema rejection' 'must be a JSON integer' {
    & $tool -BuildInfoPath $stringSchema -NetworkEvidence $networkPaths -NodeSoakEvidence $soakPaths -NodeSoakMinSpanSeconds 180 -NodeSoakMaxGapSeconds 75 -NodeSoakMaxAgeSeconds 60 | Out-Null
  }

  Write-Host 'OK - exact BUILD_INFO provenance, all required real-network scenarios and matching public-Node soak evidence are combined into one fail-closed promotion preflight.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
