$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - CHECK ===' -ForegroundColor Cyan

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing '$cmd'. $hint"
  }
}

Need node 'Install Node.js 20+.'
Need npm 'Install Node.js 20+.'
Need cargo 'Install Rust with rustup (MSVC toolchain).'
Need rustc 'Install Rust with rustup (MSVC toolchain).'

Write-Host "Node:  $(node --version)"
Write-Host "npm:   $(npm --version)"
Write-Host "Rust:  $(rustc --version)"
Write-Host "Cargo: $(cargo --version)"

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  Write-Host 'README roadmap progress...' -ForegroundColor Yellow
  $roadmap = Get-Content ROADMAP.md -Raw
  $readme = Get-Content README.md -Raw
  $milestone = [regex]::Match($roadmap, '(?ms)^## 0\.4\.2 — Real Internet Test.*?(?=^## 0\.5\.0)')
  if (-not $milestone.Success) { throw 'Cannot locate the active 0.4.2 roadmap milestone.' }
  $done = ([regex]::Matches($milestone.Value, '(?m)^- \[x\] ')).Count
  $open = ([regex]::Matches($milestone.Value, '(?m)^- \[ \] ')).Count
  $total = $done + $open
  if ($total -le 0) { throw 'Active roadmap milestone contains no checklist tasks.' }
  $percent = [int][math]::Round(($done * 100.0) / $total, 0, [MidpointRounding]::AwayFromZero)
  if ($readme -notmatch "Real Internet Test milestone: $percent% complete") {
    throw "README progress is stale: roadmap is $done/$total ($percent%). Update the README progress bar with the roadmap."
  }
  if ($readme -notmatch "(?m)^`[^`]* $percent%`$") {
    throw "README progress bar does not show the current $percent%."
  }
  Write-Host "README progress OK: $done/$total ($percent%)." -ForegroundColor Green

  if (-not (Test-Path node_modules)) {
    Write-Host 'npm install...' -ForegroundColor Yellow
    npm install
  }
  Write-Host 'TypeScript...' -ForegroundColor Yellow
  npx tsc --noEmit

  Write-Host 'Frontend build...' -ForegroundColor Yellow
  npm run build

  Write-Host 'Rust: application + Konofix Node...' -ForegroundColor Yellow
  Push-Location src-tauri
  try {
    cargo check
    cargo check --bin konofix-node
  } finally { Pop-Location }

  Write-Host 'OK - frontend, Rust application, Konofix Node, and roadmap progress checks passed.' -ForegroundColor Green
} finally {
  Pop-Location
}
