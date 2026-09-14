$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.1 - WINDOWS BUILD ===' -ForegroundColor Cyan
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  if (-not (Test-Path node_modules)) { npm install }

  Write-Host '1/2 Budowanie aplikacji Konofix Chat...' -ForegroundColor Yellow
  npm run tauri build

  Write-Host '2/2 Budowanie Konofix Node...' -ForegroundColor Yellow
  Push-Location src-tauri
  try { cargo build --release --bin konofix-node } finally { Pop-Location }

  Write-Host 'Gotowe.' -ForegroundColor Green
  Write-Host 'Aplikacja: src-tauri\target\release\bundle'
  Write-Host 'Node EXE:  src-tauri\target\release\konofix-node.exe'
} finally {
  Pop-Location
}
