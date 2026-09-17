include!("build-shared.rs");

// Shared build provenance exports KONOFIX_SOURCE_COMMIT for the desktop, Node and Netprobe binaries.

#[cfg(windows)]
fn build_desktop_app() {
    tauri_build::build();
}

#[cfg(not(windows))]
fn build_desktop_app() {
    // The desktop application is currently a Windows target. Keeping the Tauri build hook
    // out of non-Windows builds lets the headless Konofix Node compile on a minimal Linux VPS
    // without pulling GUI/WebKit development dependencies into the server build.
}

fn main() {
    emit_build_provenance();
    build_desktop_app();
}
