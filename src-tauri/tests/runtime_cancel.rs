//! Regression for tokio-rs/tokio#8551 / #8552 using the product lockfile.
//! This proves a dependency defect, not the cause of the historical KNP hangs.
use std::{
    future::Future,
    pin::Pin,
    process::{Command, Stdio},
    sync::Arc,
    task::{Context, Wake, Waker},
    thread,
    time::{Duration, Instant},
};
use tokio::time::Sleep;

const CHILD_MODE: &str = "KONOFIX_TIMER_CANCEL_CHILD";
const TEST_NAME: &str = "timer_cancellation_is_reentrant";
const COMPLETE_EXIT: i32 = 42;

struct CleanupOnRelease(Option<Pin<Box<Sleep>>>);

// The waker deliberately owns a timer; Waker::noop cannot exercise destruction.
#[allow(clippy::manual_noop_waker)]
impl Wake for CleanupOnRelease {
    fn wake(self: Arc<Self>) {}
}

impl Drop for CleanupOnRelease {
    fn drop(&mut self) {
        eprintln!("timer regression: nested cancellation entered");
        drop(self.0.take());
        eprintln!("timer regression: nested cancellation returned");
    }
}

fn exercise(retain_owner: bool, workers: usize) {
    let mut builder = if workers == 0 {
        tokio::runtime::Builder::new_current_thread()
    } else {
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        builder.worker_threads(workers);
        builder
    };
    let runtime = builder.enable_time().build().unwrap();
    {
        let _context = runtime.enter();
        let mut owned_timer = Box::pin(tokio::time::sleep(Duration::from_secs(60)));
        assert!(owned_timer
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        let owner = Arc::new(CleanupOnRelease(Some(owned_timer)));
        let retained = retain_owner.then(|| owner.clone());
        let wake = Waker::from(owner);
        let mut cancelled_timer = Box::pin(tokio::time::sleep(Duration::from_secs(60)));
        assert!(cancelled_timer
            .as_mut()
            .poll(&mut Context::from_waker(&wake))
            .is_pending());
        drop(wake);
        eprintln!("timer regression: cancel primary; retained={retain_owner}; workers={workers}");
        drop(cancelled_timer);
        drop(retained);
        eprintln!("timer regression: cancellation returned");
    }
    drop(runtime);
    eprintln!("timer regression: runtime cleanup returned");
}

#[test]
fn timer_cancellation_is_reentrant() {
    if let Ok(mode) = std::env::var(CHILD_MODE) {
        assert!(mode == "retained-control" || mode == "reentrant");
        for workers in [0, 4] {
            exercise(mode == "retained-control", workers);
        }
        // Distinct code proves the exact child body and runtime destructors ran.
        // A zero-test filter, panic or ordinary exit cannot pass the parent.
        std::process::exit(COMPLETE_EXIT);
    }
    for mode in ["retained-control", "reentrant"] {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD_MODE, mode)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(
                    status.code(),
                    Some(COMPLETE_EXIT),
                    "timer cancellation child did not complete: {mode}"
                );
                break;
            }
            if started.elapsed() >= Duration::from_secs(10) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("timer cancellation deadlock: {mode}; OS deadline 10 seconds");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
