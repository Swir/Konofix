//! Optional KNP contact session owned by, but isolated from, the primary libp2p session.
use crate::{
    knp_chat::{Contact, KnpChat, Snapshot},
    AppState, KnpChatSession,
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
        .filter(|session| session.chat.session_id == session_id)
        .map(|session| session.chat.clone())
        .ok_or_else(|| "This chat session is no longer active.".into())
}

#[tauri::command]
pub(crate) async fn start_knp_chat(
    nick: String,
    profile: String,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let _gate = state.session_gate.lock().await;
    let owner = state
        .tx
        .lock()
        .map_err(|_| "Network state lock failed.")?
        .clone()
        .ok_or("Connect to the primary P2P network before opening optional KNP contacts.")?;
    if state
        .knp_chat
        .lock()
        .map_err(|_| "Chat state lock failed.")?
        .is_some()
    {
        return Err("A KNP contact session is already active.".into());
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
    // This optional route never impersonates a libp2p PeerID or changes its routes.
    let session = KnpChat::spawn(config, nick, Some(lock)).await?;
    let snapshot = match session.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            session.shutdown().await;
            return Err(error);
        }
    };
    let installed = {
        let tx = state.tx.lock().map_err(|_| "Network state lock failed.")?;
        if tx
            .as_ref()
            .is_some_and(|current| current.same_channel(&owner))
        {
            *state
                .knp_chat
                .lock()
                .map_err(|_| "Chat state lock failed.")? = Some(KnpChatSession {
                owner,
                chat: session.clone(),
            });
            true
        } else {
            false
        }
    };
    if !installed {
        session.shutdown().await;
        return Err("The primary P2P session ended during KNP startup.".into());
    }
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
        if guard
            .as_ref()
            .is_some_and(|s| s.chat.session_id != session_id)
        {
            return Err("This chat session is no longer active.".into());
        }
        guard.take()
    };
    if let Some(session) = session {
        session.chat.shutdown().await;
    }
    Ok(())
}
