use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const UPDATE_BRANCH: &str = "beta/0.6.0-audio-calls";
const UPDATE_VERSION: &str = "0.6.0";
const ARTIFACT_PREFIX: &str = "Konofix-Chat-0.6.0-Windows-";
const GITHUB_API: &str = "https://api.github.com/repos/Swir/Konofix";
const NIGHTLY_BASE: &str = "https://nightly.link/Swir/Konofix/actions/artifacts";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestUpdateInfo {
    pub channel: String,
    pub version: String,
    pub current_source_commit: String,
    pub source_commit: String,
    pub run_id: u64,
    pub run_number: u64,
    pub artifact_id: u64,
    pub artifact_name: String,
    pub artifact_sha256: String,
    pub download_url: String,
    pub update_available: bool,
}

#[derive(Debug, Deserialize)]
struct RemoteUpdate {
    source_commit: String,
    run_id: u64,
    run_number: u64,
    artifact_id: u64,
    artifact_name: String,
    artifact_sha256: String,
}

fn current_source_commit() -> String {
    option_env!("KONOFIX_SOURCE_COMMIT")
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase()
}

fn powershell(script: &str) -> Result<Output, String> {
    Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("Could not start PowerShell for the test updater: {error}"))
}

fn powershell_ok(script: &str) -> Result<String, String> {
    let output = powershell(script)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Test updater PowerShell command failed.".to_string()
        } else {
            format!("Test updater failed: {stderr}")
        });
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| "Test updater returned non-UTF-8 output.".to_string())
}

fn query_remote_update() -> Result<RemoteUpdate, String> {
    let runs_url = format!(
        "{GITHUB_API}/actions/workflows/windows-ci.yml/runs?branch={}&status=success&per_page=10",
        UPDATE_BRANCH.replace('/', "%2F")
    );
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$headers = @{{ 'User-Agent' = 'Konofix-Test-Updater'; 'Accept' = 'application/vnd.github+json' }}
$runs = Invoke-RestMethod -Uri '{runs_url}' -Headers $headers
$run = @($runs.workflow_runs | Where-Object {{ $_.event -eq 'pull_request' -and $_.head_branch -eq '{branch}' }}) | Select-Object -First 1
if (-not $run) {{ throw 'No successful Windows CI run is available for the test channel.' }}
$artifacts = Invoke-RestMethod -Uri ('{api}/actions/runs/' + $run.id + '/artifacts?per_page=100') -Headers $headers
$artifact = @($artifacts.artifacts | Where-Object {{ -not $_.expired -and $_.name -like '{prefix}*' }}) | Select-Object -First 1
if (-not $artifact) {{ throw 'The successful Windows CI run has no usable Konofix test artifact.' }}
$digest = [string]$artifact.digest
if ($digest -notmatch '^sha256:[0-9a-fA-F]{{64}}$') {{ throw 'GitHub artifact digest is missing or invalid.' }}
[pscustomobject]@{{
  source_commit = ([string]$run.head_sha).ToLowerInvariant()
  run_id = [uint64]$run.id
  run_number = [uint64]$run.run_number
  artifact_id = [uint64]$artifact.id
  artifact_name = [string]$artifact.name
  artifact_sha256 = $digest.Substring(7).ToLowerInvariant()
}} | ConvertTo-Json -Compress"#,
        branch = UPDATE_BRANCH,
        api = GITHUB_API,
        prefix = ARTIFACT_PREFIX,
    );
    let raw = powershell_ok(&script)?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid GitHub updater metadata: {error}"))
}

fn update_info() -> Result<TestUpdateInfo, String> {
    let remote = query_remote_update()?;
    if remote.source_commit.len() != 40
        || !remote.source_commit.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Updater rejected an invalid source commit from GitHub.".into());
    }
    if remote.artifact_sha256.len() != 64
        || !remote
            .artifact_sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("Updater rejected an invalid GitHub artifact digest.".into());
    }
    if !remote.artifact_name.starts_with(ARTIFACT_PREFIX) {
        return Err("Updater rejected an unexpected artifact name.".into());
    }
    let current = current_source_commit();
    Ok(TestUpdateInfo {
        channel: "0.6.x test".into(),
        version: UPDATE_VERSION.into(),
        current_source_commit: current.clone(),
        source_commit: remote.source_commit.clone(),
        run_id: remote.run_id,
        run_number: remote.run_number,
        artifact_id: remote.artifact_id,
        artifact_name: remote.artifact_name,
        artifact_sha256: remote.artifact_sha256,
        download_url: format!("{NIGHTLY_BASE}/{}.zip", remote.artifact_id),
        update_available: current == "unknown" || current != remote.source_commit,
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn updater_dir(artifact_id: u64) -> PathBuf {
    std::env::temp_dir().join(format!("Konofix-Test-Update-{artifact_id}"))
}

fn download_and_extract(info: &TestUpdateInfo) -> Result<PathBuf, String> {
    let root = updater_dir(info.artifact_id);
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("Could not clear old updater files: {error}"))?;
    }
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create updater directory: {error}"))?;
    let zip = root.join("update.zip");
    let extract = root.join("extracted");

    let download_script = format!(
        r#"$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'"#,
        info.download_url.replace('\'', "''"),
        zip.display().to_string().replace('\'', "''"),
    );
    powershell_ok(&download_script)?;

    let actual = sha256_file(&zip)?;
    if !actual.eq_ignore_ascii_case(&info.artifact_sha256) {
        let _ = fs::remove_dir_all(&root);
        return Err(format!(
            "Downloaded update failed SHA-256 verification (expected {}, got {}).",
            info.artifact_sha256, actual
        ));
    }

    let extract_script = format!(
        r#"$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force"#,
        zip.display().to_string().replace('\'', "''"),
        extract.display().to_string().replace('\'', "''"),
    );
    powershell_ok(&extract_script)?;
    Ok(extract)
}

fn verified_installer(extract: &Path, info: &TestUpdateInfo) -> Result<PathBuf, String> {
    let build_info_path = extract.join("artifact").join("BUILD_INFO.json");
    let build_info: Value = serde_json::from_slice(
        &fs::read(&build_info_path)
            .map_err(|error| format!("Missing BUILD_INFO.json in update: {error}"))?,
    )
    .map_err(|error| format!("Invalid BUILD_INFO.json in update: {error}"))?;

    let version = build_info
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let commit = build_info
        .get("commit")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if version != UPDATE_VERSION || !commit.eq_ignore_ascii_case(&info.source_commit) {
        return Err("Downloaded update provenance does not match the GitHub CI metadata.".into());
    }

    let installers = build_info
        .get("installers")
        .and_then(Value::as_array)
        .ok_or("BUILD_INFO.json has no installer inventory.")?;
    let installer = installers
        .iter()
        .find(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| {
                    path.starts_with("bundle/nsis/") && path.ends_with("-setup.exe")
                })
        })
        .ok_or("No NSIS installer is present in the verified test artifact.")?;

    let relative = installer
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Installer path is invalid.")?;
    let expected_sha = installer
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or("Installer SHA-256 is missing.")?;
    if expected_sha.len() != 64
        || !expected_sha.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Installer SHA-256 in BUILD_INFO.json is invalid.".into());
    }
    let installer_path = extract.join("artifact").join(relative.replace('/', "\\"));
    if !installer_path.is_file() {
        return Err("Verified installer file is missing from the extracted update.".into());
    }
    let actual_sha = sha256_file(&installer_path)?;
    if !actual_sha.eq_ignore_ascii_case(expected_sha) {
        return Err("Installer SHA-256 does not match BUILD_INFO.json.".into());
    }
    Ok(installer_path)
}

#[tauri::command]
pub async fn check_test_update() -> Result<TestUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(update_info)
        .await
        .map_err(|error| format!("Updater check task failed: {error}"))?
}

#[tauri::command]
pub async fn install_test_update(app: AppHandle) -> Result<(), String> {
    let info = tauri::async_runtime::spawn_blocking(update_info)
        .await
        .map_err(|error| format!("Updater metadata task failed: {error}"))??;
    if !info.update_available {
        return Err("This is already the newest successful 0.6.x test build.".into());
    }

    let info_for_task = info.clone();
    let installer = tauri::async_runtime::spawn_blocking(move || {
        let extracted = download_and_extract(&info_for_task)?;
        verified_installer(&extracted, &info_for_task)
    })
    .await
    .map_err(|error| format!("Updater download task failed: {error}"))??;

    Command::new(&installer)
        .spawn()
        .map_err(|error| format!("Could not start the verified Konofix installer: {error}"))?;
    app.exit(0);
    Ok(())
}
