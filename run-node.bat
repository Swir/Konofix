@echo off
setlocal
cd /d "%~dp0src-tauri"

echo ==========================================
echo     Konofix Node 0.4.2 - Internet Node
echo ==========================================
echo.
set "PORT=45555"
set /p "PUBLIC_HOST=Enter public IP or DNS name (ENTER = no public address): "
echo.

if "%PUBLIC_HOST%"=="" (
  cargo run --bin konofix-node -- --port %PORT%
) else (
  cargo run --bin konofix-node -- --port %PORT% --public-host "%PUBLIC_HOST%"
)

echo.
pause
