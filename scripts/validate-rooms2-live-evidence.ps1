param(
  [Parameter(Mandatory = $true)][string]$EvidencePath,
  [int]$MinimumParticipants = 3
)

$ErrorActionPreference = 'Stop'
$MaxEvidenceBytes = 256KB
$RequiredChecks = @(
  'create_join_count',
  'switch_count',
  'world_return_count',
  'disconnect_cleanup_count',
  'expiry_cleanup_count',
  'resync_reconnect_count'
)

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Read-StrictJson([string]$Path) {
  Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "Evidence file is missing: $Path"
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).Path)
  Assert-True ($bytes.Length -gt 0) 'Evidence file is empty.'
  Assert-True ($bytes.Length -le $MaxEvidenceBytes) "Evidence file exceeds the 256 KiB limit. bytes=$($bytes.Length)"
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $utf8.GetString($bytes) } catch { throw 'Evidence file is not valid strict UTF-8.' }
  try { return $text | ConvertFrom-Json } catch { throw "Evidence file is not valid JSON: $($_.Exception.Message)" }
}

function Get-ExactInteger($Value, [string]$Label) {
  Assert-True ($null -ne $Value) "$Label is missing."
  Assert-True (-not ($Value -is [string]) -and -not ($Value -is [bool])) "$Label must be a JSON integer, not a string/boolean."
  $number = [double]$Value
  Assert-True (-not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and $number -ge 0 -and [Math]::Floor($number) -eq $number) "$Label must be a non-negative JSON integer."
  Assert-True ($number -le 100000) "$Label exceeds the evidence sanity limit."
  return [int64]$number
}

$doc = Read-StrictJson -Path $EvidencePath
Assert-True ([int]$doc.schema_version -eq 1) 'Unsupported Rooms 2.0 live-evidence schema_version.'
Assert-True ([string]::Equals([string]$doc.kind, 'konofix-rooms2-live-evidence', [System.StringComparison]::Ordinal)) 'Unexpected evidence kind.'
Assert-True (([string]$doc.build_version) -cmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') 'build_version is missing or invalid.'
Assert-True (([string]$doc.source_commit) -cmatch '^[0-9a-f]{40}$') 'source_commit must be an exact lowercase 40-character Git SHA.'
Assert-True (([string]$doc.workflow_run) -cmatch '^[1-9][0-9]*$') 'workflow_run must be a positive decimal GitHub Actions run ID.'
Assert-True (([string]$doc.artifact_sha256) -cmatch '^[0-9a-f]{64}$') 'artifact_sha256 must be a lowercase SHA-256 digest.'
Assert-True (@('LAN','INTERNET') -ccontains ([string]$doc.scenario)) 'scenario must be LAN or INTERNET.'
Assert-True ($MinimumParticipants -ge 3 -and $MinimumParticipants -le 1000) 'MinimumParticipants must be between 3 and 1000.'

$started = [DateTimeOffset]::MinValue
$finished = [DateTimeOffset]::MinValue
Assert-True ([DateTimeOffset]::TryParse([string]$doc.started_utc, [ref]$started)) 'started_utc must be a valid timestamp.'
Assert-True ([DateTimeOffset]::TryParse([string]$doc.finished_utc, [ref]$finished)) 'finished_utc must be a valid timestamp.'
Assert-True ($finished -gt $started) 'finished_utc must be later than started_utc.'

$participants = @($doc.participants)
Assert-True ($participants.Count -ge $MinimumParticipants) "Evidence has too few participants. actual=$($participants.Count) required=$MinimumParticipants"
$labels = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$peerIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$countries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$networks = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($participant in $participants) {
  $label = ([string]$participant.label).Trim()
  $peerId = ([string]$participant.peer_id).Trim()
  Assert-True ($label -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') "Invalid participant label: '$label'"
  Assert-True ($labels.Add($label)) "Duplicate participant label: '$label'"
  Assert-True ($peerId -match '^[A-Za-z0-9]{16,128}$') "Participant '$label' has an invalid or missing Peer ID."
  Assert-True ($peerIds.Add($peerId)) "Duplicate Peer ID in participant evidence: '$peerId'"
  if (-not [string]::IsNullOrWhiteSpace([string]$participant.country)) { [void]$countries.Add(([string]$participant.country).Trim()) }
  if (-not [string]::IsNullOrWhiteSpace([string]$participant.network)) { [void]$networks.Add(([string]$participant.network).Trim()) }
}
if ([string]$doc.scenario -ceq 'INTERNET') {
  Assert-True ($countries.Count -ge 2) 'INTERNET evidence requires at least two independently identified countries.'
  Assert-True ($networks.Count -ge 2) 'INTERNET evidence requires at least two independently identified networks/operators.'
}

Assert-True ($null -ne $doc.checks) 'checks object is missing.'
foreach ($name in $RequiredChecks) {
  $property = $doc.checks.PSObject.Properties[$name]
  Assert-True ($null -ne $property) "Required Rooms 2.0 check is missing: $name"
  $check = $property.Value
  Assert-True ([string]::Equals([string]$check.result, 'PASS', [System.StringComparison]::Ordinal)) "$name must be exactly PASS."
  $roomId = ([string]$check.room_id).Trim()
  Assert-True ($roomId -match '^[A-Za-z0-9_-]{1,64}$') "$name has an invalid room_id."
  $expected = Get-ExactInteger -Value $check.expected_users -Label "$name.expected_users"
  $observed = Get-ExactInteger -Value $check.observed_users -Label "$name.observed_users"
  Assert-True ($expected -eq $observed) "$name count mismatch. expected=$expected observed=$observed"
  $observer = ([string]$check.observed_by).Trim()
  Assert-True ($labels.Contains($observer)) "$name.observed_by must name one of the recorded participants."
  $evidence = ([string]$check.evidence).Trim()
  Assert-True ($evidence.Length -ge 4 -and $evidence.Length -le 1000) "$name requires concise concrete evidence text (4..1000 chars)."
}

$result = [ordered]@{
  status = 'PASS'
  schema_version = 1
  build_version = [string]$doc.build_version
  source_commit = [string]$doc.source_commit
  workflow_run = [string]$doc.workflow_run
  artifact_sha256 = [string]$doc.artifact_sha256
  scenario = [string]$doc.scenario
  participant_count = $participants.Count
  started_utc = $started.ToString('o')
  finished_utc = $finished.ToString('o')
}
$result | ConvertTo-Json -Depth 4
Write-Host "Rooms 2.0 live evidence PASS: participants=$($participants.Count) scenario=$($doc.scenario) source=$($doc.source_commit) run=$($doc.workflow_run)" -ForegroundColor Green
