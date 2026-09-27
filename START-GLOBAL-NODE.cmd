@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-global-node-windows.ps1"
echo.
pause
