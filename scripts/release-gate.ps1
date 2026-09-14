$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  Write-Host '=== Konofix Chat - RELEASE GATE ===' -ForegroundColor Cyan

  $package = Get-Content 'package.json' -Raw | ConvertFrom-Json
  $tauri = Get-Content 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $cargoText = Get-Content 'src-tauri\Cargo.toml' -Raw

  $cargoMatch = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $cargoMatch.Success) {
    throw 'Nie znaleziono wersji package w src-tauri/Cargo.toml.'
  }

  $npmVersion = [string]$package.version
  $tauriVersion = [string]$tauri.version
  $cargoVersion = $cargoMatch.Groups[1].Value

  Write-Host "package.json : $npmVersion"
  Write-Host "Cargo.toml   : $cargoVersion"
  Write-Host "tauri.conf   : $tauriVersion"

  if ([string]::IsNullOrWhiteSpace($npmVersion)) {
    throw 'package.json nie ma wersji.'
  }
  if ($npmVersion -ne $cargoVersion -or $npmVersion -ne $tauriVersion) {
    throw "Niespójne wersje projektu: npm=$npmVersion cargo=$cargoVersion tauri=$tauriVersion"
  }

  $required = @(
    'src-tauri\icons\icon.ico',
    'src-tauri\src\bin\konofix-node.rs',
    'docs\NODE.md',
    'docs\TESTING.md',
    'docs\RELEASE_0.4.2_TEST1.md',
    'ROADMAP.md',
    'CHANGELOG.md',
    '.github\workflows\windows-ci.yml'
  )

  foreach ($path in $required) {
    if (-not (Test-Path $path)) {
      throw "Brak wymaganego pliku release: $path"
    }
  }

  if ((Get-Item 'src-tauri\icons\icon.ico').Length -lt 256) {
    throw 'icon.ico wygląda na uszkodzoną lub pustą.'
  }

  $roadmap = Get-Content 'ROADMAP.md' -Raw
  if ($roadmap -notmatch [regex]::Escape("## $npmVersion — Real Internet Test")) {
    throw "ROADMAP.md nie zawiera aktywnego etapu wersji $npmVersion."
  }

  $changelog = Get-Content 'CHANGELOG.md' -Raw
  if ($changelog -notmatch [regex]::Escape("## $npmVersion")) {
    throw "CHANGELOG.md nie zawiera wersji $npmVersion."
  }

  Write-Host "OK - release gate dla Konofix Chat $npmVersion przeszedł." -ForegroundColor Green
} finally {
  Pop-Location
}
