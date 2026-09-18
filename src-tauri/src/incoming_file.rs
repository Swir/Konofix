use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncWriteExt,
};

use super::safe_filename;

const MAX_RESERVATION_ATTEMPTS: u32 = 10_000;
const MAX_SAFE_FILENAME_BYTES: usize = 180;
const MAX_PRESERVED_EXTENSION_BYTES: usize = 40;

#[derive(Debug)]
pub(crate) struct IncomingFileReservation {
    pub(crate) file: File,
    pub(crate) final_path: PathBuf,
    pub(crate) temp_path: PathBuf,
}

fn truncate_utf8_to_bytes(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }

    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn bounded_safe_filename(raw: &str) -> String {
    let safe = safe_filename(raw);
    if safe.len() <= MAX_SAFE_FILENAME_BYTES {
        return safe;
    }

    let original = Path::new(&safe);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("konofix-file");
    let extension = original.extension().and_then(|value| value.to_str());

    if let Some(extension) = extension {
        let extension_suffix = format!(".{extension}");
        if extension_suffix.len() <= MAX_PRESERVED_EXTENSION_BYTES {
            let stem_budget = MAX_SAFE_FILENAME_BYTES - extension_suffix.len();
            let bounded_stem = truncate_utf8_to_bytes(stem, stem_budget)
                .trim_end_matches(|character| character == '.' || character == ' ');
            if !bounded_stem.is_empty() {
                return format!("{bounded_stem}{extension_suffix}");
            }
        }
    }

    let bounded = truncate_utf8_to_bytes(&safe, MAX_SAFE_FILENAME_BYTES)
        .trim_end_matches(|character| character == '.' || character == ' ');
    if bounded.is_empty() {
        "konofix-file.bin".into()
    } else {
        bounded.to_string()
    }
}

fn candidate_path(dir: &Path, safe: &str, attempt: u32) -> PathBuf {
    let original = Path::new(safe);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("plik");
    let ext = original.extension().and_then(|value| value.to_str());

    let candidate_name = if attempt == 0 {
        safe.to_string()
    } else if let Some(ext) = ext {
        format!("{stem} ({attempt}).{ext}")
    } else {
        format!("{stem} ({attempt})")
    };
    dir.join(candidate_name)
}

fn temp_path_for(final_path: &Path) -> PathBuf {
    let basename = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    final_path.with_file_name(format!("{basename}.konofixpart"))
}

async fn remove_owned_temp(path: &Path) {
    let _ = fs::remove_file(path).await;
}

async fn reserve_incoming_file_with_hook<F>(
    dir: &Path,
    file_name: &str,
    max_attempts: u32,
    mut after_temp_reserved: F,
) -> Result<IncomingFileReservation, String>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let safe = bounded_safe_filename(file_name);

    for attempt in 0..max_attempts {
        let final_path = candidate_path(dir, &safe, attempt);
        let temp_path = temp_path_for(&final_path);

        let file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Nie można atomowo zarezerwować pliku tymczasowego {}: {error}",
                    temp_path.display()
                ));
            }
        };

        if let Err(error) = after_temp_reserved(&final_path, &temp_path) {
            drop(file);
            remove_owned_temp(&temp_path).await;
            return Err(format!(
                "Nie można zweryfikować rezerwacji pliku {}: {error}",
                final_path.display()
            ));
        }

        match fs::try_exists(&final_path).await {
            Ok(false) => {
                return Ok(IncomingFileReservation {
                    file,
                    final_path,
                    temp_path,
                });
            }
            Ok(true) => {
                drop(file);
                remove_owned_temp(&temp_path).await;
            }
            Err(error) => {
                drop(file);
                remove_owned_temp(&temp_path).await;
                return Err(format!(
                    "Nie można sprawdzić docelowej ścieżki {}: {error}",
                    final_path.display()
                ));
            }
        }
    }

    Err(format!(
        "Nie udało się bezpiecznie zarezerwować nazwy pliku po {max_attempts} próbach."
    ))
}

pub(crate) async fn reserve_incoming_file(
    dir: &Path,
    file_name: &str,
) -> Result<IncomingFileReservation, String> {
    reserve_incoming_file_with_hook(dir, file_name, MAX_RESERVATION_ATTEMPTS, |_, _| Ok(())).await
}

async fn commit_reserved_file_impl(
    temp_path: &Path,
    final_path: &Path,
    force_copy_fallback: bool,
) -> Result<(), String> {
    if !force_copy_fallback {
        match fs::hard_link(temp_path, final_path).await {
            Ok(()) => {
                remove_owned_temp(temp_path).await;
                return Ok(());
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                remove_owned_temp(temp_path).await;
                return Err(format!(
                    "Docelowy plik {} pojawił się podczas transferu; istniejący plik nie został nadpisany.",
                    final_path.display()
                ));
            }
            Err(_) => {
                // Some filesystems or redirected download locations do not support
                // hard-link promotion. Fall back to an exclusive copy so the final
                // destination still retains the same no-clobber guarantee.
            }
        }
    }

    let mut source = match File::open(temp_path).await {
        Ok(source) => source,
        Err(error) => {
            remove_owned_temp(temp_path).await;
            return Err(format!(
                "Nie można ponownie otworzyć zweryfikowanego pliku tymczasowego {}: {error}",
                temp_path.display()
            ));
        }
    };

    let mut destination = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(final_path)
        .await
    {
        Ok(destination) => destination,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            remove_owned_temp(temp_path).await;
            return Err(format!(
                "Docelowy plik {} pojawił się podczas transferu; istniejący plik nie został nadpisany.",
                final_path.display()
            ));
        }
        Err(error) => {
            remove_owned_temp(temp_path).await;
            return Err(format!(
                "Nie można utworzyć bezpiecznego pliku docelowego {} po nieudanej promocji hard-link: {error}",
                final_path.display()
            ));
        }
    };

    let copy_result: std::io::Result<()> = async {
        tokio::io::copy(&mut source, &mut destination).await?;
        destination.flush().await?;
        destination.sync_all().await
    }
    .await;
    drop(destination);

    if let Err(error) = copy_result {
        let _ = fs::remove_file(final_path).await;
        remove_owned_temp(temp_path).await;
        return Err(format!(
            "Nie można bezpiecznie skopiować zweryfikowanego pliku do {}: {error}",
            final_path.display()
        ));
    }

    remove_owned_temp(temp_path).await;
    Ok(())
}

pub(crate) async fn commit_reserved_file(
    temp_path: &Path,
    final_path: &Path,
) -> Result<(), String> {
    commit_reserved_file_impl(temp_path, final_path, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("konofix-file-reservation-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create reservation test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn multibyte_filename_is_byte_bounded_and_keeps_short_extension() {
        let raw = format!("{}.txt", "🚀".repeat(100));
        let bounded = bounded_safe_filename(&raw);

        assert!(bounded.len() <= MAX_SAFE_FILENAME_BYTES);
        assert!(bounded.ends_with(".txt"));
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn ordinary_safe_filename_is_not_changed_by_component_bound() {
        assert_eq!(
            bounded_safe_filename("report-final.txt"),
            "report-final.txt"
        );
    }

    #[test]
    fn worst_case_retry_and_temp_suffix_stay_below_common_component_limit() {
        let raw = format!("{}.bin", "é".repeat(200));
        let safe = bounded_safe_filename(&raw);
        let final_path = candidate_path(Path::new(""), &safe, MAX_RESERVATION_ATTEMPTS - 1);
        let temp_path = temp_path_for(&final_path);
        let final_name = final_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("utf-8 final filename");
        let temp_name = temp_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("utf-8 temp filename");

        assert!(final_name.len() < 255);
        assert!(temp_name.len() < 255);
        assert!(temp_name.ends_with(".konofixpart"));
    }

    #[tokio::test]
    async fn long_multibyte_filename_can_be_reserved() {
        let dir = TestDir::new();
        let raw = format!("{}.txt", "🚀".repeat(100));
        let reservation = reserve_incoming_file(dir.path(), &raw)
            .await
            .expect("reserve byte-bounded multibyte name");

        let final_name = reservation
            .final_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("utf-8 final name");
        let temp_name = reservation
            .temp_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("utf-8 temp name");
        assert!(final_name.len() <= MAX_SAFE_FILENAME_BYTES);
        assert!(final_name.ends_with(".txt"));
        assert!(temp_name.len() < 255);

        drop(reservation.file);
        remove_owned_temp(&reservation.temp_path).await;
    }

    #[tokio::test]
    async fn preexisting_partial_is_never_truncated() {
        let dir = TestDir::new();
        let sentinel = dir.path().join("report.txt.konofixpart");
        std::fs::write(&sentinel, b"sentinel").expect("write sentinel partial");

        let reservation = reserve_incoming_file(dir.path(), "report.txt")
            .await
            .expect("reserve alternate path");

        assert_eq!(
            std::fs::read(&sentinel).expect("read sentinel"),
            b"sentinel"
        );
        assert_eq!(
            reservation
                .final_path
                .file_name()
                .and_then(|value| value.to_str()),
            Some("report (1).txt")
        );
        assert_ne!(reservation.temp_path, sentinel);
        drop(reservation.file);
        remove_owned_temp(&reservation.temp_path).await;
    }

    #[tokio::test]
    async fn concurrent_reservations_receive_distinct_paths() {
        let dir = TestDir::new();
        let (first, second) = tokio::join!(
            reserve_incoming_file(dir.path(), "same.bin"),
            reserve_incoming_file(dir.path(), "same.bin")
        );
        let first = first.expect("first reservation");
        let second = second.expect("second reservation");

        assert_ne!(first.temp_path, second.temp_path);
        assert_ne!(first.final_path, second.final_path);
        assert!(first.temp_path.exists());
        assert!(second.temp_path.exists());

        drop(first.file);
        drop(second.file);
        remove_owned_temp(&first.temp_path).await;
        remove_owned_temp(&second.temp_path).await;
    }

    #[tokio::test]
    async fn final_path_appearing_after_temp_reservation_forces_retry() {
        let dir = TestDir::new();
        let injected = Arc::new(Mutex::new(false));
        let injected_for_hook = Arc::clone(&injected);

        let reservation =
            reserve_incoming_file_with_hook(dir.path(), "race.txt", 4, move |final_path, _| {
                let mut injected = injected_for_hook.lock().expect("lock injection flag");
                if !*injected {
                    std::fs::write(final_path, b"other-process")?;
                    *injected = true;
                }
                Ok(())
            })
            .await
            .expect("retry reservation");

        assert_eq!(
            std::fs::read(dir.path().join("race.txt")).expect("read competing final"),
            b"other-process"
        );
        assert_eq!(
            reservation
                .final_path
                .file_name()
                .and_then(|value| value.to_str()),
            Some("race (1).txt")
        );
        assert!(!dir.path().join("race.txt.konofixpart").exists());

        drop(reservation.file);
        remove_owned_temp(&reservation.temp_path).await;
    }

    #[tokio::test]
    async fn exhaustion_fails_closed_without_deleting_unowned_partial() {
        let dir = TestDir::new();
        let sentinel = dir.path().join("blocked.dat.konofixpart");
        std::fs::write(&sentinel, b"do-not-touch").expect("write occupied partial");

        let error = reserve_incoming_file_with_hook(dir.path(), "blocked.dat", 1, |_, _| Ok(()))
            .await
            .expect_err("reservation must exhaust");

        assert!(error.contains("1 próbach"));
        assert_eq!(
            std::fs::read(&sentinel).expect("read occupied partial"),
            b"do-not-touch"
        );
    }

    #[tokio::test]
    async fn commit_never_overwrites_existing_final_and_cleans_owned_temp() {
        let dir = TestDir::new();
        let final_path = dir.path().join("finished.bin");
        let temp_path = dir.path().join("finished.bin.konofixpart");
        std::fs::write(&final_path, b"existing").expect("write existing final");
        std::fs::write(&temp_path, b"incoming").expect("write owned temp");

        let error = commit_reserved_file(&temp_path, &final_path)
            .await
            .expect_err("commit must refuse overwrite");

        assert!(error.contains("nie został nadpisany"));
        assert_eq!(
            std::fs::read(&final_path).expect("read existing final"),
            b"existing"
        );
        assert!(!temp_path.exists());
    }

    #[tokio::test]
    async fn commit_promotes_temp_without_copying_or_overwriting() {
        let dir = TestDir::new();
        let final_path = dir.path().join("finished.bin");
        let temp_path = dir.path().join("finished.bin.konofixpart");
        std::fs::write(&temp_path, b"verified-payload").expect("write temp payload");

        commit_reserved_file(&temp_path, &final_path)
            .await
            .expect("commit reserved file");

        assert_eq!(
            std::fs::read(&final_path).expect("read final payload"),
            b"verified-payload"
        );
        assert!(!temp_path.exists());
    }

    #[tokio::test]
    async fn copy_fallback_promotes_verified_payload_without_overwrite() {
        let dir = TestDir::new();
        let final_path = dir.path().join("fallback.bin");
        let temp_path = dir.path().join("fallback.bin.konofixpart");
        std::fs::write(&temp_path, b"verified-copy-payload").expect("write temp payload");

        commit_reserved_file_impl(&temp_path, &final_path, true)
            .await
            .expect("exclusive copy fallback should commit");

        assert_eq!(
            std::fs::read(&final_path).expect("read copied final payload"),
            b"verified-copy-payload"
        );
        assert!(!temp_path.exists());
    }

    #[tokio::test]
    async fn copy_fallback_never_overwrites_racing_destination() {
        let dir = TestDir::new();
        let final_path = dir.path().join("fallback-race.bin");
        let temp_path = dir.path().join("fallback-race.bin.konofixpart");
        std::fs::write(&temp_path, b"incoming").expect("write temp payload");
        std::fs::write(&final_path, b"existing").expect("write existing final");

        let error = commit_reserved_file_impl(&temp_path, &final_path, true)
            .await
            .expect_err("copy fallback must refuse overwrite");

        assert!(error.contains("nie został nadpisany"));
        assert_eq!(
            std::fs::read(&final_path).expect("read existing final"),
            b"existing"
        );
        assert!(!temp_path.exists());
    }
}
