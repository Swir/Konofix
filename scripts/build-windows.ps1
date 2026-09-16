$ErrorActionPreference = 'Stop'
Write-Host '=== Konofix Chat 0.4.2 - WINDOWS BUILD ===' -ForegroundColor Cyan
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  if (-not (Test-Path 'package-lock.json' -PathType Leaf)) { throw 'Committed package-lock.json is missing.' }
  if (-not (Test-Path 'src-tauri\Cargo.lock' -PathType Leaf)) { throw 'Committed src-tauri/Cargo.lock is missing.' }

  $npmLockBefore = (Get-FileHash 'package-lock.json' -Algorithm SHA256).Hash.ToLowerInvariant()
  $cargoLockBefore = (Get-FileHash 'src-tauri\Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant()

  Write-Host '0/3 Installing locked frontend dependencies...' -ForegroundColor Yellow
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

  Write-Host 'Validating locked Rust dependency graph...' -ForegroundColor Yellow
  cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "cargo metadata --locked failed with exit code $LASTEXITCODE." }

  Write-Host '1/3 Building Konofix Chat application...' -ForegroundColor Yellow
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "Tauri production build failed with exit code $LASTEXITCODE." }
  if (-not (Test-Path 'src-tauri\target\release\bundle' -PathType Container)) {
    throw 'Tauri build reported success but the Windows bundle directory is missing.'
  }

  Write-Host '2/3 Building Konofix Node with locked Rust dependencies...' -ForegroundColor Yellow
  cargo build --manifest-path src-tauri/Cargo.toml --release --bin konofix-node --locked
  if ($LASTEXITCODE -ne 0) { throw "Konofix Node production build failed with exit code $LASTEXITCODE." }
  if (-not (Test-Path 'src-tauri\target\release\konofix-node.exe' -PathType Leaf)) {
    throw 'Konofix Node build reported success but konofix-node.exe is missing.'
  }
  if ((Get-Item 'src-tauri\target\release\konofix-node.exe').Length -le 0) {
    throw 'konofix-node.exe is empty.'
  }

  Write-Host '3/3 Verifying dependency locks stayed immutable...' -ForegroundColor Yellow
  $npmLockAfter = (Get-FileHash 'package-lock.json' -Algorithm SHA256).Hash.ToLowerInvariant()
  $cargoLockAfter = (Get-FileHash 'src-tauri\Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::Equals($npmLockBefore, $npmLockAfter, [System.StringComparison]::Ordinal)) {
    throw 'package-lock.json changed during the production build.'
  }
  if (-not [string]::Equals($cargoLockBefore, $cargoLockAfter, [System.StringComparison]::Ordinal)) {
    throw 'src-tauri/Cargo.lock changed during the production build.'
  }

  Write-Host 'Done - deterministic dependency inputs verified.' -ForegroundColor Green
  Write-Host 'Application: src-tauri\target\release\bundle'
  Write-Host 'Node EXE:    src-tauri\target\release\konofix-node.exe'
} finally {
  Pop-Location
}
