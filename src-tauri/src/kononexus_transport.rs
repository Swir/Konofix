use kononexus::{InviteCode, KonofixSdkConfig, KonofixTransport, RelayAppEvent};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const KNP_EVENT_CAPACITY: usize = 128;

enum RuntimeCommand {
    Connect {
        expected_node_id: String,
        endpoints: Vec<SocketAddr>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ConnectInvite {
        invite_code: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Send {
        peer_node_id: String,
        data: Vec<u8>,
        reply: oneshot::Sender<Result<u64, String>>,
    },
    AuthenticatedPeerCount {
        reply: oneshot::Sender<usize>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
pub(crate) struct KonoNexusRuntime {
    node_id: String,
    local_addr: SocketAddr,
    command_tx: mpsc::Sender<RuntimeCommand>,
}

fn state_paths(root: &Path) -> (PathBuf, PathBuf) {
    (root.join("identity.key"), root.join("routing-cache.json"))
}

fn default_state_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|base| base.join("Konofix Chat").join("KonoNexus"))
        .ok_or_else(|| "Unable to resolve local application-data directory for KonoNexus.".into())
}

impl KonoNexusRuntime {
    pub(crate) async fn spawn_default(
        app: tauri::AppHandle,
    ) -> Result<(Self, String, String), String> {
        let root = default_state_root()?;
        let (identity_path, routing_cache_path) = state_paths(&root);
        let config = KonofixSdkConfig::new(identity_path)
            .with_bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))
            .with_routing_cache(routing_cache_path)
            .with_hello_interval(Duration::from_secs(2))
            .with_event_capacity(KNP_EVENT_CAPACITY);
        let (runtime, mut events) = Self::spawn(config).await?;
        let node_id = runtime.node_id().to_owned();
        let local_addr = runtime.local_addr().to_string();

        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            while let Some(event) = events.recv().await {
                let (name, payload) = match event {
                    RelayAppEvent::Message(message) => (
                        "kononexus-message",
                        serde_json::json!({
                            "peer_node_id": message.peer_node_id,
                            "message_id": message.message_id,
                            "data": message.data,
                        }),
                    ),
                    RelayAppEvent::Delivered(receipt) => (
                        "kononexus-delivery",
                        serde_json::json!({
                            "peer_node_id": receipt.peer_node_id,
                            "message_id": receipt.message_id,
                        }),
                    ),
                    RelayAppEvent::Failed(failure) => (
                        "kononexus-delivery-failure",
                        serde_json::json!({
                            "peer_node_id": failure.peer_node_id,
                            "message_id": failure.message_id,
                            "reason": format!("{:?}", failure.reason),
                        }),
                    ),
                };
                let _ = app.emit(name, payload);
            }
        });

        Ok((runtime, node_id, local_addr))
    }

    pub(crate) async fn spawn(
        config: KonofixSdkConfig,
    ) -> Result<(Self, mpsc::Receiver<RelayAppEvent>), String> {
        let transport = KonofixTransport::spawn(config)
            .await
            .map_err(|error| format!("KonoNexus transport startup failed: {error:#}"))?;
        let node_id = transport.node_id().to_owned();
        let local_addr = transport.local_addr();
        let (command_tx, command_rx) = mpsc::channel(KNP_EVENT_CAPACITY);
        let (event_tx, event_rx) = mpsc::channel(KNP_EVENT_CAPACITY);
        tokio::spawn(run_transport(transport, command_rx, event_tx));

        Ok((
            Self {
                node_id,
                local_addr,
                command_tx,
            },
            event_rx,
        ))
    }

    pub(crate) fn node_id(&self) -> &str {
        &self.node_id
    }

    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub(crate) async fn connect(
        &self,
        expected_node_id: String,
        endpoints: Vec<SocketAddr>,
    ) -> Result<(), String> {
        if endpoints.is_empty() || endpoints.len() > 8 {
            return Err("KonoNexus connect requires between one and eight exact endpoints.".into());
        }
        let (reply, response) = oneshot::channel();
        self.command_tx
            .send(RuntimeCommand::Connect {
                expected_node_id,
                endpoints,
                reply,
            })
            .await
            .map_err(|_| "KonoNexus runtime is closed.".to_string())?;
        response
            .await
            .map_err(|_| "KonoNexus connect response was interrupted.".to_string())?
    }

    pub(crate) async fn connect_invite(&self, invite_code: String) -> Result<(), String> {
        let (reply, response) = oneshot::channel();
        self.command_tx
            .send(RuntimeCommand::ConnectInvite { invite_code, reply })
            .await
            .map_err(|_| "KonoNexus runtime is closed.".to_string())?;
        response
            .await
            .map_err(|_| "KonoNexus invite connect response was interrupted.".to_string())?
    }

    pub(crate) async fn send(&self, peer_node_id: String, data: Vec<u8>) -> Result<u64, String> {
        let (reply, response) = oneshot::channel();
        self.command_tx
            .send(RuntimeCommand::Send {
                peer_node_id,
                data,
                reply,
            })
            .await
            .map_err(|_| "KonoNexus runtime is closed.".to_string())?;
        response
            .await
            .map_err(|_| "KonoNexus send response was interrupted.".to_string())?
    }

    pub(crate) async fn authenticated_peer_count(&self) -> Result<usize, String> {
        let (reply, response) = oneshot::channel();
        self.command_tx
            .send(RuntimeCommand::AuthenticatedPeerCount { reply })
            .await
            .map_err(|_| "KonoNexus runtime is closed.".to_string())?;
        response
            .await
            .map_err(|_| "KonoNexus diagnostics response was interrupted.".to_string())
    }

    pub(crate) async fn shutdown(self) {
        let (reply, response) = oneshot::channel();
        if self
            .command_tx
            .send(RuntimeCommand::Shutdown { reply })
            .await
            .is_ok()
        {
            let _ = response.await;
        }
    }
}

async fn run_transport(
    mut transport: KonofixTransport,
    mut commands: mpsc::Receiver<RuntimeCommand>,
    events: mpsc::Sender<RelayAppEvent>,
) {
    enum Wake {
        Event(Option<RelayAppEvent>),
        Command(Option<RuntimeCommand>),
    }

    let mut shutdown_reply = None;
    loop {
        let wake = tokio::select! {
            event = transport.next_event() => Wake::Event(event),
            command = commands.recv() => Wake::Command(command),
        };
        match wake {
            Wake::Event(event) => match event {
                Some(event) => {
                    if events.send(event).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            Wake::Command(command) => match command {
                Some(RuntimeCommand::Connect {
                    expected_node_id,
                    endpoints,
                    reply,
                }) => {
                    let result = transport
                        .connect(expected_node_id, endpoints)
                        .await
                        .map_err(|error| format!("KonoNexus connect failed: {error:#}"));
                    let _ = reply.send(result);
                }
                Some(RuntimeCommand::ConnectInvite { invite_code, reply }) => {
                    let result = InviteCode::decode(&invite_code)
                        .map_err(|error| format!("KonoNexus invite is invalid: {error:#}"))
                        .and_then(|invite| {
                            let endpoints = invite.socket_endpoints();
                            if endpoints.is_empty() {
                                Err("KonoNexus invite has no usable endpoints.".into())
                            } else {
                                Ok((invite.node_id, endpoints))
                            }
                        });
                    let result = match result {
                        Ok((node_id, endpoints)) => transport
                            .connect(node_id, endpoints)
                            .await
                            .map_err(|error| format!("KonoNexus invite connect failed: {error:#}")),
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                }
                Some(RuntimeCommand::Send {
                    peer_node_id,
                    data,
                    reply,
                }) => {
                    let result = transport
                        .send(peer_node_id, data)
                        .await
                        .map_err(|error| format!("KonoNexus application send failed: {error:#}"));
                    let _ = reply.send(result);
                }
                Some(RuntimeCommand::AuthenticatedPeerCount { reply }) => {
                    let _ = reply.send(transport.diagnostics().authenticated_peers);
                }
                Some(RuntimeCommand::Shutdown { reply }) => {
                    shutdown_reply = Some(reply);
                    break;
                }
                None => break,
            },
        }
    }
    transport.shutdown().await;
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(());
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
