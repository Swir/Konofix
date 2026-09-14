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

  Write-Host 'OK - frontend, Rust application, and Konofix Node checks passed.' -ForegroundColor Green
} finally {
  Pop-Location
}
