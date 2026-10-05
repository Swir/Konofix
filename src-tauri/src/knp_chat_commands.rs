//! Windows IPC boundary for an exclusive KNP-only chat session.
use crate::{
    knp_chat::{Contact, KnpChat, Snapshot},
    AppState,
};
use kononexus::KonofixSdkConfig;
use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
use tauri::State;

fn current(state: &AppState, session_id: &str) -> Result<KnpChat, String> {
    state
        .knp_chat
        .lock()
        .map_err(|_| "Chat state lock failed.")?
        .as_ref()
        .filter(|session| session.session_id == session_id)
        .cloned()
        .ok_or_else(|| "This chat session is no longer active.".into())
}

#[tauri::command]
pub(crate) async fn start_knp_chat(
    nick: String,
    profile: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let _gate = state.session_gate.lock().await;
    if state
        .tx
        .lock()
        .map_err(|_| "Network state lock failed.")?
        .is_some()
        || state
            .knp_chat
            .lock()
            .map_err(|_| "Chat state lock failed.")?
            .is_some()
    {
        return Err("Disconnect the active session before starting KNP chat.".into());
    }
    if profile.is_empty()
        || profile.len() > 32
        || !profile
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("Profile must contain 1 to 32 lowercase letters, digits or hyphens.".into());
    }
    let root = dirs::data_local_dir()
        .ok_or("Local application-data directory unavailable.")?
        .join("Konofix Chat")
        .join("KonoNexus")
        .join("chat-profiles")
        .join(profile);
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create the chat profile directory.")?;
    // Windows denies sharing while this handle lives; process exit releases it,
    // so a crash never leaves a stale lock or concurrent identity writers.
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("session.lock"))
        .map_err(|_| "This profile is in use or inaccessible. Choose another profile.")?;
    let config = KonofixSdkConfig::new(root.join("identity.key"))
        .with_bind("0.0.0.0:0".parse().map_err(|_| "Invalid bind address.")?)
        .with_routing_cache(root.join("routing-cache.json"));
    // Production defaults: no test mode, seed list, or libp2p fallback.
    let session = KnpChat::spawn(config, nick, Some(lock)).await?;
    let snapshot = match session.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            session.shutdown().await;
            return Err(error);
        }
    };
    *state
        .knp_chat
        .lock()
        .map_err(|_| "Chat state lock failed.")? = Some(session);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn knp_chat_snapshot(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    current(state.inner(), &session_id)?.snapshot().await
}

#[tauri::command]
pub(crate) async fn add_knp_chat_contact(
    session_id: String,
    node_id: String,
    endpoint: String,
    label: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    current(state.inner(), &session_id)?
        .add_contact(Contact {
            node_id,
            endpoint,
            label,
        })
        .await
}

#[tauri::command]
pub(crate) async fn send_knp_chat_message(
    session_id: String,
    peer_node_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    current(state.inner(), &session_id)?
        .send(peer_node_id, text)
        .await
}

#[tauri::command]
pub(crate) async fn stop_knp_chat(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _gate = state.session_gate.lock().await;
    let session = {
        let mut guard = state
            .knp_chat
            .lock()
            .map_err(|_| "Chat state lock failed.")?;
        if guard.as_ref().is_some_and(|s| s.session_id != session_id) {
            return Err("This chat session is no longer active.".into());
        }
        guard.take()
    };
    if let Some(session) = session {
        session.shutdown().await;
    }
    Ok(())
}
