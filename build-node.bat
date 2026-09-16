@echo off
cd /d "%~dp0src-tauri"
cargo build --locked --release --bin konofix-node
pause
