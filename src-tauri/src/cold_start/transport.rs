//! Filter after DNS resolution, before a socket is opened. No LAN discovery here.
use super::public_endpoint;
use libp2p::{
    core::{
        transport::{DialOpts, ListenerId, TransportError, TransportEvent},
        Transport,
    },
    multiaddr::Protocol,
    Multiaddr, PeerId,
};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct DialBudget(Arc<Mutex<(Instant, usize)>>, Arc<Counters>);
#[derive(Default)]
struct Counters {
    dns: AtomicU64,
    resolved: AtomicU64,
    rejected: AtomicU64,
    accepted: AtomicU64,
}

impl DialBudget {
    pub fn new() -> Self {
        Self(
            Arc::new(Mutex::new((Instant::now(), 0))),
            Arc::new(Counters::default()),
        )
    }
    #[cfg(test)]
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"dns_candidates": self.1.dns.load(Ordering::Relaxed),
            "resolved_transport_candidates": self.1.resolved.load(Ordering::Relaxed),
            "policy_or_budget_rejections": self.1.rejected.load(Ordering::Relaxed),
            "accepted_transport_dials": self.1.accepted.load(Ordering::Relaxed)})
    }
    fn take(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        let now = Instant::now();
        if now.duration_since(state.0) >= Duration::from_secs(300) {
            *state = (now, 0);
        }
        if state.1 >= 64 {
            return false;
        }
        state.1 += 1;
        true
    }
}

pub struct PublicTransport<T> {
    inner: T,
    budget: DialBudget,
    seed_ingress: bool,
    #[cfg(test)]
    loopback: bool,
}
impl<T> PublicTransport<T> {
    pub fn new(inner: T, budget: DialBudget) -> Self {
        Self {
            inner,
            budget,
            seed_ingress: false,
            #[cfg(test)]
            loopback: false,
        }
    }
    pub fn seed_ingress(inner: T, budget: DialBudget) -> Self {
        Self {
            inner,
            budget,
            seed_ingress: true,
            #[cfg(test)]
            loopback: false,
        }
    }
    #[cfg(test)]
    pub fn loopback(inner: T, budget: DialBudget) -> Self {
        Self {
            inner,
            budget,
            seed_ingress: false,
            loopback: true,
        }
    }
}
fn permitted(address: &Multiaddr) -> bool {
    let mut bound = address.clone();
    let peer = match bound.iter().last() {
        Some(Protocol::P2p(peer)) => peer,
        _ => {
            let peer = PeerId::random();
            bound.push(Protocol::P2p(peer));
            peer
        }
    };
    public_endpoint(&bound.to_string(), peer).is_some() && !super::is_circuit(&bound)
}
impl<T: Transport + Unpin> Transport for PublicTransport<T> {
    type Output = T::Output;
    type Error = T::Error;
    type ListenerUpgrade = T::ListenerUpgrade;
    type Dial = T::Dial;
    fn listen_on(
        &mut self,
        id: ListenerId,
        addr: Multiaddr,
    ) -> Result<(), TransportError<Self::Error>> {
        self.inner.listen_on(id, addr)
    }
    fn remove_listener(&mut self, id: ListenerId) -> bool {
        self.inner.remove_listener(id)
    }
    fn dial(
        &mut self,
        addr: Multiaddr,
        opts: DialOpts,
    ) -> Result<Self::Dial, TransportError<Self::Error>> {
        if self.seed_ingress {
            let has_dns = addr.iter().any(|p| {
                matches!(
                    p,
                    Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_) | Protocol::Dnsaddr(_)
                )
            });
            if has_dns {
                self.budget.1.dns.fetch_add(1, Ordering::Relaxed);
            }
            if has_dns && !super::runtime::SEEDS.contains(&addr.to_string().as_str()) {
                self.budget.1.rejected.fetch_add(1, Ordering::Relaxed);
                return Err(TransportError::MultiaddrNotSupported(addr));
            }
            return self.inner.dial(addr, opts);
        }
        self.budget.1.resolved.fetch_add(1, Ordering::Relaxed);
        let allowed = permitted(&addr);
        #[cfg(test)]
        let allowed = allowed
            || (self.loopback
                && matches!(addr.iter().next(), Some(Protocol::Ip4(ip)) if ip.is_loopback()));
        if !allowed || !self.budget.take() {
            self.budget.1.rejected.fetch_add(1, Ordering::Relaxed);
            return Err(TransportError::MultiaddrNotSupported(addr));
        }
        self.budget.1.accepted.fetch_add(1, Ordering::Relaxed);
        self.inner.dial(addr, opts)
    }
    fn poll(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<TransportEvent<Self::ListenerUpgrade, Self::Error>> {
        Pin::new(&mut self.get_mut().inner).poll(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trace_counts_transport_stages_without_claiming_a_connection() {
        use libp2p::core::{
            transport::{dummy::DummyTransport, PortUse},
            Endpoint,
        };
        let budget = DialBudget::new();
        let options = || DialOpts {
            role: Endpoint::Dialer,
            port_use: PortUse::New,
        };
        let mut resolved = PublicTransport::new(DummyTransport::<()>::new(), budget.clone());
        assert!(resolved
            .dial("/ip4/127.0.0.1/tcp/1".parse().unwrap(), options())
            .is_err());
        // DummyTransport never opens a socket, including for this public literal.
        assert!(resolved
            .dial("/ip4/1.1.1.1/tcp/1".parse().unwrap(), options())
            .is_err());
        let mut ingress =
            PublicTransport::seed_ingress(DummyTransport::<()>::new(), budget.clone());
        assert!(ingress
            .dial("/dnsaddr/untrusted.invalid".parse().unwrap(), options())
            .is_err());
        assert_eq!(
            budget.snapshot(),
            serde_json::json!({
                "dns_candidates": 1, "resolved_transport_candidates": 2,
                "policy_or_budget_rejections": 2, "accepted_transport_dials": 1,
            })
        );
    }
    #[test]
    fn resolved_address_policy_blocks_rebinding_and_global_dial_flood() {
        for raw in [
            "/ip4/127.0.0.1/tcp/1",
            "/ip4/169.254.169.254/tcp/80",
            "/dns/anything.org/tcp/1",
            "/ip4/100.64.0.1/tcp/1",
        ] {
            assert!(!permitted(&raw.parse().unwrap()));
        }
        assert!(permitted(&"/ip4/1.1.1.1/tcp/4001".parse().unwrap()));
        let budget = DialBudget::new();
        let same = budget.clone();
        for _ in 0..64 {
            assert!(budget.take());
        }
        assert!(!same.take()); // actor/network resets reuse this same budget
    }
}
