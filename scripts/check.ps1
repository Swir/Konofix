$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - CHECK ===' -ForegroundColor Cyan

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing '$cmd'. $hint"
  }
}

Need node 'Install Node.js 22+.'
Need npm 'Install Node.js 22+.'
Need cargo 'Install Rust with rustup (MSVC toolchain).'
Need rustc 'Install Rust with rustup (MSVC toolchain).'
Need rustfmt 'Install rustfmt with: rustup component add rustfmt.'
Need cargo-clippy 'Install clippy with: rustup component add clippy.'

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

  Write-Host 'Promotion evidence preflight self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-promotion-evidence.ps1'

  Write-Host 'Network report editor self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-network-report-editor.ps1'

  Write-Host 'Network test session bootstrap self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-network-test-session.ps1'

  Write-Host 'Internet bootstrap precheck self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-internet-precheck.ps1'

  Write-Host 'Public Node deployment self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-public-node.ps1'

  Write-Host 'Public Node startup-task self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-public-node-task.ps1'

  Write-Host 'Public Node readiness self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-public-node-readiness.ps1'

  Write-Host 'Node health validator self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-node-health.ps1'

  Write-Host 'Node soak stability self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-node-soak.ps1'

  Write-Host 'Node soak collector self-tests...' -ForegroundColor Yellow
  & '.\scripts\test-node-soak-collector.ps1'

  Write-Host 'Frontend dependencies (locked)...' -ForegroundColor Yellow
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

  Write-Host 'Project consistency and localization audit...' -ForegroundColor Yellow
  npm run audit
  if ($LASTEXITCODE -ne 0) { throw "npm run audit failed with exit code $LASTEXITCODE." }

  Write-Host 'TypeScript + Vite build...' -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust lockfile metadata gate...' -ForegroundColor Yellow
  cargo metadata --locked --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "cargo metadata --locked failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust format check...' -ForegroundColor Yellow
  cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
  if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust Clippy - correctness, suspicious and performance gates...' -ForegroundColor Yellow
  cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D clippy::correctness -D clippy::suspicious -D clippy::perf
  if ($LASTEXITCODE -ne 0) { throw "cargo clippy --locked failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust all-target tests...' -ForegroundColor Yellow
  cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
  if ($LASTEXITCODE -ne 0) { throw "cargo test --locked failed with exit code $LASTEXITCODE." }

  Write-Host 'Rust checks: application + Konofix Node...' -ForegroundColor Yellow
  cargo check --locked --manifest-path src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "cargo check --locked failed with exit code $LASTEXITCODE." }
  cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-node
  if ($LASTEXITCODE -ne 0) { throw "cargo check --locked --bin konofix-node failed with exit code $LASTEXITCODE." }

  Write-Host 'OK - local preflight matches CI gates, promotion evidence, atomic exact-build network-session creation, network report editing, public-Node/bootstrap/startup-task/readiness/health/soak collection validation, deterministic frontend and Rust dependency inputs, frontend build, Rust formatting/high-signal Clippy/tests and Node checks.' -ForegroundColor Green
} finally {
  Pop-Location
}
