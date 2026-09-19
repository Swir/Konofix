$ErrorActionPreference = 'Stop'
$generator = Join-Path $PSScriptRoot 'new-tester-handoff.ps1'
$sha = '0123456789abcdef0123456789abcdef01234567'
$runId = '9876543210'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Expect-Failure([string]$Label, [scriptblock]$Action, [string]$ExpectedPattern) {
  $failed = $false
  try {
    & $Action | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch $ExpectedPattern) {
      throw "$Label failed for an unexpected reason: $($_.Exception.Message)"
    }
    $failed = $true
  }
  if (-not $failed) { throw "$Label unexpectedly succeeded." }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-handoff-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $first = Join-Path $temp 'first.md'
  $second = Join-Path $temp 'second.md'

  & $generator -OutputPath $first -Version '0.4.2' -Commit $sha -WorkflowRun $runId | Out-Null
  & $generator -OutputPath $second -Version '0.4.2' -Commit $sha -WorkflowRun $runId | Out-Null

  $firstBytes = [System.IO.File]::ReadAllBytes($first)
  $secondBytes = [System.IO.File]::ReadAllBytes($second)
  Assert-True ($firstBytes.Length -gt 0) 'Generated tester handoff is empty.'
  Assert-True ([System.Linq.Enumerable]::SequenceEqual($firstBytes, $secondBytes)) 'Tester handoff generation is not deterministic for identical inputs.'

  $text = [System.Text.Encoding]::UTF8.GetString($firstBytes)
  Assert-True ($text.Contains('<!-- KONOFIX-TESTER-HANDOFF-BUILD:v1 -->')) 'Generated handoff is missing the exact-build marker.'
  Assert-True ($text.Contains('- Build version: 0.4.2')) 'Generated handoff is missing the exact version.'
  Assert-True ($text.Contains("- Source commit: $sha")) 'Generated handoff is missing the exact source commit.'
  Assert-True ($text.Contains("- Workflow run: $runId")) 'Generated handoff is missing the exact workflow run ID.'
  Assert-True ($text.Contains('test evidence only, not a published GitHub Release')) 'Generated handoff does not clearly distinguish test evidence from a published release.'
  Assert-True ($text.Contains('BUILD_INFO.json')) 'Generated handoff does not identify BUILD_INFO.json as bundle authority.'
  Assert-True ($text.Contains('check-promotion-evidence.ps1')) 'Generated handoff is missing the promotion preflight step.'
  Assert-True ($text.Contains('historical `v0.4.2-test1` prerelease is a separate published preview')) 'Generated handoff does not separate the historical prerelease from the exact build.'
  Assert-True ($text -notmatch '^#\s+Konofix Chat 0\.4\.2 Test 1' ) 'Generated handoff regressed to the historical test-release heading.'

  Expect-Failure 'short SHA' { & $generator -OutputPath (Join-Path $temp 'bad-sha.md') -Version '0.4.2' -Commit '01234567' -WorkflowRun $runId } '40-character Git SHA'
  Expect-Failure 'uppercase SHA' { & $generator -OutputPath (Join-Path $temp 'upper-sha.md') -Version '0.4.2' -Commit '0123456789ABCDEF0123456789ABCDEF01234567' -WorkflowRun $runId } '40-character Git SHA'
  Expect-Failure 'unsafe version' { & $generator -OutputPath (Join-Path $temp 'bad-version.md') -Version '../0.4.2' -Commit $sha -WorkflowRun $runId } 'safe SemVer-like value'
  Expect-Failure 'invalid run ID' { & $generator -OutputPath (Join-Path $temp 'bad-run.md') -Version '0.4.2' -Commit $sha -WorkflowRun 'run-123' } 'decimal GitHub Actions run ID'

  Write-Host 'Exact-build tester handoff self-tests passed.' -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
