@echo off
cd /d "%~dp0src-tauri"
cargo run --bin konofix-node -- --port 45555
pause
