//! Passive test-only sampling: no file/stderr lock on the async test thread.
use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const PHASES: &[&str] = &[
    "create state",
    "spawn Alice",
    "spawn Bob",
    "snapshot Alice",
    "snapshot Bob",
    "admit Bob",
    "admit Alice",
    "send Alice",
    "receive Alice",
    "acknowledge Alice",
    "send Bob",
    "acknowledge Bob",
    "stop Alice",
    "reject stale handle",
    "rebind Alice socket",
    "restart Alice",
    "snapshot restarted Alice",
    "readmit Bob",
    "readmit Alice",
    "send restarted Alice",
    "acknowledge restarted Alice",
    "stop restarted Alice",
    "stop Bob",
    "body complete; destructors pending",
];

struct State {
    phase: AtomicUsize,
    done: AtomicBool,
}

pub(super) struct Probe {
    observer: Option<(Arc<State>, JoinHandle<()>)>,
}

impl Probe {
    pub(super) fn new() -> Self {
        let Some(root) = std::env::var_os("KONOFIX_KNP_DIAGNOSTICS") else {
            return Self { observer: None };
        };
        let root = PathBuf::from(root);
        std::fs::create_dir_all(&root).expect("create restart probe directory");
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join(format!(
                "restart-{}-{}.log",
                std::process::id(),
                uuid::Uuid::new_v4()
            )))
            .expect("reserve independent restart probe evidence");
        let state = Arc::new(State {
            phase: AtomicUsize::new(0),
            done: AtomicBool::new(false),
        });
        let sampled = state.clone();
        let observer = thread::spawn(move || {
            let started = Instant::now();
            loop {
                let phase = sampled.phase.load(Ordering::Relaxed);
                let done = sampled.done.load(Ordering::Acquire);
                writeln!(
                    output,
                    "elapsed_ms={} phase={} observer_done={done}",
                    started.elapsed().as_millis(),
                    PHASES[phase]
                )
                .expect("write restart probe sample");
                if done {
                    break;
                }
                thread::park_timeout(Duration::from_secs(1));
            }
        });
        Self {
            observer: Some((state, observer)),
        }
    }

    pub(super) fn at(&self, phase: &str) {
        if let Some((state, _)) = &self.observer {
            let index = PHASES
                .iter()
                .position(|name| *name == phase)
                .expect("known static restart phase");
            state.phase.store(index, Ordering::Relaxed);
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if let Some((state, observer)) = self.observer.take() {
            state.done.store(true, Ordering::Release);
            observer.thread().unpark();
            observer.join().expect("restart observer must finish");
        }
    }
}
