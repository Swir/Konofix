//! Test-only diagnostics. Never compiled into installed applications.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

static NEXT_ACTOR: AtomicUsize = AtomicUsize::new(1);
const CHILD_TEST: &str = "KONOFIX_KNP_CHILD_TEST";

// Keep per-process phase traces even when the Cargo harness itself is terminated.
// A fresh UUID file is created once; no previous attempt is replaced.
fn record_phase(line: String) {
    static LOG: OnceLock<Mutex<File>> = OnceLock::new();
    let log = LOG.get_or_init(|| {
        let root = std::env::var_os("KONOFIX_KNP_DIAGNOSTICS")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("konofix-knp-diagnostics"));
        std::fs::create_dir_all(&root).expect("create phase trace directory");
        let path = root.join(format!(
            "phases-{}-{}.log",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        Mutex::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .expect("reserve phase trace"),
        )
    });
    // Never hold this lock across stderr, another lock or an await.
    writeln!(log.lock().expect("phase trace lock"), "{line}").expect("write phase trace");
    eprintln!("{line}");
}

pub(crate) struct Trace {
    id: usize,
    kind: &'static str,
    phase: &'static str,
    started: Instant,
}

impl Trace {
    pub(crate) fn new(kind: &'static str) -> Self {
        let mut trace = Self {
            id: NEXT_ACTOR.fetch_add(1, Ordering::Relaxed),
            kind,
            phase: "created",
            started: Instant::now(),
        };
        trace.at("created");
        trace
    }

    pub(crate) fn at(&mut self, phase: &'static str) {
        self.phase = phase;
        record_phase(format!(
            "KNP pid={} actor={} kind={} elapsed_ms={} phase={phase}",
            std::process::id(),
            self.id,
            self.kind,
            self.started.elapsed().as_millis()
        ));
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        record_phase(format!(
            "KNP pid={} actor={} kind={} dropped_from={}",
            std::process::id(),
            self.id,
            self.kind,
            self.phase
        ));
    }
}

struct Outcome {
    status: ExitStatus,
    timed_out: bool,
    completed: bool,
    log: PathBuf,
}

impl Outcome {
    fn passed(&self) -> bool {
        !self.timed_out && self.status.success() && self.completed
    }

    fn tail(&self) -> String {
        log_tail(&self.log)
    }
}

fn log_tail(path: &std::path::Path) -> String {
    let mut file = File::open(path).expect("open child diagnostic log");
    let len = file.metadata().unwrap().len();
    file.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)))
        .unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn run_child(test: &str, limit: Duration, fixture: Option<&str>) -> Outcome {
    let root = std::env::var_os("KONOFIX_KNP_DIAGNOSTICS")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("konofix-knp-diagnostics"));
    std::fs::create_dir_all(&root).expect("create diagnostics directory");
    let nonce = uuid::Uuid::new_v4();
    let log = root.join(format!("knp-{}-{nonce}.log", std::process::id()));
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&log)
        .expect("reserve diagnostic log without replacing evidence");
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(CHILD_TEST, test)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output));
    if let Some(mode) = fixture {
        command.env("KONOFIX_KNP_WATCHDOG_FIXTURE", mode);
    }
    let start_record = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(format!("knp-{}-{nonce}.start.json", std::process::id())))
        .expect("reserve start record");
    serde_json::to_writer_pretty(
        start_record,
        &serde_json::json!({
            "schema": 1,
            "test": test,
            "fixture": fixture,
            "limit_ms": limit.as_millis(),
            "status": "STARTED",
        }),
    )
    .expect("write start record");
    let started = Instant::now();
    let mut child = command.spawn().expect("spawn supervised test process");
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().expect("poll supervised process") {
            break (status, false);
        }
        if started.elapsed() >= limit {
            // This parent has no Tokio runtime. Kill also covers a child stuck
            // in runtime destruction, synchronous IO, or the stderr lock.
            if let Err(error) = child.kill() {
                assert!(
                    child.try_wait().unwrap().is_some(),
                    "unable to terminate timed-out test process: {error}"
                );
            }
            break (child.wait().expect("reap timed-out test process"), true);
        }
        thread::sleep(Duration::from_millis(25));
    };
    let completed = log_tail(&log).contains(&format!("KNP supervised body completed: {test}"));
    // A separate create-new record survives even if the child cannot log.
    let result = root.join(format!("knp-{}-{nonce}.result.json", std::process::id()));
    let record = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(result)
        .expect("reserve watchdog result");
    serde_json::to_writer_pretty(
        record,
        &serde_json::json!({
            "schema": 1,
            "test": test,
            "fixture": fixture,
            "elapsed_ms": started.elapsed().as_millis(),
            "limit_ms": limit.as_millis(),
            "timed_out": timed_out,
            "exit_code": status.code(),
            "body_completed": completed,
            "success": !timed_out && status.success() && completed,
            "log": log.file_name().unwrap().to_string_lossy(),
        }),
    )
    .expect("write watchdog result");
    Outcome {
        status,
        timed_out,
        completed,
        log,
    }
}

/// Re-exec the exact test so the parent's deadline covers every child destructor.
/// A child panic or deadline is always a failure, never a successful retry.
pub(crate) fn supervised(test: &str, limit: Duration, body: impl FnOnce()) {
    if std::env::var(CHILD_TEST).as_deref() == Ok(test) {
        body();
        eprintln!("KNP supervised body completed: {test}");
        return;
    }
    let outcome = run_child(test, limit, None);
    eprintln!("KNP supervised test={test} log={}", outcome.log.display());
    eprintln!("{}", outcome.tail());
    assert!(
        outcome.passed(),
        "KNP supervised test failed: timeout={} status={}",
        outcome.timed_out,
        outcome.status
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "kononexus_transport::lifecycle_diagnostics::tests::watchdog_fixture";

    #[test]
    fn watchdog_fixture() {
        if std::env::var(CHILD_TEST).as_deref() != Ok(FIXTURE) {
            return;
        }
        match std::env::var("KONOFIX_KNP_WATCHDOG_FIXTURE")
            .unwrap()
            .as_str()
        {
            "success" => {
                eprintln!("watchdog fixture completed");
                eprintln!("KNP supervised body completed: {FIXTURE}");
            }
            "panic" => panic!("watchdog fixture deliberate failure"),
            "stall" => {
                eprintln!("watchdog fixture deliberately stalled outside Tokio");
                thread::sleep(Duration::from_secs(60));
                panic!("watchdog did not terminate fixture");
            }
            _ => panic!("unknown watchdog fixture"),
        }
    }

    #[test]
    fn watchdog_rejects_stalls_and_panics_and_preserves_distinct_evidence() {
        let success = run_child(FIXTURE, Duration::from_secs(10), Some("success"));
        assert!(success.passed(), "{}", success.tail());
        let absent = run_child("no_such_knp_test", Duration::from_secs(10), None);
        assert!(!absent.passed() && !absent.timed_out);
        let panic = run_child(FIXTURE, Duration::from_secs(10), Some("panic"));
        assert!(!panic.passed() && !panic.timed_out);
        assert!(panic.tail().contains("watchdog fixture deliberate failure"));
        let stalled = run_child(FIXTURE, Duration::from_secs(10), Some("stall"));
        assert!(stalled.timed_out && !stalled.passed());
        assert!(stalled
            .tail()
            .contains("deliberately stalled outside Tokio"));
        assert_ne!(success.log, panic.log);
        assert_ne!(panic.log, stalled.log);
        assert!(success.tail().contains("watchdog fixture completed"));
    }
}
