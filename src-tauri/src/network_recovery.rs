//! Coalesce interface address churn without resetting identity or sessions.
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(500);
const MIN_INTERVAL: Duration = Duration::from_secs(5);

pub(crate) struct NetworkRecovery {
    due: Option<Instant>,
    next_allowed: Instant,
    generation: u64,
}

impl NetworkRecovery {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            due: None,
            next_allowed: now,
            generation: 0,
        }
    }

    pub(crate) fn request(&mut self, now: Instant) {
        let proposed = (now + DEBOUNCE).max(self.next_allowed);
        self.due = Some(self.due.map_or(proposed, |due| due.min(proposed)));
    }

    pub(crate) fn take_due(&mut self, now: Instant) -> Option<u64> {
        if self.due.is_none_or(|due| now < due) {
            return None;
        }
        self.due = None;
        self.next_allowed = now + MIN_INTERVAL;
        self.generation = self.generation.saturating_add(1);
        Some(self.generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_churn_is_debounced_bounded_and_does_not_starve_recovery() {
        let now = Instant::now();
        let mut recovery = NetworkRecovery::new(now);
        assert_eq!(recovery.take_due(now), None);
        recovery.request(now);
        for ms in 1..500 {
            recovery.request(now + Duration::from_millis(ms));
        }
        assert_eq!(recovery.take_due(now + Duration::from_millis(499)), None);
        assert_eq!(recovery.take_due(now + DEBOUNCE), Some(1));
        assert_eq!(recovery.take_due(now + DEBOUNCE), None);
        recovery.request(now + Duration::from_secs(1));
        assert_eq!(recovery.take_due(now + Duration::from_secs(5)), None);
        assert_eq!(recovery.take_due(now + DEBOUNCE + MIN_INTERVAL), Some(2));
        assert_eq!(recovery.take_due(now + Duration::from_secs(60)), None);
    }
}
