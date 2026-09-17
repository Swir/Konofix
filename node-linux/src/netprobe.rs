// Reuse the exact production Netprobe implementation in the headless Linux target
// so CI verifies the same authenticated TCP/QUIC client shipped on Windows.
include!("../../src-tauri/src/bin/konofix-netprobe.rs");
