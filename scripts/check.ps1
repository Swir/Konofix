$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.1 - CHECK ===' -ForegroundColor Cyan

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Brak '$cmd'. $hint"
  }
}

Need node 'Zainstaluj Node.js 20+.'
Need npm 'Zainstaluj Node.js 20+.'
Need cargo 'Zainstaluj Rust przez rustup (MSVC).'
Need rustc 'Zainstaluj Rust przez rustup (MSVC).'

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

  Write-Host 'Rust: aplikacja + Konofix Node...' -ForegroundColor Yellow
  Push-Location src-tauri
  try {
    cargo check
    cargo check --bin konofix-node
  } finally { Pop-Location }

  Write-Host 'OK - frontend, aplikacja Rust i Konofix Node przechodzą kontrolę.' -ForegroundColor Green
} finally {
  Pop-Location
}
