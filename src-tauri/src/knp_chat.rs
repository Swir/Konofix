//! Bounded, direct-contact chat over KNP only. No libp2p types or fallback.
use crate::kononexus_transport::KonoNexusRuntime;
use kononexus::{KonofixSdkConfig, RelayAppEvent};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::File,
    net::SocketAddr,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const MAX_CONTACTS: usize = 16;
const MAX_HISTORY: usize = 512;
const MAX_PENDING: usize = 64;
const MAX_SEEN: usize = 1024;
const MAX_WIRE_BYTES: usize = 32 * 1024;
const ACK_WAIT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    body: Body,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Body {
    Message { id: String, text: String },
    Ack { id: String },
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Contact {
    pub node_id: String,
    pub endpoint: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Delivery {
    Incoming,
    Queued,
    TransportDelivered,
    Received,
    Unconfirmed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatMessage {
    pub id: String,
    pub peer_node_id: String,
    pub outgoing: bool,
    pub text: String,
    pub timestamp: u64,
    pub delivery: Delivery,
    // u64 transport IDs must never cross IPC as JavaScript numbers.
    pub transport_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Snapshot {
    pub session_id: String,
    pub node_id: String,
    pub local_addr: String,
    pub nick: String,
    pub revision: u64,
    pub contacts: Vec<Contact>,
    pub messages: VecDeque<ChatMessage>,
}

enum Command {
    Contact(Contact, oneshot::Sender<Result<(), String>>),
    Send(String, String, oneshot::Sender<Result<String, String>>),
    Snapshot(oneshot::Sender<Snapshot>),
    Stop(oneshot::Sender<()>),
}

#[derive(Clone)]
pub(crate) struct KnpChat {
    pub session_id: String,
    commands: mpsc::Sender<Command>,
}

fn valid_node_id(value: &str) -> bool {
    value.len() == 44
        && value.starts_with("knp1")
        && value[4..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

fn decode(data: &[u8]) -> Option<Body> {
    if data.len() > MAX_WIRE_BYTES {
        return None;
    }
    let envelope: Envelope = serde_json::from_slice(data).ok()?;
    if envelope.version != 1 {
        return None;
    }
    let id = match &envelope.body {
        Body::Message { id, text } if valid_text(text, 4000) => id,
        Body::Ack { id } => id,
        _ => return None,
    };
    if Uuid::parse_str(id).ok()?.to_string() != *id {
        return None;
    }
    Some(envelope.body)
}

fn encode(body: Body) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&Envelope { version: 1, body }).map_err(|e| e.to_string())
}

impl KnpChat {
    pub(crate) async fn spawn(
        config: KonofixSdkConfig,
        nick: String,
        profile_lock: Option<File>,
    ) -> Result<Self, String> {
        if !valid_text(&nick, 24) || nick.chars().any(char::is_control) {
            return Err("Nickname must contain 1 to 24 visible characters.".into());
        }
        let (runtime, events) = KonoNexusRuntime::spawn(config).await?;
        let snapshot = Snapshot {
            session_id: Uuid::new_v4().to_string(),
            node_id: runtime.node_id().into(),
            local_addr: runtime.local_addr().to_string(),
            nick,
            revision: 0,
            contacts: Vec::new(),
            messages: VecDeque::new(),
        };
        let (commands, receiver) = mpsc::channel(64);
        let handle = Self {
            session_id: snapshot.session_id.clone(),
            commands,
        };
        tokio::spawn(run(runtime, events, receiver, snapshot, profile_lock));
        Ok(handle)
    }

    pub(crate) async fn snapshot(&self) -> Result<Snapshot, String> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Snapshot(tx))
            .await
            .map_err(|_| "Chat session closed.")?;
        rx.await.map_err(|_| "Chat session closed.".into())
    }

    pub(crate) async fn add_contact(&self, contact: Contact) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Contact(contact, tx))
            .await
            .map_err(|_| "Chat session closed.")?;
        rx.await.map_err(|_| "Chat session closed.".to_string())?
    }

    pub(crate) async fn send(&self, peer: String, text: String) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Send(peer, text, tx))
            .await
            .map_err(|_| "Chat session closed.")?;
        rx.await.map_err(|_| "Chat session closed.".to_string())?
    }

    pub(crate) async fn shutdown(self) {
        let (tx, rx) = oneshot::channel();
        if self.commands.send(Command::Stop(tx)).await.is_ok() {
            let _ = rx.await;
        }
    }
}

struct Pending {
    peer: String,
    id: String,
    queued: Instant,
}

fn update_delivery(snapshot: &mut Snapshot, peer: &str, id: &str, delivery: Delivery) {
    if let Some(message) = snapshot
        .messages
        .iter_mut()
        .find(|m| m.outgoing && m.peer_node_id == peer && m.id == id)
    {
        // Application acceptance wins over a late transport receipt/failure.
        if message.delivery != Delivery::Received && message.delivery != delivery {
            message.delivery = delivery;
            snapshot.revision += 1;
        }
    }
}

fn append(snapshot: &mut Snapshot, message: ChatMessage) {
    if snapshot.messages.len() == MAX_HISTORY {
        snapshot.messages.pop_front();
    }
    snapshot.messages.push_back(message);
    snapshot.revision += 1;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn run(
    runtime: KonoNexusRuntime,
    mut events: mpsc::Receiver<RelayAppEvent>,
    mut commands: mpsc::Receiver<Command>,
    mut snapshot: Snapshot,
    profile_lock: Option<File>,
) {
    let mut contacts = BTreeMap::<String, Contact>::new();
    let mut pending = HashMap::<u64, Pending>::new();
    let mut seen = VecDeque::<(String, String)>::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stop_reply = None;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                None => break,
                Some(Command::Stop(reply)) => { stop_reply = Some(reply); break; }
                Some(Command::Snapshot(reply)) => {
                    snapshot.contacts = contacts.values().cloned().collect();
                    let _ = reply.send(snapshot.clone());
                }
                Some(Command::Contact(contact, reply)) => {
                    let result = async {
                        if !valid_node_id(&contact.node_id) || contact.node_id == snapshot.node_id {
                            return Err("Expected another contact's exact KNP NodeID.".into());
                        }
                        if !valid_text(&contact.label, 48) || contact.label.chars().any(char::is_control) {
                            return Err("Contact label must contain 1 to 48 visible characters.".into());
                        }
                        if !contacts.contains_key(&contact.node_id) && contacts.len() >= MAX_CONTACTS {
                            return Err("This beta supports at most 16 contacts per session.".into());
                        }
                        let endpoint: SocketAddr = contact.endpoint.parse().map_err(|_| "Expected an exact IP:port endpoint.")?;
                        runtime.connect(contact.node_id.clone(), vec![endpoint]).await?;
                        contacts.insert(contact.node_id.clone(), contact);
                        snapshot.revision += 1;
                        Ok(())
                    }.await;
                    let _ = reply.send(result);
                }
                Some(Command::Send(peer, text, reply)) => {
                    let result = async {
                        if !contacts.contains_key(&peer) { return Err("Add and verify this contact first.".into()); }
                        if !valid_text(&text, 4000) { return Err("Message must contain 1 to 4000 characters, without control codes.".into()); }
                        if pending.len() >= MAX_PENDING { return Err("Too many pending messages. Wait for delivery before sending more.".into()); }
                        let id = Uuid::new_v4().to_string();
                        let data = encode(Body::Message { id: id.clone(), text: text.clone() })?;
                        let transport_id = runtime.send(peer.clone(), data).await?;
                        // The actor cannot consume a receipt before registering this message.
                        pending.insert(transport_id, Pending { peer: peer.clone(), id: id.clone(), queued: Instant::now() });
                        append(&mut snapshot, ChatMessage {
                            id: id.clone(), peer_node_id: peer, outgoing: true, text,
                            timestamp: now_ms(), delivery: Delivery::Queued,
                            transport_id: Some(transport_id.to_string()),
                        });
                        Ok(id)
                    }.await;
                    let _ = reply.send(result);
                }
            },
            event = events.recv() => match event {
                None => break,
                Some(RelayAppEvent::Message(message)) => {
                    // Sender identity comes exclusively from KNP authentication.
                    if !contacts.contains_key(&message.peer_node_id) { continue; }
                    match decode(&message.data) {
                        Some(Body::Message { id, text }) => {
                            let key = (message.peer_node_id.clone(), id.clone());
                            if !seen.contains(&key) {
                                if seen.len() == MAX_SEEN { seen.pop_front(); }
                                seen.push_back(key);
                                append(&mut snapshot, ChatMessage {
                                    id: id.clone(), peer_node_id: message.peer_node_id.clone(), outgoing: false,
                                    text, timestamp: now_ms(), delivery: Delivery::Incoming,
                                    transport_id: Some(message.message_id.to_string()),
                                });
                            }
                            if let Ok(data) = encode(Body::Ack { id }) {
                                let _ = runtime.send(message.peer_node_id, data).await;
                            }
                        }
                        Some(Body::Ack { id }) => {
                            update_delivery(&mut snapshot, &message.peer_node_id, &id, Delivery::Received);
                            pending.retain(|_, p| p.peer != message.peer_node_id || p.id != id);
                        }
                        None => {}
                    }
                }
                Some(RelayAppEvent::Delivered(receipt)) => {
                    if let Some(p) = pending.get(&receipt.message_id).filter(|p| p.peer == receipt.peer_node_id) {
                        update_delivery(&mut snapshot, &p.peer, &p.id, Delivery::TransportDelivered);
                    }
                }
                Some(RelayAppEvent::Failed(failure)) => {
                    if pending.get(&failure.message_id).is_some_and(|p| p.peer == failure.peer_node_id) {
                        if let Some(p) = pending.remove(&failure.message_id) {
                            update_delivery(&mut snapshot, &p.peer, &p.id, Delivery::Failed);
                        }
                    }
                }
            },
            _ = tick.tick() => {
                pending.retain(|_, p| {
                    if p.queued.elapsed() < ACK_WAIT { return true; }
                    if snapshot.messages.iter().any(|m| m.outgoing && m.id == p.id && m.delivery == Delivery::Queued) {
                        update_delivery(&mut snapshot, &p.peer, &p.id, Delivery::Unconfirmed);
                    }
                    false
                });
            }
        }
    }
    runtime.shutdown().await;
    drop(profile_lock);
    if let Some(reply) = stop_reply {
        let _ = reply.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use tokio::time::{sleep, timeout};

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("konofix-chat-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn config(root: &Path, name: &str) -> KonofixSdkConfig {
        // Same policy as the installed app: local_test_mode stays false.
        KonofixSdkConfig::new(root.join(format!("{name}.key")))
            .with_bind("127.0.0.1:0".parse().unwrap())
            .with_routing_cache(root.join(format!("{name}.json")))
            .with_hello_interval(Duration::from_millis(100))
    }

    async fn add(a: &KnpChat, b: &Snapshot) {
        a.add_contact(Contact {
            node_id: b.node_id.clone(),
            endpoint: b.local_addr.clone(),
            label: b.nick.clone(),
        })
        .await
        .unwrap();
    }

    async fn wait_for(chat: &KnpChat, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
        timeout(Duration::from_secs(15), async {
            loop {
                let value = chat.snapshot().await.unwrap();
                if predicate(&value) {
                    return value;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("chat state did not converge")
    }

    #[test]
    fn protocol_rejects_unknown_versions_fields_malformed_ids_and_limits() {
        let id = Uuid::new_v4().to_string();
        let data = encode(Body::Message {
            id: id.clone(),
            text: "hello 🙂\nsecond line".into(),
        })
        .unwrap();
        assert!(matches!(decode(&data), Some(Body::Message { .. })));
        for malformed in [
            serde_json::json!({"version":2,"body":{"kind":"ack","id":id}}),
            serde_json::json!({"version":1,"body":{"kind":"ack","id":id,"sender":"forged"}}),
            serde_json::json!({"version":1,"body":{"kind":"ack","id":"not-an-id"}}),
            serde_json::json!({"version":1,"body":{"kind":"message","id":id,"text":" "}}),
            serde_json::json!({"version":1,"body":{"kind":"message","id":id,"text":"x".repeat(4001)}}),
        ] {
            assert!(decode(&serde_json::to_vec(&malformed).unwrap()).is_none());
        }
        assert!(decode(&vec![b' '; MAX_WIRE_BYTES + 1]).is_none());
        assert!(!valid_node_id("knp1../../identity.key"));
        assert!(!valid_text("\u{1b}[31m", 4000));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_chat_is_bidirectional_acknowledged_and_restarts_without_old_session() {
        let root = TestRoot::new();
        let a = KnpChat::spawn(config(&root.0, "a"), "Alice".into(), None)
            .await
            .unwrap();
        let b = KnpChat::spawn(config(&root.0, "b"), "Bob".into(), None)
            .await
            .unwrap();
        let a_info = a.snapshot().await.unwrap();
        let b_info = b.snapshot().await.unwrap();
        add(&a, &b_info).await;
        add(&b, &a_info).await;
        let id = a
            .send(
                b_info.node_id.clone(),
                "hello 🙂 <script>literal</script>".into(),
            )
            .await
            .unwrap();
        let received = wait_for(&b, |s| s.messages.iter().any(|m| m.id == id)).await;
        assert_eq!(received.messages[0].peer_node_id, a_info.node_id);
        assert!(!received.messages[0].outgoing);
        assert_eq!(
            received.messages[0].text,
            "hello 🙂 <script>literal</script>"
        );
        let confirmed = wait_for(&a, |s| {
            s.messages
                .iter()
                .any(|m| m.id == id && m.delivery == Delivery::Received)
        })
        .await;
        assert!(confirmed.messages[0]
            .transport_id
            .as_ref()
            .unwrap()
            .parse::<u64>()
            .is_ok());
        let reply = b
            .send(a_info.node_id.clone(), "reply".into())
            .await
            .unwrap();
        wait_for(&b, |s| {
            s.messages
                .iter()
                .any(|m| m.id == reply && m.delivery == Delivery::Received)
        })
        .await;
        let stale = a.clone();
        a.shutdown().await;
        assert!(stale
            .send(b_info.node_id.clone(), "stale".into())
            .await
            .is_err());
        let socket = tokio::net::UdpSocket::bind(&a_info.local_addr)
            .await
            .unwrap();
        drop(socket);
        let restarted = KnpChat::spawn(config(&root.0, "a"), "Alice".into(), None)
            .await
            .unwrap();
        let fresh = restarted.snapshot().await.unwrap();
        assert_eq!(fresh.node_id, a_info.node_id);
        assert_ne!(fresh.session_id, a_info.session_id);
        assert!(fresh.messages.is_empty() && fresh.contacts.is_empty());
        add(&restarted, &b_info).await;
        add(&b, &fresh).await;
        let after_restart = restarted
            .send(b_info.node_id.clone(), "after restart".into())
            .await
            .unwrap();
        wait_for(&restarted, |s| {
            s.messages
                .iter()
                .any(|m| m.id == after_restart && m.delivery == Delivery::Received)
        })
        .await;
        restarted.shutdown().await;
        b.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn transport_delivery_without_contact_admission_is_not_application_acceptance() {
        let root = TestRoot::new();
        let a = KnpChat::spawn(config(&root.0, "a"), "Alice".into(), None)
            .await
            .unwrap();
        let b = KnpChat::spawn(config(&root.0, "b"), "Bob".into(), None)
            .await
            .unwrap();
        let a_info = a.snapshot().await.unwrap();
        let b_info = b.snapshot().await.unwrap();
        assert!(a
            .send(b_info.node_id.clone(), "not admitted locally".into())
            .await
            .is_err());
        add(&a, &b_info).await;
        let id = a
            .send(b_info.node_id.clone(), "not admitted remotely".into())
            .await
            .unwrap();
        wait_for(&a, |s| {
            s.messages
                .iter()
                .any(|m| m.id == id && m.delivery == Delivery::TransportDelivered)
        })
        .await;
        assert!(b.snapshot().await.unwrap().messages.is_empty());
        add(&b, &a_info).await;
        let id2 = a
            .send(b_info.node_id.clone(), "now admitted".into())
            .await
            .unwrap();
        wait_for(&a, |s| {
            s.messages
                .iter()
                .any(|m| m.id == id2 && m.delivery == Delivery::Received)
        })
        .await;
        let snapshot = a.snapshot().await.unwrap();
        assert_eq!(
            snapshot
                .messages
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .delivery,
            Delivery::TransportDelivered
        );
        a.shutdown().await;
        b.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn duplicate_payload_and_wrong_peer_ack_cannot_change_accepted_message() {
        let root = TestRoot::new();
        let chat = KnpChat::spawn(config(&root.0, "chat"), "Alice".into(), None)
            .await
            .unwrap();
        let (peer, _events) = KonoNexusRuntime::spawn(config(&root.0, "peer"))
            .await
            .unwrap();
        let (other, _other_events) = KonoNexusRuntime::spawn(config(&root.0, "other"))
            .await
            .unwrap();
        let info = chat.snapshot().await.unwrap();
        for runtime in [&peer, &other] {
            chat.add_contact(Contact {
                node_id: runtime.node_id().into(),
                endpoint: runtime.local_addr().to_string(),
                label: "Contact".into(),
            })
            .await
            .unwrap();
            runtime
                .connect(info.node_id.clone(), vec![info.local_addr.parse().unwrap()])
                .await
                .unwrap();
        }
        let id = Uuid::new_v4().to_string();
        peer.send(
            info.node_id.clone(),
            encode(Body::Message {
                id: id.clone(),
                text: "original".into(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        wait_for(&chat, |s| s.messages.len() == 1).await;
        peer.send(
            info.node_id.clone(),
            encode(Body::Message {
                id: id.clone(),
                text: "replacement".into(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        let outbound = chat
            .send(peer.node_id().into(), "recipient must acknowledge".into())
            .await
            .unwrap();
        other
            .send(
                info.node_id.clone(),
                encode(Body::Ack {
                    id: outbound.clone(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        sleep(Duration::from_millis(750)).await;
        let snapshot = chat.snapshot().await.unwrap();
        assert_eq!(snapshot.messages.iter().filter(|m| !m.outgoing).count(), 1);
        assert_eq!(snapshot.messages[0].text, "original");
        assert_ne!(
            snapshot
                .messages
                .iter()
                .find(|m| m.id == outbound)
                .unwrap()
                .delivery,
            Delivery::Received
        );
        peer.send(
            info.node_id,
            encode(Body::Ack {
                id: outbound.clone(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        wait_for(&chat, |s| {
            s.messages
                .iter()
                .any(|m| m.id == outbound && m.delivery == Delivery::Received)
        })
        .await;
        chat.shutdown().await;
        peer.shutdown().await;
        other.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_last_handle_releases_socket_without_snapshot_polling() {
        let root = TestRoot::new();
        let chat = KnpChat::spawn(config(&root.0, "a"), "Alice".into(), None)
            .await
            .unwrap();
        let endpoint = chat.snapshot().await.unwrap().local_addr;
        drop(chat);
        timeout(Duration::from_secs(3), async {
            loop {
                if tokio::net::UdpSocket::bind(&endpoint).await.is_ok() {
                    break;
                }
                sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
    }
}
