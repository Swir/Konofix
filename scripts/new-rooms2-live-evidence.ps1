param(
  [Parameter(Mandatory = $true)][string]$BuildVersion,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][string]$WorkflowRun,
  [Parameter(Mandatory = $true)][string]$ArtifactSha256,
  [Parameter(Mandatory = $true)][ValidateSet('LAN','INTERNET')][string]$Scenario,
  [Parameter(Mandatory = $true)][string[]]$ParticipantLabels,
  [string]$OutputPath = 'test-results/rooms2-live-evidence.json',
  [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'

if ($BuildVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "BuildVersion must be a SemVer-like exact build version: '$BuildVersion'"
}
$commit = $SourceCommit.Trim().ToLowerInvariant()
if ($commit -cnotmatch '^[0-9a-f]{40}$') { throw 'SourceCommit must be a full lowercase 40-character Git commit SHA.' }
if ($WorkflowRun -cnotmatch '^[1-9][0-9]*$') { throw 'WorkflowRun must be a positive decimal GitHub Actions run ID.' }
$artifactHash = $ArtifactSha256.Trim().ToLowerInvariant()
if ($artifactHash -cnotmatch '^[0-9a-f]{64}$') { throw 'ArtifactSha256 must be the lowercase SHA-256 of the exact test archive.' }

$labels = @($ParticipantLabels | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($labels.Count -lt 3) { throw 'Rooms 2.0 live evidence requires at least three participant labels.' }
$unique = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($label in $labels) {
  if ($label.Length -gt 64 -or $label -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Unsafe participant label: '$label'" }
  if (-not $unique.Add($label)) { throw "Duplicate participant label: '$label'" }
}

$participants = foreach ($label in $labels) {
  [ordered]@{ label = $label; peer_id = ''; country = ''; network = '' }
}

function New-PendingCheck {
  [ordered]@{
    result = 'PENDING'
    room_id = ''
    expected_users = $null
    observed_users = $null
    observed_by = ''
    evidence = ''
  }
}

$now = [DateTimeOffset]::UtcNow
$doc = [ordered]@{
  schema_version = 1
  kind = 'konofix-rooms2-live-evidence'
  build_version = $BuildVersion
  source_commit = $commit
  workflow_run = $WorkflowRun
  artifact_sha256 = $artifactHash
  scenario = $Scenario
  created_utc = $now.ToString('o')
  started_utc = ''
  finished_utc = ''
  participants = @($participants)
  checks = [ordered]@{
    create_join_count = New-PendingCheck
    switch_count = New-PendingCheck
    world_return_count = New-PendingCheck
    disconnect_cleanup_count = New-PendingCheck
    expiry_cleanup_count = New-PendingCheck
    resync_reconnect_count = New-PendingCheck
  }
  notes = $Notes
}

$full = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $full
if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$json = $doc | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($full, $json.Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Rooms 2.0 live-evidence template written: $full" -ForegroundColor Green
Write-Host 'Fill real Peer IDs, timestamps and UI-observed counts, then run validate-rooms2-live-evidence.ps1. This template does not grant readiness credit by itself.'
