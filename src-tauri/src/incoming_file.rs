use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use tokio::fs::{self, File, OpenOptions};

use super::safe_filename;

const MAX_RESERVATION_ATTEMPTS: u32 = 10_000;

#[derive(Debug)]
pub(crate) struct IncomingFileReservation {
    pub(crate) file: File,
    pub(crate) final_path: PathBuf,
    pub(crate) temp_path: PathBuf,
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
    let safe = safe_filename(file_name);

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

pub(crate) async fn commit_reserved_file(
    temp_path: &Path,
    final_path: &Path,
) -> Result<(), String> {
    match fs::hard_link(temp_path, final_path).await {
        Ok(()) => {
            remove_owned_temp(temp_path).await;
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            remove_owned_temp(temp_path).await;
            Err(format!(
                "Docelowy plik {} pojawił się podczas transferu; istniejący plik nie został nadpisany.",
                final_path.display()
            ))
        }
        Err(error) => {
            remove_owned_temp(temp_path).await;
            Err(format!(
                "Nie można atomowo sfinalizować pliku {} bez ryzyka nadpisania: {error}",
                final_path.display()
            ))
        }
    }
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
}
