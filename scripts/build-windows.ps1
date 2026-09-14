$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - WINDOWS BUILD ===' -ForegroundColor Cyan
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  if (-not (Test-Path node_modules)) { npm install }

  Write-Host '1/2 Building Konofix Chat application...' -ForegroundColor Yellow
  npm run tauri build

  Write-Host '2/2 Building Konofix Node...' -ForegroundColor Yellow
  Push-Location src-tauri
  try { cargo build --release --bin konofix-node } finally { Pop-Location }

  Write-Host 'Done.' -ForegroundColor Green
  Write-Host 'Application: src-tauri\target\release\bundle'
  Write-Host 'Node EXE:    src-tauri\target\release\konofix-node.exe'
} finally {
  Pop-Location
}
