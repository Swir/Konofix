#![cfg(windows)]

#[path = "../src/kononexus_transport.rs"]
mod kononexus_transport;

use kononexus::{KonofixSdkConfig, NodeIdentity, RelayAppEvent};
use kononexus_transport::KonoNexusRuntime;
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time};

fn unique_state_dir() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("konofix-knp-live-{}-{nonce}", std::process::id()))
}

async fn spawn_transport(
    root: &std::path::Path,
    name: &str,
) -> (KonoNexusRuntime, mpsc::Receiver<RelayAppEvent>) {
    let config = KonofixSdkConfig::new(root.join(format!("{name}.key")))
        .with_bind("127.0.0.1:0".parse().unwrap())
        .with_routing_cache(root.join(format!("{name}-routing.json")))
        .with_hello_interval(Duration::from_millis(100))
        .with_local_test_mode(true);
    KonoNexusRuntime::spawn(config).await.unwrap()
}

async fn wait_for_message(
    events: &mut mpsc::Receiver<RelayAppEvent>,
    expected_peer: &str,
    expected_data: &[u8],
) {
    time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Some(RelayAppEvent::Message(message))
                    if message.peer_node_id == expected_peer && message.data == expected_data =>
                {
                    break;
                }
                Some(RelayAppEvent::Failed(failure)) => {
                    panic!("unexpected KonoNexus delivery failure: {failure:?}");
                }
                Some(_) => {}
                None => panic!("KonoNexus event stream ended before message delivery"),
            }
        }
    })
    .await
    .expect("timed out waiting for KonoNexus app message");
}

async fn wait_for_receipt(
    events: &mut mpsc::Receiver<RelayAppEvent>,
    expected_peer: &str,
    expected_id: u64,
) {
    time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Some(RelayAppEvent::Delivered(receipt))
                    if receipt.peer_node_id == expected_peer
                        && receipt.message_id == expected_id =>
                {
                    break;
                }
                Some(RelayAppEvent::Failed(failure)) if failure.message_id == expected_id => {
                    panic!("KonoNexus delivery failed: {failure:?}");
                }
                Some(_) => {}
                None => panic!("KonoNexus event stream ended before delivery receipt"),
            }
        }
    })
    .await
    .expect("timed out waiting for KonoNexus delivery receipt");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_kononexus_transports_deliver_encrypted_app_data_and_receipt() {
    let root = unique_state_dir();
    std::fs::create_dir_all(&root).unwrap();
    let (a, mut a_events) = spawn_transport(&root, "a").await;
    let (b, mut b_events) = spawn_transport(&root, "b").await;
    let a_node_id = a.node_id().to_owned();
    let b_node_id = b.node_id().to_owned();

    a.connect(b_node_id.clone(), vec![b.local_addr()])
        .await
        .expect("queue exact expected identity and endpoint");
    let data = b"konofix application payload".to_vec();
    let message_id = a
        .send(b_node_id.clone(), data.clone())
        .await
        .expect("queue app message on KonoNexus transport");

    tokio::join!(
        wait_for_message(&mut b_events, &a_node_id, &data),
        wait_for_receipt(&mut a_events, &b_node_id, message_id),
    );

    a.shutdown().await;
    b.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exact_endpoint_with_wrong_node_id_never_authenticates_or_delivers() {
    let root = unique_state_dir();
    std::fs::create_dir_all(&root).unwrap();
    let (a, mut a_events) = spawn_transport(&root, "a").await;
    let (impostor, mut impostor_events) = spawn_transport(&root, "impostor").await;
    let expected_node_id = NodeIdentity::generate().node_id();

    // This test constructs only KonoNexus transports, so libp2p fallback cannot mask rejection.
    a.connect(expected_node_id.clone(), vec![impostor.local_addr()])
        .await
        .expect("queue exact endpoint under the expected identity");
    let message_id = a
        .send(expected_node_id.clone(), b"must not be delivered".to_vec())
        .await
        .expect("queue app message for expected identity");

    let authenticated_peer_counts = time::timeout(Duration::from_secs(3), async {
        let mut counts = Vec::new();
        for _ in 0..20 {
            counts.push(a.authenticated_peer_count().await.unwrap());
            time::sleep(Duration::from_millis(100)).await;
        }
        counts
    })
    .await
    .expect("timed out observing exact-endpoint identity admission");
    assert!(authenticated_peer_counts.iter().all(|count| *count == 0));

    while let Ok(Some(event)) =
        time::timeout(Duration::from_millis(100), impostor_events.recv()).await
    {
        assert!(
            !matches!(event, RelayAppEvent::Message(message) if message.message_id == message_id),
            "message was delivered to the endpoint with the wrong identity"
        );
    }
    while let Ok(Some(event)) = time::timeout(Duration::from_millis(100), a_events.recv()).await {
        assert!(
            !matches!(event, RelayAppEvent::Delivered(receipt) if receipt.message_id == message_id),
            "message was acknowledged despite the endpoint's wrong identity"
        );
    }

    a.shutdown().await;
    impostor.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
