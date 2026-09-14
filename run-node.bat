@echo off
setlocal
cd /d "%~dp0src-tauri"

echo ==========================================
echo     Konofix Node 0.4.2 - Internet Node
echo ==========================================
echo.
set "PORT=45555"
set "STATUS_INTERVAL=30"
set "HEALTH_FILE=%LOCALAPPDATA%\Konofix Chat\node-health.json"
set /p "PUBLIC_HOST=Enter public IP or DNS name (ENTER = no public address): "
echo.
echo Status interval: %STATUS_INTERVAL%s
echo Health snapshot: %HEALTH_FILE%
echo.

if "%PUBLIC_HOST%"=="" (
  cargo run --bin konofix-node -- --port %PORT% --status-interval %STATUS_INTERVAL% --health-file "%HEALTH_FILE%"
) else (
  cargo run --bin konofix-node -- --port %PORT% --public-host "%PUBLIC_HOST%" --status-interval %STATUS_INTERVAL% --health-file "%HEALTH_FILE%"
)

echo.
pause
