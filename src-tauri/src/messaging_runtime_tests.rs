use super::*;
use std::collections::VecDeque;

#[test]
fn timestamped_chat_and_nick_claim_decode_from_the_actual_wire_envelope() {
    let peer = PeerId::random();
    for event in [
        WireEvent::Chat(ChatMessage {
            id: Uuid::new_v4().to_string(),
            kind: "chat".into(),
            peer_id: Some(peer.to_string()),
            nick: "test-alice".into(),
            nick_color: Some("#62E5FF".into()),
            room: "world".into(),
            text: "Hello, \u{17c}\u{f3}\u{142}w!".into(),
            timestamp: 1_790_000_000_123,
        }),
        WireEvent::NickClaim {
            peer_id: peer.to_string(),
            nick: "test-alice".into(),
            canonical: "test-alice".into(),
            expires_at: now_ms() + 42_000,
            session_age_ms: Some(1_000),
        },
    ] {
        let encoded = serde_json::to_vec(&event).unwrap();
        let decoded: WireEvent = serde_json::from_slice(&encoded)
            .expect("timestamped events must decode through the tagged envelope");
        assert!(wire_event_matches_source(&decoded, &peer));
        assert!(wire_event_is_well_formed(&decoded));
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(event).unwrap()
        );
    }

    // Reproduce the previous receiver failure independently of network timing.
    #[derive(Deserialize)]
    #[serde(tag = "type")]
    enum LegacyEvent {
        Chat {
            #[serde(rename = "timestamp")]
            _timestamp: u128,
        },
    }
    let old = serde_json::from_str::<LegacyEvent>(r#"{"type":"Chat","timestamp":1790000000123}"#);
    assert!(
        old.is_err(),
        "the historical u128 envelope must reproduce the regression"
    );
}

#[tokio::test]
async fn binary_chunks_fit_the_production_codec_at_worst_case_encoded_size() {
    use futures::io::Cursor;
    use request_response::Codec;
    let protocol = StreamProtocol::new(FILE_PROTOCOL);
    let mut codec = file_codec();
    let mut encoded = Cursor::new(Vec::new());
    codec
        .write_request(
            &protocol,
            &mut encoded,
            FileRequest::Chunk {
                transfer_id: Uuid::new_v4().to_string(),
                offset: MAX_FILE_SIZE - FILE_CHUNK_SIZE as u64,
                data: vec![255; FILE_CHUNK_SIZE],
            },
        )
        .await
        .unwrap();
    let bytes = encoded.into_inner();
    assert!(
        bytes.len() > 320 * 1024,
        "fixture must exceed the broken old cap"
    );
    assert!(bytes.len() as u64 <= MAX_FILE_REQUEST_WIRE_BYTES);
    let old = file_codec()
        .set_request_size_maximum(320 * 1024)
        .read_request(&protocol, &mut Cursor::new(bytes.clone()))
        .await;
    assert!(
        old.is_err(),
        "the old wire limit truncates a valid binary chunk"
    );
    let decoded = codec
        .read_request(&protocol, &mut Cursor::new(bytes))
        .await
        .unwrap();
    let FileRequest::Chunk { data, .. } = decoded else {
        panic!("wrong request")
    };
    assert_eq!(data, vec![255; FILE_CHUNK_SIZE]);
    let mut response = Cursor::new(Vec::new());
    codec
        .write_response(&protocol, &mut response, FileResponse::Accepted)
        .await
        .unwrap();
    response.set_position(0);
    assert!(matches!(
        codec.read_response(&protocol, &mut response).await.unwrap(),
        FileResponse::Accepted
    ));
}

struct TestRuntime {
    events: mpsc::UnboundedSender<(String, serde_json::Value)>,
    downloads: PathBuf,
    previews: PathBuf,
}

impl NetworkRuntime for TestRuntime {
    fn emit_event<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        self.events
            .send((
                event.into(),
                serde_json::to_value(payload).map_err(|error| error.to_string())?,
            ))
            .map_err(|error| error.to_string())
    }
    fn downloads(&self) -> Result<PathBuf, String> {
        Ok(self.downloads.clone())
    }
    fn previews(&self) -> Result<PathBuf, String> {
        Ok(self.previews.clone())
    }
    fn load_peers(&self) -> PeerCacheFile {
        PeerCacheFile::default()
    }
    fn save_peers(&self, _: &PeerCacheFile) {}
}

struct TestPeer {
    id: String,
    color: String,
    commands: mpsc::Sender<NetworkCommand>,
    events: mpsc::UnboundedReceiver<(String, serde_json::Value)>,
    pending: VecDeque<(String, serde_json::Value)>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl Drop for TestPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestPeer {
    async fn start(nick: &str, bootstraps: Vec<String>, downloads: PathBuf) -> Self {
        Self::start_with_color(nick, DEFAULT_NICK_COLOR, bootstraps, downloads).await
    }

    async fn start_with_color(
        nick: &str,
        color: &str,
        bootstraps: Vec<String>,
        downloads: PathBuf,
    ) -> Self {
        let color = normalize_nick_color(Some(color));
        let previews = downloads.with_file_name(format!(
            "{}-previews",
            downloads
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("konofix")
        ));
        let (commands, rx) = mpsc::channel(128);
        let (events_tx, events) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(network_task(
            nick.into(),
            color.clone(),
            bootstraps,
            TestRuntime {
                events: events_tx,
                downloads,
                previews,
            },
            rx,
            ready_tx,
        ));
        let id = tokio::time::timeout(Duration::from_secs(15), ready_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        Self {
            id,
            color,
            commands,
            events,
            pending: VecDeque::new(),
            task,
        }
    }

    async fn event(
        &mut self,
        name: &str,
        matches: impl Fn(&serde_json::Value) -> bool,
    ) -> serde_json::Value {
        let wait = async {
            if let Some(index) = self
                .pending
                .iter()
                .position(|(kind, data)| kind == name && matches(data))
            {
                return self.pending.remove(index).unwrap().1;
            }
            loop {
                let (kind, data) = self
                    .events
                    .recv()
                    .await
                    .expect("network loop stopped before expected event");
                assert_ne!(kind, "nick-conflict");
                if kind == "file-transfer" {
                    assert_ne!(data["status"], "failed", "transfer failed: {data}");
                }
                if kind == name && matches(&data) {
                    return data;
                }
                self.pending.push_back((kind, data));
                assert!(self.pending.len() < 2000, "unexpected event flood");
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {name}"))
    }
}

fn messaging_runtime_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("konofix-messaging-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn chat(sender: &TestPeer, receiver: &mut TestPeer, room: &str, text: &str) {
    let (reply, response) = oneshot::channel();
    sender
        .commands
        .send(NetworkCommand::SendMessage {
            room: room.into(),
            text: text.into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    let message = receiver
        .event("chat-message", |value| value["text"] == text)
        .await;
    assert_eq!(message["peer_id"], sender.id);
    assert_eq!(message["nick_color"], sender.color);
    assert_eq!(message["room"], room);
    assert!(message["timestamp"].as_u64().unwrap() > 0);
}

async fn offer(sender: &TestPeer, receiver: &mut TestPeer, path: &Path, bytes: &[u8]) -> String {
    tokio::fs::write(path, bytes).await.unwrap();
    let (reply, response) = oneshot::channel();
    sender
        .commands
        .send(NetworkCommand::OfferFile {
            peer_id: receiver.id.clone(),
            path: path.into(),
            file_name: path.file_name().unwrap().to_str().unwrap().into(),
            size: bytes.len() as u64,
            room_id: None,
            reply,
        })
        .await
        .unwrap();
    let view = response.await.unwrap().unwrap();
    let incoming = receiver
        .event("file-offer", |value| {
            value["transfer_id"] == view.transfer_id
        })
        .await;
    assert_eq!(incoming["peer_id"], sender.id);
    assert_eq!(incoming["size"], bytes.len() as u64);
    view.transfer_id
}

async fn public_transfer(
    sender: &mut TestPeer,
    receiver: &mut TestPeer,
    path: &Path,
    bytes: &[u8],
    kind: &str,
    mime: Option<&str>,
    preview_only: bool,
) -> (PublicShareOffer, PathBuf) {
    tokio::fs::write(path, bytes).await.unwrap();
    let (reply, response) = oneshot::channel();
    sender
        .commands
        .send(NetworkCommand::PublishPublicOffer {
            path: path.into(),
            file_name: path.file_name().unwrap().to_str().unwrap().into(),
            size: bytes.len() as u64,
            kind: kind.into(),
            mime: mime.map(str::to_string),
            room_id: None,
            reply,
        })
        .await
        .unwrap();
    let offer = response.await.unwrap().unwrap();
    assert_eq!(offer.nick_color.as_deref(), Some(sender.color.as_str()));
    assert_eq!(offer.kind, kind);
    assert_eq!(offer.mime.as_deref(), mime);

    let announced = receiver
        .event("public-file-offer", |value| {
            value["offer_id"] == offer.offer_id
        })
        .await;
    assert_eq!(announced["peer_id"], sender.id);
    assert_eq!(announced["nick_color"], sender.color);
    assert_eq!(announced["file_name"], offer.file_name);
    assert_eq!(announced["size"], bytes.len() as u64);

    // An announcement is metadata-only: the receiver must explicitly claim it.
    assert!(!receiver
        .pending
        .iter()
        .any(|(kind, data)| kind == "file-transfer" && data["public_offer_id"] == offer.offer_id));

    let (reply, response) = oneshot::channel();
    receiver
        .commands
        .send(NetworkCommand::ClaimPublicOffer {
            offer_id: offer.offer_id.clone(),
            preview_only,
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();

    let received = receiver
        .event("file-transfer", |value| {
            value["public_offer_id"] == offer.offer_id && value["status"] == "completed"
        })
        .await;
    let sent = sender
        .event("file-transfer", |value| {
            value["public_offer_id"] == offer.offer_id && value["status"] == "completed"
        })
        .await;
    assert_eq!(sent["transferred"], bytes.len() as u64);
    assert!(sent["path"].is_null());

    assert_eq!(received["preview_only"], preview_only);
    let destination = PathBuf::from(received["path"].as_str().unwrap());
    let actual = tokio::fs::read(&destination).await.unwrap();
    assert_eq!(actual, bytes);
    assert_eq!(Sha256::digest(&actual), Sha256::digest(bytes));
    (offer, destination)
}

async fn transfer(sender: &mut TestPeer, receiver: &mut TestPeer, path: &Path, bytes: &[u8]) {
    let id = offer(sender, receiver, path, bytes).await;
    let (reply, response) = oneshot::channel();
    receiver
        .commands
        .send(NetworkCommand::AcceptFile {
            transfer_id: id.clone(),
            reply,
        })
        .await
        .unwrap();
    assert_eq!(response.await.unwrap().unwrap().status, "receiving");
    let received = receiver
        .event("file-transfer", |value| {
            value["transfer_id"] == id && value["status"] == "completed"
        })
        .await;
    let sent = sender
        .event("file-transfer", |value| {
            value["transfer_id"] == id && value["status"] == "completed"
        })
        .await;
    assert_eq!(sent["transferred"], bytes.len() as u64);
    assert!(
        sent["path"].is_null(),
        "receiver's local path must stay private"
    );
    let destination = PathBuf::from(received["path"].as_str().unwrap());
    let actual = tokio::fs::read(&destination).await.unwrap();
    assert_eq!(actual, bytes);
    assert_eq!(Sha256::digest(&actual), Sha256::digest(bytes));
    assert!(!destination
        .with_file_name(format!(
            "{}.konofixpart",
            destination.file_name().unwrap().to_str().unwrap()
        ))
        .exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_application_loops_deliver_chat_and_accepted_binary_files_both_directions() {
    let _runtime_test_guard = messaging_runtime_test_lock().lock().await;
    let files = TestDirectory::new();
    let mut alice = TestPeer::start_with_color(
        "test-alice",
        "#62E5FF",
        vec![],
        files.0.join("alice-downloads"),
    )
    .await;
    let addresses = alice
        .event("network-status", |value| {
            value["listen_addresses"].as_array().is_some_and(|list| {
                list.iter()
                    .any(|address| address.as_str().unwrap().contains("/tcp/"))
            })
        })
        .await;
    let address = addresses["listen_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|value| value.as_str().filter(|address| address.contains("/tcp/")))
        .unwrap()
        .to_string();
    let mut bob = TestPeer::start_with_color(
        "test-bob",
        "#FF8FAB",
        vec![address],
        files.0.join("bob-downloads"),
    )
    .await;
    let bob_presence = alice
        .event("peer-online", |value| value["peer_id"] == bob.id)
        .await;
    assert_eq!(bob_presence["nick_color"], bob.color);
    let alice_presence = bob
        .event("peer-online", |value| value["peer_id"] == alice.id)
        .await;
    assert_eq!(alice_presence["nick_color"], alice.color);
    chat(&alice, &mut bob, "world", "World from Alice").await;
    chat(&bob, &mut alice, "world", "World from Bob").await;

    let (reply, response) = oneshot::channel();
    alice
        .commands
        .send(NetworkCommand::CreateRoom {
            room: RoomInfo {
                id: "runtime-room".into(),
                title: "# runtime room".into(),
                owner: None,
                users: Some(1),
                password_protected: false,
                auth_revision: 0,
            },
            password: None,
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    bob.event("room-created", |value| value["id"] == "runtime-room")
        .await;
    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::EnterRoom {
            room_id: "runtime-room".into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    alice
        .event("room-user-count", |value| {
            value["room_id"] == "runtime-room" && value["users"] == 2
        })
        .await;
    chat(
        &alice,
        &mut bob,
        "runtime-room",
        "Room from Alice: \u{17c}\u{f3}\u{142}w",
    )
    .await;
    chat(&bob, &mut alice, "runtime-room", "Room from Bob").await;

    transfer(
        &mut alice,
        &mut bob,
        &files.0.join("binary-forward.bin"),
        &vec![255; FILE_CHUNK_SIZE * 2 + 97],
    )
    .await;
    let bytes: Vec<u8> = (0..3 * 1024 * 1024)
        .map(|index| (index % 256) as u8)
        .collect();
    transfer(
        &mut bob,
        &mut alice,
        &files.0.join("binary-reverse.bin"),
        &bytes,
    )
    .await;
    transfer(&mut alice, &mut bob, &files.0.join("empty.txt"), &[]).await;

    let (public_file, public_file_path) = public_transfer(
        &mut alice,
        &mut bob,
        &files.0.join("world-notes.txt"),
        b"public world file",
        "file",
        None,
        false,
    )
    .await;
    assert_eq!(public_file.kind, "file");
    assert_eq!(
        tokio::fs::read(public_file_path).await.unwrap(),
        b"public world file"
    );

    let png: Vec<u8> = [
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..],
        b"konofix-image-fixture",
    ]
    .concat();
    let (public_image, public_image_path) = public_transfer(
        &mut bob,
        &mut alice,
        &files.0.join("world-image.png"),
        &png,
        "image",
        Some("image/png"),
        true,
    )
    .await;
    assert_eq!(public_image.kind, "image");
    let image_bytes = tokio::fs::read(public_image_path).await.unwrap();
    assert_eq!(image_mime_from_header(&image_bytes), Some("image/png"));

    let id = offer(&alice, &mut bob, &files.0.join("rejected.txt"), b"declined").await;
    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::RejectFile {
            transfer_id: id.clone(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    alice
        .event("file-transfer", |value| {
            value["transfer_id"] == id && value["status"] == "rejected"
        })
        .await;
    assert!(!files.0.join("bob-downloads/rejected.txt").exists());

    alice.commands.send(NetworkCommand::Stop).await.unwrap();
    bob.commands.send(NetworkCommand::Stop).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut alice.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut bob.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protected_room_and_private_chat_use_direct_secure_control_between_apps() {
    let _runtime_test_guard = messaging_runtime_test_lock().lock().await;
    let files = TestDirectory::new();
    let mut alice = TestPeer::start_with_color(
        "secure-alice",
        "#62E5FF",
        vec![],
        files.0.join("secure-alice-downloads"),
    )
    .await;
    let addresses = alice
        .event("network-status", |value| {
            value["listen_addresses"].as_array().is_some_and(|list| {
                list.iter()
                    .any(|address| address.as_str().is_some_and(|raw| raw.contains("/tcp/")))
            })
        })
        .await;
    let address = addresses["listen_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|value| value.as_str().filter(|raw| raw.contains("/tcp/")))
        .unwrap()
        .to_string();

    let mut bob = TestPeer::start_with_color(
        "secure-bob",
        "#FF8FAB",
        vec![address],
        files.0.join("secure-bob-downloads"),
    )
    .await;
    alice
        .event("peer-online", |value| value["peer_id"] == bob.id)
        .await;
    bob.event("peer-online", |value| value["peer_id"] == alice.id)
        .await;

    let (reply, response) = oneshot::channel();
    alice
        .commands
        .send(NetworkCommand::CreateRoom {
            room: RoomInfo {
                id: "locked-runtime".into(),
                title: "# locked runtime".into(),
                owner: None,
                users: Some(1),
                password_protected: false,
                auth_revision: 0,
            },
            password: Some(SecretString::new("runtime-room-secret".to_string())),
            reply,
        })
        .await
        .unwrap();
    let created = response.await.unwrap().unwrap();
    assert!(created.password_protected);
    assert!(created.auth_revision > 0);
    let first_revision = created.auth_revision;

    bob.event("room-created", |value| {
        value["id"] == "locked-runtime"
            && value["password_protected"] == true
            && value["auth_revision"] == first_revision
    })
    .await;

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::AuthorizeRoomEntry {
            room_id: "locked-runtime".into(),
            password: SecretString::new("wrong-runtime-secret".to_string()),
            reply,
        })
        .await
        .unwrap();
    assert!(response.await.unwrap().is_err());

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::EnterRoom {
            room_id: "locked-runtime".into(),
            reply,
        })
        .await
        .unwrap();
    assert!(response.await.unwrap().is_err());

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::AuthorizeRoomEntry {
            room_id: "locked-runtime".into(),
            password: SecretString::new("runtime-room-secret".to_string()),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::EnterRoom {
            room_id: "locked-runtime".into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    alice
        .event("room-user-count", |value| {
            value["room_id"] == "locked-runtime" && value["users"] == 2
        })
        .await;
    chat(&bob, &mut alice, "locked-runtime", "Protected room message").await;

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::SendPrivateMessage {
            peer_id: alice.id.clone(),
            text: "private bob to alice :)".into(),
            reply,
        })
        .await
        .unwrap();
    let sent_to_alice = response.await.unwrap().unwrap();
    assert_eq!(sent_to_alice.peer_id, bob.id);
    assert_eq!(sent_to_alice.target_peer_id, alice.id);
    let alice_id = alice.id.clone();
    let bob_id = bob.id.clone();
    alice
        .event("private-message", |value| {
            value["peer_id"] == bob_id
                && value["target_peer_id"] == alice_id
                && value["text"] == "private bob to alice :)"
        })
        .await;

    let (reply, response) = oneshot::channel();
    alice
        .commands
        .send(NetworkCommand::SendPrivateMessage {
            peer_id: bob.id.clone(),
            text: "private alice to bob :D".into(),
            reply,
        })
        .await
        .unwrap();
    let sent_to_bob = response.await.unwrap().unwrap();
    assert_eq!(sent_to_bob.peer_id, alice.id);
    assert_eq!(sent_to_bob.target_peer_id, bob.id);
    let alice_id = alice.id.clone();
    let bob_id = bob.id.clone();
    bob.event("private-message", |value| {
        value["peer_id"] == alice_id
            && value["target_peer_id"] == bob_id
            && value["text"] == "private alice to bob :D"
    })
    .await;

    let (reply, response) = oneshot::channel();
    alice
        .commands
        .send(NetworkCommand::UpdateRoomPassword {
            room_id: "locked-runtime".into(),
            password: Some(SecretString::new("runtime-room-secret-2".to_string())),
            reply,
        })
        .await
        .unwrap();
    let updated = response.await.unwrap().unwrap();
    assert!(updated.auth_revision > first_revision);
    let second_revision = updated.auth_revision;
    bob.event("room-created", |value| {
        value["id"] == "locked-runtime"
            && value["password_protected"] == true
            && value["auth_revision"] == second_revision
    })
    .await;

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::EnterRoom {
            room_id: "locked-runtime".into(),
            reply,
        })
        .await
        .unwrap();
    assert!(response.await.unwrap().is_err());

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::AuthorizeRoomEntry {
            room_id: "locked-runtime".into(),
            password: SecretString::new("runtime-room-secret".to_string()),
            reply,
        })
        .await
        .unwrap();
    assert!(response.await.unwrap().is_err());

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::AuthorizeRoomEntry {
            room_id: "locked-runtime".into(),
            password: SecretString::new("runtime-room-secret-2".to_string()),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();

    let (reply, response) = oneshot::channel();
    bob.commands
        .send(NetworkCommand::EnterRoom {
            room_id: "locked-runtime".into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();

    alice.commands.send(NetworkCommand::Stop).await.unwrap();
    bob.commands.send(NetworkCommand::Stop).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut alice.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut bob.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rooms2_counts_converge_across_many_application_loops_and_disconnects() {
    let _runtime_test_guard = messaging_runtime_test_lock().lock().await;
    const GUESTS: usize = 4;
    let files = TestDirectory::new();
    let mut owner = TestPeer::start("rooms-owner", vec![], files.0.join("owner-downloads")).await;
    let addresses = owner
        .event("network-status", |value| {
            value["listen_addresses"].as_array().is_some_and(|list| {
                list.iter()
                    .any(|address| address.as_str().is_some_and(|raw| raw.contains("/tcp/")))
            })
        })
        .await;
    let address = addresses["listen_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|value| value.as_str().filter(|raw| raw.contains("/tcp/")))
        .unwrap()
        .to_string();

    let mut guests = Vec::with_capacity(GUESTS);
    for index in 0..GUESTS {
        let mut guest = TestPeer::start(
            &format!("rooms-guest-{index}"),
            vec![address.clone()],
            files.0.join(format!("guest-{index}-downloads")),
        )
        .await;
        owner
            .event("peer-online", |value| value["peer_id"] == guest.id)
            .await;
        guest
            .event("peer-online", |value| value["peer_id"] == owner.id)
            .await;
        guests.push(guest);
    }

    let (reply, response) = oneshot::channel();
    owner
        .commands
        .send(NetworkCommand::CreateRoom {
            room: RoomInfo {
                id: "rooms-runtime".into(),
                title: "# rooms runtime".into(),
                owner: None,
                users: Some(1),
                password_protected: false,
                auth_revision: 0,
            },
            password: None,
            reply,
        })
        .await
        .unwrap();
    let created = response.await.unwrap().unwrap();
    assert_eq!(created.users, Some(1));

    for guest in &mut guests {
        guest
            .event("room-created", |value| value["id"] == "rooms-runtime")
            .await;
    }

    for (index, guest) in guests.iter_mut().enumerate() {
        let (reply, response) = oneshot::channel();
        guest
            .commands
            .send(NetworkCommand::EnterRoom {
                room_id: "rooms-runtime".into(),
                reply,
            })
            .await
            .unwrap();
        response.await.unwrap().unwrap();
        let expected = (index + 2) as u64;
        owner
            .event("room-user-count", |value| {
                value["room_id"] == "rooms-runtime" && value["users"] == expected
            })
            .await;
    }

    // Let unchanged heartbeat snapshots traverse the real production GossipSub
    // path, then prove they did not inflate membership by switching one peer out
    // and back in. The count must move 5 -> 4 -> 5, not accumulate duplicates.
    tokio::time::sleep(Duration::from_secs(11)).await;
    let (reply, response) = oneshot::channel();
    guests[0]
        .commands
        .send(NetworkCommand::EnterRoom {
            room_id: "world".into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    owner
        .event("room-user-count", |value| {
            value["room_id"] == "rooms-runtime" && value["users"] == GUESTS as u64
        })
        .await;

    let (reply, response) = oneshot::channel();
    guests[0]
        .commands
        .send(NetworkCommand::EnterRoom {
            room_id: "rooms-runtime".into(),
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap().unwrap();
    owner
        .event("room-user-count", |value| {
            value["room_id"] == "rooms-runtime" && value["users"] == (GUESTS + 1) as u64
        })
        .await;

    // Graceful shutdown exercises authenticated-goodbye cleanup.
    guests[1].commands.send(NetworkCommand::Stop).await.unwrap();
    owner
        .event("room-user-count", |value| {
            value["room_id"] == "rooms-runtime" && value["users"] == GUESTS as u64
        })
        .await;
    tokio::time::timeout(Duration::from_secs(5), &mut guests[1].task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // Abrupt task cancellation drops the swarm without a Goodbye frame and
    // exercises final-connection cleanup in the production SwarmEvent path.
    guests[2].task.abort();
    owner
        .event("room-user-count", |value| {
            value["room_id"] == "rooms-runtime" && value["users"] == (GUESTS - 1) as u64
        })
        .await;

    owner.commands.send(NetworkCommand::Stop).await.unwrap();
    for index in [0usize, 3usize] {
        let _ = guests[index].commands.send(NetworkCommand::Stop).await;
    }
    tokio::time::timeout(Duration::from_secs(5), &mut owner.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
