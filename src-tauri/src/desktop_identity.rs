use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use libp2p::identity;

const DESKTOP_IDENTITY_FILE: &str = "desktop-identity.key";

pub(crate) fn default_identity_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|base| base.join("Konofix Chat").join(DESKTOP_IDENTITY_FILE))
        .ok_or_else(|| {
            "Unable to resolve the local application-data directory for the Konofix identity."
                .to_string()
        })
}

#[cfg(unix)]
fn harden_identity_permissions(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        format!(
            "Failed to inspect desktop identity permissions {}: {error}",
            path.display()
        )
    })?;
    let mut permissions = metadata.permissions();
    let current_mode = permissions.mode();
    let protected_mode = current_mode & !0o077;
    if current_mode != protected_mode {
        permissions.set_mode(protected_mode);
        std::fs::set_permissions(path, permissions).map_err(|error| {
            format!(
                "Failed to restrict desktop identity permissions {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_identity_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn decode_identity(path: &Path, data: &[u8]) -> Result<identity::Keypair, String> {
    identity::Keypair::from_protobuf_encoding(data).map_err(|error| {
        format!(
            "Konofix desktop identity {} is invalid; refusing to replace it because that would change this installation's Peer ID: {error}",
            path.display()
        )
    })
}

fn load_existing_identity(path: &Path) -> Result<identity::Keypair, String> {
    let data = std::fs::read(path).map_err(|error| {
        format!(
            "Failed to read Konofix desktop identity {}: {error}",
            path.display()
        )
    })?;
    harden_identity_permissions(path)?;
    decode_identity(path, &data)
}

fn load_identity_after_create_race(path: &Path) -> Result<identity::Keypair, String> {
    let mut last_error = None;
    for _ in 0..20 {
        match load_existing_identity(path) {
            Ok(key) => return Ok(key),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(format!(
        "Konofix desktop identity {} appeared concurrently but could not be loaded safely: {}",
        path.display(),
        last_error.unwrap_or_else(|| "unknown identity load error".into())
    ))
}

pub(crate) fn load_or_create_identity(path: &Path) -> Result<identity::Keypair, String> {
    match std::fs::read(path) {
        Ok(data) => {
            harden_identity_permissions(path)?;
            return decode_identity(path, &data);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to read Konofix desktop identity {}: {error}",
                path.display()
            ))
        }
    }

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create Konofix desktop identity directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let key = identity::Keypair::generate_ed25519();
    let encoded = key
        .to_protobuf_encoding()
        .map_err(|error| format!("Failed to encode generated Konofix desktop identity: {error}"))?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return load_identity_after_create_race(path)
        }
        Err(error) => {
            return Err(format!(
                "Failed to create Konofix desktop identity {}: {error}",
                path.display()
            ))
        }
    };

    if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(format!(
            "Failed to persist Konofix desktop identity {}: {error}",
            path.display()
        ));
    }

    harden_identity_permissions(path)?;
    Ok(key)
}

pub(crate) fn load_default_identity() -> Result<identity::Keypair, String> {
    load_or_create_identity(&default_identity_path()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "konofix-desktop-identity-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test identity directory");
        root.join("identity.key")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn desktop_identity_survives_restart_without_rewriting_key_bytes() {
        let path = test_path("persist");
        let first = load_or_create_identity(&path).expect("create identity");
        let first_peer = first.public().to_peer_id();
        let first_bytes = std::fs::read(&path).expect("read identity bytes");
        drop(first);

        let second = load_or_create_identity(&path).expect("reload identity");
        assert_eq!(second.public().to_peer_id(), first_peer);
        assert_eq!(
            std::fs::read(&path).expect("read reloaded bytes"),
            first_bytes
        );
        cleanup(&path);
    }

    #[test]
    fn corrupt_desktop_identity_fails_closed_without_silent_peer_rotation() {
        let path = test_path("corrupt");
        let corrupt = b"not-a-libp2p-private-key".to_vec();
        std::fs::write(&path, &corrupt).expect("write corrupt identity");

        let error = load_or_create_identity(&path).expect_err("corrupt identity must fail");
        assert!(error.contains("refusing to replace"));
        assert_eq!(std::fs::read(&path).expect("read corrupt bytes"), corrupt);
        cleanup(&path);
    }
}
