use kononexus::{KonofixSdkConfig, KonofixTransport, RelayAppEvent};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

const KNP_EVENT_CAPACITY: usize = 128;

pub(crate) struct KonoNexusRuntime {
    transport: KonofixTransport,
}

fn state_paths(root: &Path) -> (PathBuf, PathBuf) {
    (root.join("identity.key"), root.join("routing-cache.json"))
}

fn default_state_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|base| base.join("Konofix Chat").join("KonoNexus"))
        .ok_or_else(|| {
            "Unable to resolve local application-data directory for KonoNexus.".to_string()
        })
}

impl KonoNexusRuntime {
    pub(crate) async fn spawn(seed_peers: Vec<SocketAddr>) -> Result<Self, String> {
        let root = default_state_root()?;
        let (identity_path, routing_cache_path) = state_paths(&root);
        let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);

        let config = KonofixSdkConfig::new(identity_path)
            .with_bind(bind_addr)
            .with_seed_peers(seed_peers)
            .with_routing_cache(routing_cache_path)
            .with_hello_interval(Duration::from_secs(2))
            .with_event_capacity(KNP_EVENT_CAPACITY);

        let transport = KonofixTransport::spawn(config)
            .await
            .map_err(|error| format!("KonoNexus transport startup failed: {error:#}"))?;

        Ok(Self { transport })
    }

    pub(crate) fn node_id(&self) -> &str {
        self.transport.node_id()
    }

    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.transport.local_addr()
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.transport.is_finished()
    }

    pub(crate) async fn send(
        &self,
        peer_node_id: impl Into<String>,
        data: Vec<u8>,
    ) -> Result<u64, String> {
        self.transport
            .send(peer_node_id, data)
            .await
            .map_err(|error| format!("KonoNexus application send failed: {error:#}"))
    }

    pub(crate) async fn next_event(&mut self) -> Option<RelayAppEvent> {
        self.transport.next_event().await
    }

    pub(crate) async fn shutdown(self) {
        self.transport.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_and_routing_cache_stay_in_one_kononexus_state_root() {
        let root = PathBuf::from("state").join("konofix-knp");
        let (identity, routing) = state_paths(&root);
        assert_eq!(identity, root.join("identity.key"));
        assert_eq!(routing, root.join("routing-cache.json"));
    }
}

pub(crate) async fn next_event_or_pending(runtime: &mut Option<KonoNexusRuntime>) -> RelayAppEvent {
    if let Some(runtime) = runtime.as_mut() {
        if let Some(event) = runtime.next_event().await {
            return event;
        }
    }
    std::future::pending::<RelayAppEvent>().await
}
