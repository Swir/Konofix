$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - WINDOWS BUILD ===' -ForegroundColor Cyan
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  Write-Host 'Installing locked frontend dependencies...' -ForegroundColor Yellow
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

  Write-Host 'Validating locked Rust dependency graph...' -ForegroundColor Yellow
  cargo metadata --locked --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "cargo metadata --locked failed with exit code $LASTEXITCODE." }

  Write-Host '1/3 Building Konofix Chat application...' -ForegroundColor Yellow
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }

  Write-Host '2/3 Building Konofix Node...' -ForegroundColor Yellow
  Push-Location src-tauri
  try {
    cargo build --locked --release --bin konofix-node
    if ($LASTEXITCODE -ne 0) { throw "Konofix Node build failed with exit code $LASTEXITCODE." }
  } finally { Pop-Location }

  Write-Host '3/3 Smoke-testing production Konofix Node...' -ForegroundColor Yellow
  & '.\scripts\test-node-runtime.ps1'
  if ($LASTEXITCODE -ne 0) { throw "Konofix Node runtime smoke failed with exit code $LASTEXITCODE." }

  Write-Host 'Done.' -ForegroundColor Green
  Write-Host 'Application: src-tauri\target\release\bundle'
  Write-Host 'Node EXE:    src-tauri\target\release\konofix-node.exe'
} finally {
  Pop-Location
}
