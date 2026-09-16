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

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  Write-Host 'Release metadata gate...' -ForegroundColor Yellow
  & '.\scripts\release-gate.ps1'

  Write-Host 'Network evidence validator self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-network-evidence-gate.ps1'

  Write-Host 'Internet bootstrap precheck self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-internet-precheck.ps1'

  Write-Host 'Node health validator self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-node-health.ps1'

  Write-Host 'Node soak stability self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-node-soak.ps1'

  Write-Host 'Frontend dependencies...' -ForegroundColor Yellow
  npm install --no-audit --no-fund --package-lock=false
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }

  Write-Host 'Project consistency and localization audit...' -ForegroundColor Yellow
  npm run audit
  if ($LASTEXITCODE -ne 0) { throw "npm run audit failed with exit code $LASTEXITCODE." }

  Write-Host 'TypeScript + Vite build...' -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust all-target tests...' -ForegroundColor Yellow
  cargo test --manifest-path src-tauri/Cargo.toml --all-targets
  if ($LASTEXITCODE -ne 0) { throw "cargo test failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust checks: application + Konofix Node...' -ForegroundColor Yellow
  cargo check --manifest-path src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "cargo check failed with exit code $LASTEXITCODE." }
  cargo check --manifest-path src-tauri/Cargo.toml --bin konofix-node
  if ($LASTEXITCODE -ne 0) { throw "cargo check --bin konofix-node failed with exit code $LASTEXITCODE." }

  Write-Host 'OK - local preflight matches the CI validation path for gates, bootstrap parsing, frontend, Rust tests and Node checks.' -ForegroundColor Green
} finally {
  Pop-Location
}
