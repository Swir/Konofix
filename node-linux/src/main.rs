// Keep the production Node implementation single-sourced while giving Linux a
// Cargo target that never compiles the Windows/Tauri desktop library.
include!("../../src-tauri/src/bin/konofix-node.rs");
