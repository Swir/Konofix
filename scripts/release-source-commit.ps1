param(
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path $PSScriptRoot -Parent
}
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$expectedPin = [string]$env:KONOFIX_SOURCE_SHA
if (-not [string]::IsNullOrWhiteSpace($expectedPin) -and $expectedPin -cnotmatch '^[0-9a-f]{40}$') {
  throw 'KONOFIX_SOURCE_SHA must be a full lowercase source commit.'
}

$headOutput = @(& git -C $resolvedRoot rev-parse --verify HEAD 2>$null)
$gitExitCode = $LASTEXITCODE
if ($gitExitCode -ne 0 -or $headOutput.Count -ne 1) {
  throw 'Unable to resolve the checked-out source commit.'
}
$head = ([string]$headOutput[0]).Trim()
if ($head -cnotmatch '^[0-9a-f]{40}$') {
  throw "Checked-out source commit is invalid: '$head'."
}
if (-not [string]::IsNullOrWhiteSpace($expectedPin) -and
    -not [string]::Equals($expectedPin, $head, [System.StringComparison]::Ordinal)) {
  throw "KONOFIX_SOURCE_SHA does not match the checked-out source commit. expected=$expectedPin actual=$head"
}

# Intentionally ignore GITHUB_SHA here. On pull_request runs it identifies the
# synthetic merge ref, while release/test artifacts are built from the explicitly
# checked-out PR head recorded by KONOFIX_SOURCE_SHA.
$head
