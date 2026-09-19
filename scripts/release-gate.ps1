param(
  [string[]]$NetworkEvidence = @(),
  [switch]$RequireNetworkEvidence,
  [int]$NetworkEvidenceMaxAgeDays = 30,
  [string]$NetworkSessionInfo = '',

  [string[]]$NodeSoakEvidence = @(),
  [switch]$RequireNodeSoakEvidence,
  [int]$NodeSoakMinSpanSeconds = 3600,
  [int]$NodeSoakMaxGapSeconds = 180,
  [int]$NodeSoakMaxAgeSeconds = 300,

  [string]$ExpectedSourceCommit = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-SourceCommit {
  param([string]$ExplicitCommit, [string]$RepositoryRoot)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitCommit)) {
    $candidate = $ExplicitCommit.Trim().ToLowerInvariant()
    if ($candidate -cnotmatch '^[0-9a-f]{40}$') { throw 'ExpectedSourceCommit must be a canonical lowercase 40-character Git commit SHA.' }
    return $candidate
  }

  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
    $candidate = $env:GITHUB_SHA.Trim().ToLowerInvariant()
    if ($candidate -cmatch '^[0-9a-f]{40}$') { return $candidate }
  }

  if (Get-Command git -ErrorAction SilentlyContinue) {
    try {
      $candidate = (& git -C $RepositoryRoot rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
      if ($LASTEXITCODE -eq 0 -and $candidate -cmatch '^[0-9a-f]{40}$') { return $candidate }
    } catch {}
  }

  throw 'Could not determine the exact source commit required for stable promotion. Pass -ExpectedSourceCommit explicitly.'
}

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
    'docs\NODE_SOAK.md',
    'docs\TESTING.md',
    'docs\RELEASE_0.4.2_TEST1.md',
    'ROADMAP.md',
    'CHANGELOG.md',
    '.github\workflows\windows-ci.yml',
    'scripts\validate-network-test-report.ps1',
    'scripts\validate-network-test-session.ps1',
    'scripts\validate-node-soak.ps1'
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

  $stablePromotion = $RequireNetworkEvidence -or $RequireNodeSoakEvidence
  $targetSourceCommit = ''
  if ($stablePromotion -or -not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
    $targetSourceCommit = Resolve-SourceCommit -ExplicitCommit $ExpectedSourceCommit -RepositoryRoot $root
    Write-Host "source commit : $targetSourceCommit"

    if ($stablePromotion -and (Get-Command git -ErrorAction SilentlyContinue)) {
      $dirty = @(& git -C $root status --porcelain 2>$null)
      if ($LASTEXITCODE -eq 0 -and $dirty.Count -gt 0) {
        throw 'Stable promotion requires a clean Git working tree so evidence is bound to the exact committed source.'
      }
    }
  }

  if ($RequireNetworkEvidence -and $NetworkEvidence.Count -eq 0) {
    throw 'Stable promotion requires -NetworkEvidence with schema-v3 PASS manifests.'
  }
  if ($RequireNetworkEvidence -and [string]::IsNullOrWhiteSpace($NetworkSessionInfo)) {
    throw 'Stable promotion requires -NetworkSessionInfo so all transport evidence is bound to one coherent cross-country test session.'
  }

  $expectedBootstrapPeer = ''
  if ($NetworkEvidence.Count -gt 0) {
    Write-Host 'Validating real-network promotion evidence...' -ForegroundColor Cyan
    $validatorArgs = @{
      Manifest = $NetworkEvidence
      MaxAgeDays = $NetworkEvidenceMaxAgeDays
      ExpectedBuildVersion = $npmVersion
      ExpectedNodeVersion = $cargoVersion
    }
    if (-not [string]::IsNullOrWhiteSpace($targetSourceCommit)) { $validatorArgs.ExpectedSourceCommit = $targetSourceCommit }
    if ($RequireNetworkEvidence) { $validatorArgs.RequireSingleBootstrapPeer = $true }

    $networkValidationText = (& (Join-Path $PSScriptRoot 'validate-network-test-report.ps1') @validatorArgs -AsJson | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($networkValidationText)) { throw 'Network evidence validator returned no structured result.' }
    try { $networkValidation = $networkValidationText | ConvertFrom-Json } catch { throw "Network evidence validator returned invalid structured JSON: $($_.Exception.Message)" }
    if ([int]$networkValidation.schema -ne 1 -or [string]$networkValidation.status -cne 'PASS') {
      throw 'Network evidence validator did not return the expected PASS aggregate.'
    }

    if ($RequireNetworkEvidence) {
      $expectedBootstrapPeer = [string]$networkValidation.bootstrap_peer_id
      if ([string]::IsNullOrWhiteSpace($expectedBootstrapPeer)) {
        throw 'Stable promotion evidence validator did not return exactly one validated bootstrap Peer ID.'
      }

      Write-Host 'Validating coherent cross-country test session...' -ForegroundColor Cyan
      $sessionArgs = @{
        SessionInfoPath = $NetworkSessionInfo
        Manifest = $NetworkEvidence
        ExpectedBuildVersion = $npmVersion
        ExpectedNodeVersion = $cargoVersion
        ExpectedBootstrapPeerId = $expectedBootstrapPeer
        RequirePassingEvidence = $true
      }
      if (-not [string]::IsNullOrWhiteSpace($targetSourceCommit)) { $sessionArgs.ExpectedSourceCommit = $targetSourceCommit }
      & (Join-Path $PSScriptRoot 'validate-network-test-session.ps1') @sessionArgs
    }
  } elseif (-not $RequireNetworkEvidence) {
    Write-Host 'Network evidence not requested: pre-release/build gate only.' -ForegroundColor Yellow
  }

  $soakRequired = $RequireNodeSoakEvidence -or $RequireNetworkEvidence
  if ($soakRequired -and $NodeSoakEvidence.Count -eq 0) {
    throw 'Stable promotion requires -NodeSoakEvidence proving continuous public Node stability.'
  }

  if ($NodeSoakEvidence.Count -gt 0) {
    Write-Host 'Validating public Node soak evidence...' -ForegroundColor Cyan
    $soakArgs = @{
      Snapshot = $NodeSoakEvidence
      MinSpanSeconds = $NodeSoakMinSpanSeconds
      MaxGapSeconds = $NodeSoakMaxGapSeconds
      MaxAgeSeconds = $NodeSoakMaxAgeSeconds
      ExpectedVersion = $cargoVersion
    }
    if (-not [string]::IsNullOrWhiteSpace($targetSourceCommit)) { $soakArgs.ExpectedSourceCommit = $targetSourceCommit }
    if (-not [string]::IsNullOrWhiteSpace($expectedBootstrapPeer)) { $soakArgs.ExpectedPeerId = $expectedBootstrapPeer }
    if ($RequireNetworkEvidence) { $soakArgs.RequirePeerObserved = $true }
    & (Join-Path $PSScriptRoot 'validate-node-soak.ps1') @soakArgs
  } elseif (-not $soakRequired) {
    Write-Host 'Node soak evidence not requested: pre-release/build gate only.' -ForegroundColor Yellow
  }

  Write-Host "OK - release gate for Konofix Chat $npmVersion passed." -ForegroundColor Green
} finally {
  Pop-Location
}
