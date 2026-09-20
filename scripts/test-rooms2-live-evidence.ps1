$ErrorActionPreference = 'Stop'
$newTool = Join-Path $PSScriptRoot 'new-rooms2-live-evidence.ps1'
$validator = Join-Path $PSScriptRoot 'validate-rooms2-live-evidence.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-rooms2-evidence-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null

function Expect-Failure([scriptblock]$Action, [string]$Label) {
  $failed = $false
  try { & $Action | Out-Null } catch { $failed = $true }
  if (-not $failed) { throw "Expected validation failure: $Label" }
}

try {
  $validPath = Join-Path $temp 'valid.json'
  & $newTool -BuildVersion '0.4.2' -SourceCommit ('1' * 40) -WorkflowRun '123456789' -ArtifactSha256 ('a' * 64) -Scenario LAN -ParticipantLabels @('alice','bob','carol') -OutputPath $validPath | Out-Null
  $doc = Get-Content -LiteralPath $validPath -Raw | ConvertFrom-Json
  $doc.started_utc = '2026-09-20T16:00:00Z'
  $doc.finished_utc = '2026-09-20T16:05:00Z'
  $doc.participants[0].peer_id = '12D3KooWAliceExamplePeer0001'
  $doc.participants[1].peer_id = '12D3KooWBobExamplePeer000002'
  $doc.participants[2].peer_id = '12D3KooWCarolExamplePeer0003'
  $values = [ordered]@{
    create_join_count = @(3,3,'alice','alpha','all three clients visible after join')
    switch_count = @(2,2,'bob','beta','two clients visible after switch')
    world_return_count = @(1,1,'carol','alpha','one client remains after WORLD return')
    disconnect_cleanup_count = @(0,0,'alice','alpha','final disconnect removes the peer')
    expiry_cleanup_count = @(0,0,'bob','beta','presence expiry removes stale membership')
    resync_reconnect_count = @(3,3,'carol','alpha','reconnect and resync restore all three')
  }
  foreach ($name in $values.Keys) {
    $v = $values[$name]
    $check = $doc.checks.PSObject.Properties[$name].Value
    $check.result = 'PASS'
    $check.expected_users = $v[0]
    $check.observed_users = $v[1]
    $check.observed_by = $v[2]
    $check.room_id = $v[3]
    $check.evidence = $v[4]
  }
  $doc | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $validPath -Encoding UTF8
  & $validator -EvidencePath $validPath | Out-Null

  $mismatchPath = Join-Path $temp 'mismatch.json'
  Copy-Item $validPath $mismatchPath
  $bad = Get-Content $mismatchPath -Raw | ConvertFrom-Json
  $bad.checks.switch_count.observed_users = 99
  $bad | ConvertTo-Json -Depth 8 | Set-Content $mismatchPath -Encoding UTF8
  Expect-Failure { & $validator -EvidencePath $mismatchPath } 'count mismatch'

  $duplicatePath = Join-Path $temp 'duplicate-peer.json'
  Copy-Item $validPath $duplicatePath
  $bad = Get-Content $duplicatePath -Raw | ConvertFrom-Json
  $bad.participants[2].peer_id = $bad.participants[0].peer_id
  $bad | ConvertTo-Json -Depth 8 | Set-Content $duplicatePath -Encoding UTF8
  Expect-Failure { & $validator -EvidencePath $duplicatePath } 'duplicate Peer ID'

  $artifactPath = Join-Path $temp 'bad-artifact.json'
  Copy-Item $validPath $artifactPath
  $bad = Get-Content $artifactPath -Raw | ConvertFrom-Json
  $bad.artifact_sha256 = 'not-a-sha256'
  $bad | ConvertTo-Json -Depth 8 | Set-Content $artifactPath -Encoding UTF8
  Expect-Failure { & $validator -EvidencePath $artifactPath } 'artifact provenance'

  $internetPath = Join-Path $temp 'internet-no-diversity.json'
  Copy-Item $validPath $internetPath
  $bad = Get-Content $internetPath -Raw | ConvertFrom-Json
  $bad.scenario = 'INTERNET'
  foreach ($participant in $bad.participants) {
    $participant.country = 'NO'
    $participant.network = 'same-network'
  }
  $bad | ConvertTo-Json -Depth 8 | Set-Content $internetPath -Encoding UTF8
  Expect-Failure { & $validator -EvidencePath $internetPath } 'Internet diversity'

  Write-Host 'Rooms 2.0 live-evidence self-tests passed.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
