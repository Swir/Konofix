use std::{env, path::Path, process::Command};

fn canonical_commit(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    if value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(value)
    } else {
        None
    }
}

fn git_stdout(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
}

fn source_commit() -> String {
    if let Ok(value) = env::var("GITHUB_SHA") {
        if let Some(commit) = canonical_commit(&value) {
            return commit;
        }
    }

    git_stdout(&["rev-parse", "HEAD"])
        .as_deref()
        .and_then(canonical_commit)
        .unwrap_or_else(|| "unknown".to_string())
}

fn emit_git_rerun_paths() {
    // CI gets a clean checkout, but local incremental builds must also refresh the
    // embedded provenance when a symbolic branch advances. Watching only .git/HEAD
    // is insufficient because that file usually keeps the same `ref: ...` text.
    let mut logical_paths = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(symbolic_ref) =
        git_stdout(&["symbolic-ref", "-q", "HEAD"]).filter(|value| !value.is_empty())
    {
        logical_paths.push(symbolic_ref);
    }

    logical_paths.sort();
    logical_paths.dedup();
    for logical_path in logical_paths {
        if let Some(path) = git_stdout(&["rev-parse", "--git-path", &logical_path]) {
            if !path.is_empty() && Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    emit_git_rerun_paths();
    println!("cargo:rustc-env=KONOFIX_SOURCE_COMMIT={}", source_commit());
    tauri_build::build()
}
