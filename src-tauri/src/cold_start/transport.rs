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
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct DialBudget(Arc<Mutex<(Instant, usize)>>);
impl DialBudget {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new((Instant::now(), 0))))
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
            if has_dns && !super::runtime::SEEDS.contains(&addr.to_string().as_str()) {
                return Err(TransportError::MultiaddrNotSupported(addr));
            }
            return self.inner.dial(addr, opts);
        }
        let allowed = permitted(&addr);
        #[cfg(test)]
        let allowed = allowed
            || (self.loopback
                && matches!(addr.iter().next(), Some(Protocol::Ip4(ip)) if ip.is_loopback()));
        if !allowed || !self.budget.take() {
            return Err(TransportError::MultiaddrNotSupported(addr));
        }
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
