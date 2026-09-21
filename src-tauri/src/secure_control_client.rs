use std::collections::HashMap;

use libp2p::PeerId;

use crate::secure_channels::{ControlRequest, ControlResponse, PrivateDirectMessage};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedRoomSecurity {
    pub room_id: String,
    pub owner: PeerId,
    pub password_protected: bool,
    pub auth_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingSecureRequest {
    RoomJoin {
        request_id: String,
        room_id: String,
        owner: PeerId,
        auth_revision: u64,
    },
    PrivateMessage {
        message: PrivateDirectMessage,
        target: PeerId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureResponseOutcome {
    RoomJoinGranted {
        room_id: String,
        auth_revision: u64,
    },
    RoomJoinRejected {
        room_id: String,
        reason: String,
    },
    PrivateDelivered {
        message: PrivateDirectMessage,
    },
    PrivateRejected {
        message: PrivateDirectMessage,
        reason: String,
    },
    Ignored,
}

#[derive(Debug, Default)]
pub struct SecureControlClient {
    observed_rooms: HashMap<String, ObservedRoomSecurity>,
    authorized_room_revisions: HashMap<String, u64>,
    pending: HashMap<String, PendingSecureRequest>,
}

impl SecureControlClient {
    pub fn observe_room(&mut self, room: ObservedRoomSecurity) {
        let changed = self.observed_rooms.get(&room.room_id).is_some_and(|previous| {
            previous.owner != room.owner
                || previous.password_protected != room.password_protected
                || previous.auth_revision != room.auth_revision
        });
        if changed || !room.password_protected {
            self.authorized_room_revisions.remove(&room.room_id);
        }
        self.observed_rooms.insert(room.room_id.clone(), room);
    }

    pub fn remove_room(&mut self, room_id: &str) {
        self.observed_rooms.remove(room_id);
        self.authorized_room_revisions.remove(room_id);
        self.pending.retain(|_, pending| match pending {
            PendingSecureRequest::RoomJoin { room_id: pending_room, .. } => pending_room != room_id,
            PendingSecureRequest::PrivateMessage { .. } => true,
        });
    }

    pub fn room_requires_authorization(&self, room_id: &str, local_peer: &PeerId) -> bool {
        self.observed_rooms.get(room_id).is_some_and(|room| {
            room.password_protected
                && room.owner != *local_peer
                && self.authorized_room_revisions.get(room_id) != Some(&room.auth_revision)
        })
    }

    pub fn room_authorized(&self, room_id: &str, local_peer: &PeerId) -> bool {
        self.observed_rooms.get(room_id).is_none_or(|room| {
            !room.password_protected
                || room.owner == *local_peer
                || self.authorized_room_revisions.get(room_id) == Some(&room.auth_revision)
        })
    }

    pub fn track_room_join(
        &mut self,
        request: &ControlRequest,
        owner: PeerId,
        auth_revision: u64,
    ) -> Result<String, &'static str> {
        let ControlRequest::RoomJoin {
            request_id,
            room_id,
            ..
        } = request
        else {
            return Err("Room join request required.");
        };
        let observed = self
            .observed_rooms
            .get(room_id)
            .ok_or("Room security metadata is unknown.")?;
        if !observed.password_protected
            || observed.owner != owner
            || observed.auth_revision != auth_revision
        {
            return Err("Room security metadata changed before authorization.");
        }
        if self.pending.contains_key(request_id) {
            return Err("Room join request is already pending.");
        }
        self.pending.insert(
            request_id.clone(),
            PendingSecureRequest::RoomJoin {
                request_id: request_id.clone(),
                room_id: room_id.clone(),
                owner,
                auth_revision,
            },
        );
        Ok(request_id.clone())
    }

    pub fn track_private_message(
        &mut self,
        request: &ControlRequest,
        target: PeerId,
    ) -> Result<String, &'static str> {
        let ControlRequest::PrivateMessage(message) = request else {
            return Err("Private message request required.");
        };
        if message.target_peer_id != target.to_string() {
            return Err("Private target does not match the tracked peer.");
        }
        if self.pending.contains_key(&message.id) {
            return Err("Private message is already pending.");
        }
        self.pending.insert(
            message.id.clone(),
            PendingSecureRequest::PrivateMessage {
                message: message.clone(),
                target,
            },
        );
        Ok(message.id.clone())
    }

    pub fn cancel_pending(&mut self, correlation_id: &str) -> Option<PendingSecureRequest> {
        self.pending.remove(correlation_id)
    }

    pub fn handle_response(
        &mut self,
        authenticated_peer: &PeerId,
        response: ControlResponse,
    ) -> SecureResponseOutcome {
        match response {
            ControlResponse::RoomJoin {
                request_id,
                granted,
                reason,
            } => {
                let Some(PendingSecureRequest::RoomJoin {
                    room_id,
                    owner,
                    auth_revision,
                    ..
                }) = self.pending.get(&request_id).cloned()
                else {
                    return SecureResponseOutcome::Ignored;
                };
                if owner != *authenticated_peer {
                    return SecureResponseOutcome::Ignored;
                }
                let still_current = self.observed_rooms.get(&room_id).is_some_and(|room| {
                    room.password_protected
                        && room.owner == owner
                        && room.auth_revision == auth_revision
                });
                if !still_current {
                    self.pending.remove(&request_id);
                    return SecureResponseOutcome::Ignored;
                }
                self.pending.remove(&request_id);
                if granted {
                    self.authorized_room_revisions
                        .insert(room_id.clone(), auth_revision);
                    SecureResponseOutcome::RoomJoinGranted {
                        room_id,
                        auth_revision,
                    }
                } else {
                    SecureResponseOutcome::RoomJoinRejected {
                        room_id,
                        reason: bounded_reason(reason, "access_denied"),
                    }
                }
            }
            ControlResponse::PrivateAck {
                message_id,
                accepted,
                reason,
            } => {
                let Some(PendingSecureRequest::PrivateMessage { message, target }) =
                    self.pending.get(&message_id).cloned()
                else {
                    return SecureResponseOutcome::Ignored;
                };
                if target != *authenticated_peer || message.id != message_id {
                    return SecureResponseOutcome::Ignored;
                }
                self.pending.remove(&message_id);
                if accepted {
                    SecureResponseOutcome::PrivateDelivered { message }
                } else {
                    SecureResponseOutcome::PrivateRejected {
                        message,
                        reason: bounded_reason(reason, "private_rejected"),
                    }
                }
            }
        }
    }
}

fn bounded_reason(reason: Option<String>, fallback: &str) -> String {
    let reason = reason.unwrap_or_else(|| fallback.to_string());
    if reason.len() <= 128 && !reason.chars().any(char::is_control) {
        reason
    } else {
        fallback.to_string()
    }
}
