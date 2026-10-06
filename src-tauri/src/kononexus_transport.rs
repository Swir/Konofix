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
    #[cfg(windows)]
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
    enum Wake<'a> {
        Event(Option<(mpsc::Permit<'a, RelayAppEvent>, Option<RelayAppEvent>)>),
        Command(Option<RuntimeCommand>),
        ConsumerClosed,
    }

    let mut shutdown_reply = None;
    loop {
        let wake = tokio::select! {
            // Reserve output space before receiving an SDK event. Both waits are
            // cancellation-safe: control commands remain available under backpressure,
            // and an event is never dequeued without space to forward it immediately.
            event = async {
                let permit = events.reserve().await.ok()?;
                Some((permit, transport.next_event().await))
            } => Wake::Event(event),
            command = commands.recv() => Wake::Command(command),
            _ = events.closed() => Wake::ConsumerClosed,
        };
        match wake {
            Wake::Event(event) => match event {
                Some((permit, Some(event))) => {
                    permit.send(event);
                }
                None | Some((_, None)) => break,
            },
            Wake::ConsumerClosed => break,
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
    use tokio::{task::JoinHandle, time};

    #[test]
    fn identity_and_routing_cache_stay_in_one_kononexus_state_root() {
        let root = PathBuf::from("state").join("konofix-knp");
        let (identity, routing) = state_paths(&root);
        assert_eq!(identity, root.join("identity.key"));
        assert_eq!(routing, root.join("routing-cache.json"));
    }

    struct TestState(PathBuf);

    impl TestState {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("konofix-knp-flow-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TestState {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn test_runtime(
        root: &Path,
        name: &str,
        bridge_start: Option<oneshot::Receiver<()>>,
    ) -> (
        KonoNexusRuntime,
        mpsc::Receiver<RelayAppEvent>,
        JoinHandle<()>,
    ) {
        let config = KonofixSdkConfig::new(root.join(format!("{name}.key")))
            .with_bind("127.0.0.1:0".parse().unwrap())
            .with_routing_cache(root.join(format!("{name}-routing.json")))
            .with_local_test_mode(true)
            .with_hello_interval(Duration::from_millis(100));
        let transport = KonofixTransport::spawn(config).await.unwrap();
        let (command_tx, command_rx) = mpsc::channel(8);
        // A one-event output queue makes backpressure reachable with three real messages.
        let (event_tx, event_rx) = mpsc::channel(1);
        let runtime = KonoNexusRuntime {
            node_id: transport.node_id().to_owned(),
            local_addr: transport.local_addr(),
            command_tx,
        };
        let task = tokio::spawn(async move {
            if let Some(start) = bridge_start {
                start.await.expect("test must release the bridge gate");
            }
            run_transport(transport, command_rx, event_tx).await;
        });
        (runtime, event_rx, task)
    }

    async fn send_and_wait_for_receipt(
        runtime: &KonoNexusRuntime,
        events: &mut mpsc::Receiver<RelayAppEvent>,
        peer: &str,
        payload: Vec<u8>,
    ) {
        time::timeout(Duration::from_secs(15), async {
            let id = runtime.send(peer.to_owned(), payload).await.unwrap();
            match events.recv().await.expect("receipt stream is open") {
                RelayAppEvent::Delivered(receipt) => {
                    assert_eq!(receipt.message_id, id);
                    assert_eq!(receipt.peer_node_id, peer);
                }
                other => panic!("expected an authenticated receipt, got {other:?}"),
            }
        })
        .await
        .expect("local KNP delivery must finish");
    }

    async fn wait_for_full_output(events: &mpsc::Receiver<RelayAppEvent>) {
        time::timeout(Duration::from_secs(3), async {
            while events.is_empty() {
                time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the real message must reach the bridge output without draining it");
        assert_eq!(events.len(), 1, "the output queue must actually be full");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn event_backpressure_preserves_control_delivery_order_and_shutdown() {
        let root = TestState::new();
        let (a, mut a_events, a_task) = test_runtime(&root.0, "a", None).await;
        let (release_bridge, bridge_start) = oneshot::channel();
        let (b, mut b_events, b_task) = test_runtime(&root.0, "b", Some(bridge_start)).await;
        a.connect(b.node_id().to_owned(), vec![b.local_addr()])
            .await
            .unwrap();

        for n in 0..3 {
            send_and_wait_for_receipt(&a, &mut a_events, b.node_id(), vec![n]).await;
        }
        // SDK receipts can arrive before the receiver's forwarding task runs.
        // Hold that task deliberately: all three receipts must precede its output.
        assert_eq!(b_events.len(), 0, "the bridge is still behind the test gate");
        release_bridge.send(()).unwrap();
        wait_for_full_output(&b_events).await;
        // Commands must work while the output queue remains full; they must not
        // discard a message or require the frontend to resume consuming first.
        time::timeout(Duration::from_secs(3), async {
            for _ in 0..10 {
                let _ = b.authenticated_peer_count().await.unwrap();
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("diagnostics must remain responsive under event backpressure");

        time::timeout(Duration::from_secs(3), async {
            for n in 0..3 {
                match b_events.recv().await.expect("message stream is open") {
                    RelayAppEvent::Message(message) => {
                        assert_eq!(message.peer_node_id, a.node_id());
                        assert_eq!(message.data, vec![n]);
                    }
                    other => panic!("expected ordered message, got {other:?}"),
                }
            }
        })
        .await
        .expect("all accepted messages must remain available in order");

        // Fill the queue again and close without consuming any more events.
        for n in 3..6 {
            send_and_wait_for_receipt(&a, &mut a_events, b.node_id(), vec![n]).await;
        }
        wait_for_full_output(&b_events).await;
        let b_addr = b.local_addr();
        time::timeout(Duration::from_secs(3), b.shutdown())
            .await
            .expect("shutdown must not wait for the frontend to drain events");
        b_task.await.unwrap();
        let _released_socket = tokio::net::UdpSocket::bind(b_addr).await.unwrap();
        time::timeout(Duration::from_secs(3), a.shutdown())
            .await
            .unwrap();
        a_task.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn idle_runtime_stops_when_event_consumer_is_dropped() {
        let root = TestState::new();
        let (runtime, events, task) = test_runtime(&root.0, "idle", None).await;
        let addr = runtime.local_addr();
        drop(events);
        time::timeout(Duration::from_secs(3), task)
            .await
            .expect("a closed frontend must release even an idle runtime")
            .unwrap();
        assert!(runtime.authenticated_peer_count().await.is_err());
        let _released_socket = tokio::net::UdpSocket::bind(addr).await.unwrap();
    }
}
