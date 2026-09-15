param(
  [string[]]$NetworkEvidence = @(),
  [switch]$RequireNetworkEvidence,
  [int]$NetworkEvidenceMaxAgeDays = 30
)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  Write-Host '=== Konofix Chat - RELEASE GATE ===' -ForegroundColor Cyan

  $package = Get-Content 'package.json' -Raw | ConvertFrom-Json
  $tauri = Get-Content 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $cargoText = Get-Content 'src-tauri\Cargo.toml' -Raw

  $cargoMatch = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $cargoMatch.Success) { throw 'Package version was not found in src-tauri/Cargo.toml.' }

  $npmVersion = [string]$package.version
  $tauriVersion = [string]$tauri.version
  $cargoVersion = $cargoMatch.Groups[1].Value

  Write-Host "package.json : $npmVersion"
  Write-Host "Cargo.toml   : $cargoVersion"
  Write-Host "tauri.conf   : $tauriVersion"

  if ([string]::IsNullOrWhiteSpace($npmVersion)) { throw 'package.json does not define a version.' }
  if ($npmVersion -ne $cargoVersion -or $npmVersion -ne $tauriVersion) {
    throw "Project versions are inconsistent: npm=$npmVersion cargo=$cargoVersion tauri=$tauriVersion"
  }

  $required = @(
    'src-tauri\icons\icon.ico',
    'src-tauri\src\bin\konofix-node.rs',
    'docs\NODE.md',
    'docs\TESTING.md',
    'docs\RELEASE_0.4.2_TEST1.md',
    'ROADMAP.md',
    'CHANGELOG.md',
    '.github\workflows\windows-ci.yml',
    'scripts\validate-network-test-report.ps1'
  )

  foreach ($path in $required) {
    if (-not (Test-Path $path)) { throw "Required release file is missing: $path" }
  }

  if ((Get-Item 'src-tauri\icons\icon.ico').Length -lt 256) { throw 'icon.ico appears to be damaged or empty.' }

  $roadmap = Get-Content 'ROADMAP.md' -Raw
  if ($roadmap -notmatch [regex]::Escape("## $npmVersion — Real Internet Test")) {
    throw "ROADMAP.md does not contain the active $npmVersion stage."
  }

  $changelog = Get-Content 'CHANGELOG.md' -Raw
  if ($changelog -notmatch [regex]::Escape("## $npmVersion")) { throw "CHANGELOG.md does not contain version $npmVersion." }

  if ($RequireNetworkEvidence -and $NetworkEvidence.Count -eq 0) {
    throw 'Stable promotion requires -NetworkEvidence with schema-v2 PASS manifests.'
  }

  if ($NetworkEvidence.Count -gt 0) {
    Write-Host 'Validating real-network promotion evidence...' -ForegroundColor Cyan
    $validatorArgs = @{
      Manifest = $NetworkEvidence
      MaxAgeDays = $NetworkEvidenceMaxAgeDays
      ExpectedBuildVersion = $npmVersion
      ExpectedNodeVersion = $cargoVersion
    }
    if ($RequireNetworkEvidence) { $validatorArgs.RequireSingleBootstrapPeer = $true }
    & (Join-Path $PSScriptRoot 'validate-network-test-report.ps1') @validatorArgs
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Network evidence validator exited with code $LASTEXITCODE." }
  } elseif (-not $RequireNetworkEvidence) {
    Write-Host 'Network evidence not requested: pre-release/build gate only.' -ForegroundColor Yellow
  }

  Write-Host "OK - release gate for Konofix Chat $npmVersion passed." -ForegroundColor Green
} finally {
  Pop-Location
}
