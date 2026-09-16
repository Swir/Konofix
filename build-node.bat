@echo off
setlocal
cd /d "%~dp0src-tauri"
if not exist "Cargo.lock" (
  echo ERROR: committed src-tauri\Cargo.lock is missing.
  pause
  exit /b 1
)
cargo build --locked --release --bin konofix-node
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" echo ERROR: Konofix Node build failed with exit code %ERR%.
pause
exit /b %ERR%
