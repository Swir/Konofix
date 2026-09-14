@echo off
cd /d "%~dp0src-tauri"
cargo build --release --bin konofix-node
pause
