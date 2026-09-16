use std::{env, process::Command};

fn canonical_commit(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    if value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(value)
    } else {
        None
    }
}

fn source_commit() -> String {
    if let Ok(value) = env::var("GITHUB_SHA") {
        if let Some(commit) = canonical_commit(&value) {
            return commit;
        }
    }

    if let Ok(output) = Command::new("git").args(["rev-parse", "HEAD"]).output() {
        if output.status.success() {
            if let Ok(value) = String::from_utf8(output.stdout) {
                if let Some(commit) = canonical_commit(&value) {
                    return commit;
                }
            }
        }
    }

    "unknown".to_string()
}

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
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rustc-env=KONOFIX_SOURCE_COMMIT={}", source_commit());
    build_desktop_app();
}
