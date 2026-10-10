import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/core';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

const EVENT_KIND = 28_733; // NIP-01 ephemeral range: compliant relays should not retain history.
const TOPIC = 'konofix-world-v1';
const NAMESPACE = 'konofix/world-relay/1';
const SECRET_STORAGE_KEY = 'konofix.worldRelaySecret.v1';
const PRESENCE_TTL_MS = 75_000;
const MESSAGE_TTL_MS = 120_000;
const MAX_CONTENT_BYTES = 12 * 1024;
const MAX_ENCRYPTED_CONTENT_BYTES = 48 * 1024;
const MAX_RELAY_FILE_BYTES = 2 * 1024 * 1024;
const RELAY_FILE_CHUNK_BYTES = 16 * 1024;
const MAX_SEEN_EVENTS = 2_048;
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
] as const;

export type RelayChatMessage = {
  id: string;
  kind: string;
  peer_id?: string;
  nick: string;
  nick_color?: string;
  room: string;
  text: string;
  timestamp: number;
};

export type RelayPeer = {
  peer_id: string;
  claimed_peer_id: string;
  nick: string;
  nick_color?: string;
};

export type RelayState = { connected: number; total: number };

export type RelayPrivateMessage = {
  id: string;
  peer_id: string;
  target_peer_id: string;
  nick: string;
  nick_color?: string;
  text: string;
  timestamp: number;
};

export type RelayFileSelection = {
  file_name: string;
  size: number;
  sha256: string;
  data_base64: string;
};

export type RelayFileOffer = {
  transfer_id: string;
  peer_id: string;
  nick: string;
  file_name: string;
  size: number;
  sha256: string;
  chunks: number;
};

export type RelayFileProgress = RelayFileOffer & {
  direction: 'incoming' | 'outgoing';
  transferred: number;
  progress: number;
  status: 'waiting' | 'transferring' | 'verifying' | 'completed' | 'rejected' | 'failed' | 'cancelled';
  error?: string;
};

export type RelayFileReady = RelayFileOffer & { data_base64: string };

type Callbacks = {
  onPresence(peer: RelayPeer): void;
  onOffline(peerId: string): void;
  onChat(message: RelayChatMessage): void;
  onState(state: RelayState): void;
  onPrivate?(message: RelayPrivateMessage): void;
  onFileOffer?(offer: RelayFileOffer): void;
  onFileProgress?(progress: RelayFileProgress): void;
  onFileReady?(file: RelayFileReady): void;
};

type PresencePayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'presence' | 'goodbye';
  session: string;
  peer_id: string;
  nick: string;
  nick_color: string;
  sent_at: number;
};

type ChatPayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'chat';
  session: string;
  peer_id: string;
  nick: string;
  nick_color: string;
  sent_at: number;
  message: RelayChatMessage;
};

type Payload = PresencePayload | ChatPayload;

type EncryptedPrivatePayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'private';
  session: string;
  sent_at: number;
  id: string;
  text: string;
};

type EncryptedFileOfferPayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'file_offer';
  session: string;
  sent_at: number;
  transfer_id: string;
  file_name: string;
  size: number;
  sha256: string;
  chunks: number;
};

type EncryptedFileControlPayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'file_accept' | 'file_reject' | 'file_saved' | 'file_chunks_complete';
  session: string;
  sent_at: number;
  transfer_id: string;
  reason?: string;
};

type EncryptedFileMissingPayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'file_missing';
  session: string;
  sent_at: number;
  transfer_id: string;
  missing: number[];
};

type EncryptedFileChunkPayload = {
  v: 1;
  ns: typeof NAMESPACE;
  type: 'file_chunk';
  session: string;
  sent_at: number;
  transfer_id: string;
  index: number;
  data: string;
};

type EncryptedPayload = EncryptedPrivatePayload | EncryptedFileOfferPayload | EncryptedFileControlPayload | EncryptedFileMissingPayload | EncryptedFileChunkPayload;

type RemotePresence = { peer: RelayPeer; seenAt: number };

type RelaySocket = {
  url: string;
  socket?: WebSocket;
  reconnect?: number;
  failures: number;
};

type PendingEvent = { wire: string; until: number; sent: Set<string> };

type OutgoingRelayFile = RelayFileOffer & { target: string; bytes: Uint8Array; retry_rounds: number };
type IncomingRelayFile = RelayFileOffer & { chunksByIndex: Map<number, string>; received: number };

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/.test(value)) return undefined;
  return Uint8Array.from(value.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16)));
}

function loadSecret(): Uint8Array {
  let saved: string | null = null;
  try { saved = localStorage.getItem(SECRET_STORAGE_KEY); } catch {}
  const decoded = saved ? hexToBytes(saved) : undefined;
  if (decoded) {
    try {
      getPublicKey(decoded);
      return decoded;
    } catch {
      try { localStorage.removeItem(SECRET_STORAGE_KEY); } catch {}
    }
  }
  const secret = generateSecretKey();
  try { localStorage.setItem(SECRET_STORAGE_KEY, bytesToHex(secret)); } catch {}
  return secret;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function validColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function relayPublicKey(peerId: string): string | undefined {
  const match = /^nostr:([0-9a-f]{64})$/.exec(peerId);
  return match?.[1];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return undefined; }
}

function validFileName(value: unknown): value is string {
  return boundedString(value, 1, 180)
    && !/[\u0000-\u001f<>:"/\\|?*]/.test(value)
    && value !== '.'
    && value !== '..';
}

function parsePayload(content: string, now: number): Payload | undefined {
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return undefined; }
  if (!isObject(raw)
    || raw.v !== 1
    || raw.ns !== NAMESPACE
    || !['presence', 'goodbye', 'chat'].includes(String(raw.type))
    || !boundedString(raw.session, 8, 64)
    || !boundedString(raw.peer_id, 16, 128)
    || !boundedString(raw.nick, 3, 24)
    || !validColor(raw.nick_color)
    || typeof raw.sent_at !== 'number'
    || !Number.isSafeInteger(raw.sent_at)
    || Math.abs(now - raw.sent_at) > MESSAGE_TTL_MS) {
    return undefined;
  }
  if (raw.type !== 'chat') return raw as unknown as PresencePayload;
  if (!isObject(raw.message)) return undefined;
  const message = raw.message;
  if (!boundedString(message.id, 8, 64)
    || message.kind !== 'chat'
    || message.room !== 'world'
    || message.peer_id !== raw.peer_id
    || !boundedString(message.nick, 3, 24)
    || message.nick !== raw.nick
    || !validColor(message.nick_color)
    || !boundedString(message.text, 1, 4_000)
    || typeof message.timestamp !== 'number'
    || !Number.isSafeInteger(message.timestamp)
    || Math.abs(message.timestamp - raw.sent_at) > 5_000
    || Math.abs(now - message.timestamp) > MESSAGE_TTL_MS) {
    return undefined;
  }
  return raw as unknown as ChatPayload;
}

function parseEncryptedPayload(content: string, now: number): EncryptedPayload | undefined {
  if (new TextEncoder().encode(content).byteLength > MAX_ENCRYPTED_CONTENT_BYTES) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return undefined; }
  if (!isObject(raw)
    || raw.v !== 1
    || raw.ns !== NAMESPACE
    || !['private', 'file_offer', 'file_accept', 'file_reject', 'file_chunk', 'file_saved', 'file_chunks_complete', 'file_missing'].includes(String(raw.type))
    || !boundedString(raw.session, 8, 64)
    || typeof raw.sent_at !== 'number'
    || !Number.isSafeInteger(raw.sent_at)
    || Math.abs(now - raw.sent_at) > MESSAGE_TTL_MS) return undefined;

  if (raw.type === 'private') {
    if (!validUuid(raw.id) || !boundedString(raw.text, 1, 4_000)) return undefined;
    return raw as unknown as EncryptedPrivatePayload;
  }
  if (!validUuid(raw.transfer_id)) return undefined;
  if (raw.type === 'file_offer') {
    if (!validFileName(raw.file_name)
      || typeof raw.size !== 'number'
      || !Number.isSafeInteger(raw.size)
      || raw.size < 0
      || raw.size > MAX_RELAY_FILE_BYTES
      || !validSha256(raw.sha256)
      || typeof raw.chunks !== 'number'
      || !Number.isSafeInteger(raw.chunks)
      || raw.chunks !== Math.max(1, Math.ceil(raw.size / RELAY_FILE_CHUNK_BYTES))) return undefined;
    return raw as unknown as EncryptedFileOfferPayload;
  }
  if (raw.type === 'file_chunk') {
    if (typeof raw.index !== 'number'
      || !Number.isSafeInteger(raw.index)
      || raw.index < 0
      || !boundedString(raw.data, 0, Math.ceil(RELAY_FILE_CHUNK_BYTES / 3) * 4 + 4)
      || !base64ToBytes(raw.data)) return undefined;
    return raw as unknown as EncryptedFileChunkPayload;
  }
  if (raw.type === 'file_missing') {
    if (!Array.isArray(raw.missing)
      || raw.missing.length < 1
      || raw.missing.length > Math.ceil(MAX_RELAY_FILE_BYTES / RELAY_FILE_CHUNK_BYTES)
      || raw.missing.some(index => !Number.isSafeInteger(index) || index < 0)) return undefined;
    return raw as unknown as EncryptedFileMissingPayload;
  }
  if (raw.reason !== undefined && !boundedString(raw.reason, 1, 240)) return undefined;
  return raw as unknown as EncryptedFileControlPayload;
}

function topicMatches(event: NostrEvent): boolean {
  return event.kind === EVENT_KIND
    && event.tags.some(tag => tag.length >= 2 && tag[0] === 't' && tag[1] === TOPIC);
}

function validEventShape(event: unknown): event is NostrEvent {
  return isObject(event)
    && boundedString(event.id, 64, 64)
    && boundedString(event.pubkey, 64, 64)
    && typeof event.created_at === 'number'
    && Number.isSafeInteger(event.created_at)
    && typeof event.content === 'string'
    && Array.isArray(event.tags);
}

function hasValidSignature(event: NostrEvent): boolean {
  try { return verifyEvent(event); } catch { return false; }
}

export class WorldRelayBridge {
  private readonly secret = loadSecret();
  private readonly publicKey = getPublicKey(this.secret);
  private readonly sockets = new Map<string, RelaySocket>();
  private readonly seen = new Set<string>();
  private readonly presence = new Map<string, RemotePresence>();
  private readonly pending: PendingEvent[] = [];
  private readonly outgoingFiles = new Map<string, OutgoingRelayFile>();
  private readonly offeredFiles = new Map<string, RelayFileOffer>();
  private readonly incomingFiles = new Map<string, IncomingRelayFile>();
  private callbacks?: Callbacks;
  private session = '';
  private peerId = '';
  private nick = '';
  private nickColor = '#35d07f';
  private heartbeat?: number;
  private sweeper?: number;
  private presenceResponse?: number;
  private running = false;

  start(peerId: string, nick: string, nickColor: string, callbacks: Callbacks): void {
    this.stop(false);
    this.running = true;
    this.callbacks = callbacks;
    this.session = crypto.randomUUID();
    this.peerId = peerId;
    this.nick = nick;
    this.nickColor = validColor(nickColor) ? nickColor : '#35d07f';
    for (const url of RELAYS) {
      const state: RelaySocket = { url, failures: 0 };
      this.sockets.set(url, state);
      this.connect(state);
    }
    this.heartbeat = window.setInterval(() => this.publishPresence(), 30_000);
    this.sweeper = window.setInterval(() => this.sweep(), 5_000);
    this.emitState();
  }

  stop(sendGoodbye = true): void {
    if (sendGoodbye && this.running) this.publish('goodbye');
    this.running = false;
    if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat);
    if (this.sweeper !== undefined) window.clearInterval(this.sweeper);
    if (this.presenceResponse !== undefined) window.clearTimeout(this.presenceResponse);
    this.heartbeat = undefined;
    this.sweeper = undefined;
    this.presenceResponse = undefined;
    for (const state of this.sockets.values()) {
      if (state.reconnect !== undefined) window.clearTimeout(state.reconnect);
      state.socket?.close(1000, 'Konofix session ended');
    }
    this.sockets.clear();
    for (const peer of this.presence.values()) this.callbacks?.onOffline(peer.peer.peer_id);
    this.presence.clear();
    this.pending.length = 0;
    this.seen.clear();
    this.outgoingFiles.clear();
    this.offeredFiles.clear();
    this.incomingFiles.clear();
    this.emitState();
    this.callbacks = undefined;
  }

  publishChat(message: RelayChatMessage): void {
    if (!this.running || message.room !== 'world' || message.peer_id !== this.peerId) return;
    this.publish('chat', message);
  }

  publishPrivate(targetPeerId: string, text: string): RelayPrivateMessage {
    const trimmed = text.trim();
    if (!this.running) throw new Error('WORLD relay is offline.');
    if (!boundedString(trimmed, 1, 4_000)) throw new Error('Private message must contain 1-4000 characters.');
    const targetKey = relayPublicKey(targetPeerId);
    if (!targetKey || !this.presence.has(targetPeerId)) throw new Error('Private recipient is no longer available.');
    const message: RelayPrivateMessage = {
      id: crypto.randomUUID(),
      peer_id: this.virtualPeerId(),
      target_peer_id: targetPeerId,
      nick: this.nick,
      nick_color: this.nickColor,
      text: trimmed,
      timestamp: Date.now(),
    };
    this.publishEncrypted(targetKey, {
      v: 1,
      ns: NAMESPACE,
      type: 'private',
      session: this.session,
      sent_at: message.timestamp,
      id: message.id,
      text: message.text,
    });
    return message;
  }

  offerFile(targetPeerId: string, selection: RelayFileSelection): RelayFileOffer {
    if (!this.running) throw new Error('WORLD relay is offline.');
    if (this.outgoingFiles.size >= 4) throw new Error('All encrypted relay file slots are busy.');
    const targetKey = relayPublicKey(targetPeerId);
    if (!targetKey || !this.presence.has(targetPeerId)) throw new Error('File recipient is no longer available.');
    if (!validFileName(selection.file_name)
      || !Number.isSafeInteger(selection.size)
      || selection.size < 0
      || selection.size > MAX_RELAY_FILE_BYTES
      || !validSha256(selection.sha256)) throw new Error('Invalid encrypted relay file.');
    const bytes = base64ToBytes(selection.data_base64);
    if (!bytes || bytes.byteLength !== selection.size) throw new Error('File bytes do not match the selected file size.');
    const transferId = crypto.randomUUID();
    const offer: RelayFileOffer = {
      transfer_id: transferId,
      peer_id: targetPeerId,
      nick: this.presence.get(targetPeerId)?.peer.nick ?? targetPeerId,
      file_name: selection.file_name,
      size: selection.size,
      sha256: selection.sha256.toLowerCase(),
      chunks: Math.max(1, Math.ceil(selection.size / RELAY_FILE_CHUNK_BYTES)),
    };
    this.outgoingFiles.set(transferId, { ...offer, target: targetPeerId, bytes, retry_rounds: 0 });
    this.publishEncrypted(targetKey, {
      v: 1,
      ns: NAMESPACE,
      type: 'file_offer',
      session: this.session,
      sent_at: Date.now(),
      transfer_id: transferId,
      file_name: offer.file_name,
      size: offer.size,
      sha256: offer.sha256,
      chunks: offer.chunks,
    });
    this.emitFileProgress({ ...offer, direction: 'outgoing', transferred: 0, progress: 0, status: 'waiting' });
    return offer;
  }

  acceptFile(transferId: string): void {
    const offer = this.offeredFiles.get(transferId);
    if (!offer) throw new Error('File offer expired or is unavailable.');
    const targetKey = relayPublicKey(offer.peer_id);
    if (!targetKey) throw new Error('Invalid relay sender.');
    this.incomingFiles.set(transferId, { ...offer, chunksByIndex: new Map(), received: 0 });
    this.publishEncrypted(targetKey, this.fileControl('file_accept', transferId));
    this.emitFileProgress({ ...offer, direction: 'incoming', transferred: 0, progress: 0, status: 'transferring' });
  }

  rejectFile(transferId: string, reason = 'Recipient rejected the file.'): void {
    const offer = this.offeredFiles.get(transferId);
    if (!offer) return;
    const targetKey = relayPublicKey(offer.peer_id);
    if (targetKey) this.publishEncrypted(targetKey, this.fileControl('file_reject', transferId, reason));
    this.offeredFiles.delete(transferId);
  }

  confirmFileSaved(transferId: string, senderPeerId: string): void {
    const targetKey = relayPublicKey(senderPeerId);
    if (targetKey) this.publishEncrypted(targetKey, this.fileControl('file_saved', transferId));
    this.offeredFiles.delete(transferId);
    this.incomingFiles.delete(transferId);
  }

  cancelFile(transferId: string): void {
    const outgoing = this.outgoingFiles.get(transferId);
    if (outgoing) {
      const targetKey = relayPublicKey(outgoing.target);
      if (targetKey) this.publishEncrypted(targetKey, this.fileControl('file_reject', transferId, 'Sender cancelled the file.'));
      this.outgoingFiles.delete(transferId);
      this.emitFileProgress({ ...outgoing, direction: 'outgoing', transferred: 0, progress: 0, status: 'cancelled' });
      return;
    }
    const incoming = this.incomingFiles.get(transferId) ?? this.offeredFiles.get(transferId);
    if (!incoming) return;
    const targetKey = relayPublicKey(incoming.peer_id);
    if (targetKey) this.publishEncrypted(targetKey, this.fileControl('file_reject', transferId, 'Recipient cancelled the file.'));
    this.incomingFiles.delete(transferId);
    this.offeredFiles.delete(transferId);
    this.emitFileProgress({ ...incoming, direction: 'incoming', transferred: 0, progress: 0, status: 'cancelled' });
  }

  virtualPeerId(): string { return `nostr:${this.publicKey}`; }

  relayFileLimit(): number { return MAX_RELAY_FILE_BYTES; }

  private connect(state: RelaySocket): void {
    if (!this.running) return;
    let socket: WebSocket;
    try { socket = new WebSocket(state.url); } catch { this.scheduleReconnect(state); return; }
    state.socket = socket;
    const generation = this.session;
    socket.addEventListener('open', () => {
      if (!this.running || this.session !== generation || state.socket !== socket) return;
      state.failures = 0;
      const since = Math.floor((Date.now() - MESSAGE_TTL_MS) / 1000);
      socket.send(JSON.stringify(['REQ', `konofix-${this.session.slice(0, 12)}`, {
        kinds: [EVENT_KIND], '#t': [TOPIC], since, limit: 256,
      }]));
      this.flush(state);
      this.publishPresence();
      this.emitState();
    });
    socket.addEventListener('message', event => {
      if (this.running && this.session === generation && state.socket === socket) {
        this.receive(event.data);
      }
    });
    socket.addEventListener('close', () => {
      if (state.socket === socket) state.socket = undefined;
      this.emitState();
      this.scheduleReconnect(state);
    });
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(state: RelaySocket): void {
    if (!this.running || state.reconnect !== undefined) return;
    state.failures = Math.min(state.failures + 1, 8);
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(state.failures, 6)) + Math.floor(Math.random() * 500);
    state.reconnect = window.setTimeout(() => {
      state.reconnect = undefined;
      this.connect(state);
    }, delay);
  }

  private publishPresence(): void { this.publish('presence'); }

  private publish(type: Payload['type'], message?: RelayChatMessage): void {
    if (!this.running) return;
    if (type === 'chat' && !message) return;
    const sentAt = Date.now();
    const base = {
      v: 1 as const,
      ns: NAMESPACE as typeof NAMESPACE,
      type,
      session: this.session,
      peer_id: this.peerId,
      nick: this.nick,
      nick_color: this.nickColor,
      sent_at: sentAt,
    };
    const payload: Payload = type === 'chat'
      ? { ...base, type: 'chat', message: message as RelayChatMessage }
      : { ...base, type };
    const expiryMs = type === 'chat' ? MESSAGE_TTL_MS : PRESENCE_TTL_MS;
    const nostrEvent = finalizeEvent({
      kind: EVENT_KIND,
      created_at: Math.floor(sentAt / 1000),
      tags: [['t', TOPIC], ['expiration', String(Math.floor((sentAt + expiryMs) / 1000))]],
      content: JSON.stringify(payload),
    }, this.secret);
    const wire = JSON.stringify(['EVENT', nostrEvent]);
    const pending = type === 'chat' ? { wire, until: sentAt + MESSAGE_TTL_MS, sent: new Set<string>() } : undefined;
    for (const state of this.sockets.values()) {
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(wire);
        pending?.sent.add(state.url);
      }
    }
    if (pending) {
      this.pending.push(pending);
      if (this.pending.length > 32) this.pending.splice(0, this.pending.length - 32);
    }
  }

  private publishEncrypted(targetPublicKey: string, payload: EncryptedPayload): void {
    if (!this.running || !/^[0-9a-f]{64}$/.test(targetPublicKey)) return;
    const sentAt = Date.now();
    let content: string;
    try {
      const key = getConversationKey(this.secret, targetPublicKey);
      content = encrypt(JSON.stringify(payload), key);
    } catch { return; }
    if (new TextEncoder().encode(content).byteLength > MAX_ENCRYPTED_CONTENT_BYTES) return;
    const nostrEvent = finalizeEvent({
      kind: EVENT_KIND,
      created_at: Math.floor(sentAt / 1000),
      tags: [
        ['t', TOPIC],
        ['p', targetPublicKey],
        ['expiration', String(Math.floor((sentAt + MESSAGE_TTL_MS) / 1000))],
      ],
      content,
    }, this.secret);
    const wire = JSON.stringify(['EVENT', nostrEvent]);
    const pending = { wire, until: sentAt + MESSAGE_TTL_MS, sent: new Set<string>() };
    for (const state of this.sockets.values()) {
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(wire);
        pending.sent.add(state.url);
      }
    }
    this.pending.push(pending);
    if (this.pending.length > 512) this.pending.splice(0, this.pending.length - 512);
  }

  private fileControl(type: EncryptedFileControlPayload['type'], transferId: string, reason?: string): EncryptedFileControlPayload {
    return { v: 1, ns: NAMESPACE, type, session: this.session, sent_at: Date.now(), transfer_id: transferId, reason };
  }

  private emitFileProgress(progress: RelayFileProgress): void {
    this.callbacks?.onFileProgress?.(progress);
  }

  private async sendFileChunks(file: OutgoingRelayFile, selected?: number[]): Promise<void> {
    const targetKey = relayPublicKey(file.target);
    if (!targetKey) return;
    const generation = this.session;
    const indexes = selected ?? Array.from({ length: file.chunks }, (_, index) => index);
    for (let position = 0; position < indexes.length; position += 1) {
      const index = indexes[position];
      if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunks) continue;
      if (!this.running || this.session !== generation || !this.outgoingFiles.has(file.transfer_id)) return;
      const start = index * RELAY_FILE_CHUNK_BYTES;
      const end = Math.min(file.bytes.length, start + RELAY_FILE_CHUNK_BYTES);
      this.publishEncrypted(targetKey, {
        v: 1,
        ns: NAMESPACE,
        type: 'file_chunk',
        session: this.session,
        sent_at: Date.now(),
        transfer_id: file.transfer_id,
        index,
        data: bytesToBase64(file.bytes.subarray(start, end)),
      });
      const transferred = end;
      this.emitFileProgress({
        ...file,
        direction: 'outgoing',
        transferred,
        progress: file.size === 0 ? 100 : (transferred / file.size) * 100,
        status: position + 1 === indexes.length && !selected ? 'verifying' : 'transferring',
      });
      if (position + 1 < indexes.length) await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    if (this.running && this.session === generation && this.outgoingFiles.has(file.transfer_id)) {
      this.publishEncrypted(targetKey, this.fileControl('file_chunks_complete', file.transfer_id));
    }
  }

  private flush(state: RelaySocket): void {
    if (state.socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    for (const event of this.pending) {
      if (event.until > now && !event.sent.has(state.url)) {
        state.socket.send(event.wire);
        event.sent.add(state.url);
      }
    }
    while (this.pending.length && this.pending[0].until <= now) this.pending.shift();
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string' || data.length > MAX_ENCRYPTED_CONTENT_BYTES * 3) return;
    let frame: unknown;
    try { frame = JSON.parse(data); } catch { return; }
    if (!Array.isArray(frame) || frame[0] !== 'EVENT' || frame.length !== 3 || !isObject(frame[2])) return;
    const event = frame[2];
    if (!validEventShape(event)
      || event.pubkey === this.publicKey
      || this.seen.has(event.id)
      || !hasValidSignature(event)
      || !topicMatches(event)) return;
    this.seen.add(event.id);
    while (this.seen.size > MAX_SEEN_EVENTS) this.seen.delete(this.seen.values().next().value!);
    const addressedToMe = event.tags.some(tag => tag.length >= 2 && tag[0] === 'p' && tag[1] === this.publicKey);
    if (addressedToMe) {
      let decrypted: string;
      try {
        decrypted = decrypt(event.content, getConversationKey(this.secret, event.pubkey));
      } catch { return; }
      const encryptedPayload = parseEncryptedPayload(decrypted, Date.now());
      if (!encryptedPayload || Math.abs(event.created_at * 1_000 - encryptedPayload.sent_at) > 5_000) return;
      this.receiveEncrypted(event.pubkey, encryptedPayload);
      return;
    }
    const payload = parsePayload(event.content, Date.now());
    if (!payload) return;
    if (Math.abs(event.created_at * 1_000 - payload.sent_at) > 5_000) return;
    if (payload.type !== 'chat' && Math.abs(Date.now() - payload.sent_at) > PRESENCE_TTL_MS) return;
    const virtualPeerId = `nostr:${event.pubkey}`;
    if (payload.type === 'goodbye') {
      if (this.presence.delete(virtualPeerId)) this.callbacks?.onOffline(virtualPeerId);
      return;
    }
    const peer: RelayPeer = {
      peer_id: virtualPeerId,
      claimed_peer_id: payload.peer_id,
      nick: payload.nick,
      nick_color: payload.nick_color,
    };
    const previous = this.presence.get(virtualPeerId)?.peer;
    this.presence.set(virtualPeerId, { peer, seenAt: Date.now() });
    if (!previous
      || previous.claimed_peer_id !== peer.claimed_peer_id
      || previous.nick !== peer.nick
      || previous.nick_color !== peer.nick_color) {
      this.callbacks?.onPresence(peer);
    }
    // Ephemeral Nostr events are not retained. Answer the first sighting so a
    // client that subscribed a moment later learns our presence immediately,
    // without waiting for the next periodic heartbeat.
    if (!previous && this.presenceResponse === undefined) {
      this.presenceResponse = window.setTimeout(() => {
        this.presenceResponse = undefined;
        this.publishPresence();
      }, 50);
    }
    if (payload.type === 'chat') {
      this.callbacks?.onChat({ ...payload.message, peer_id: virtualPeerId });
    }
  }

  private receiveEncrypted(senderPublicKey: string, payload: EncryptedPayload): void {
    const senderPeerId = `nostr:${senderPublicKey}`;
    const presence = this.presence.get(senderPeerId)?.peer;
    if (!presence) return;
    if (payload.type === 'private') {
      this.callbacks?.onPrivate?.({
        id: payload.id,
        peer_id: senderPeerId,
        target_peer_id: this.virtualPeerId(),
        nick: presence.nick,
        nick_color: presence.nick_color,
        text: payload.text,
        timestamp: payload.sent_at,
      });
      return;
    }
    if (payload.type === 'file_offer') {
      const offer: RelayFileOffer = {
        transfer_id: payload.transfer_id,
        peer_id: senderPeerId,
        nick: presence.nick,
        file_name: payload.file_name,
        size: payload.size,
        sha256: payload.sha256.toLowerCase(),
        chunks: payload.chunks,
      };
      if (this.offeredFiles.size >= 4 && !this.offeredFiles.has(offer.transfer_id)) return;
      this.offeredFiles.set(offer.transfer_id, offer);
      this.callbacks?.onFileOffer?.(offer);
      return;
    }
    if (payload.type === 'file_accept') {
      const outgoing = this.outgoingFiles.get(payload.transfer_id);
      if (!outgoing || outgoing.target !== senderPeerId) return;
      void this.sendFileChunks(outgoing);
      return;
    }
    if (payload.type === 'file_reject') {
      const outgoing = this.outgoingFiles.get(payload.transfer_id);
      if (!outgoing || outgoing.target !== senderPeerId) return;
      this.outgoingFiles.delete(payload.transfer_id);
      this.emitFileProgress({
        ...outgoing,
        direction: 'outgoing',
        transferred: 0,
        progress: 0,
        status: 'rejected',
        error: payload.reason ?? 'Recipient rejected the file.',
      });
      return;
    }
    if (payload.type === 'file_saved') {
      const outgoing = this.outgoingFiles.get(payload.transfer_id);
      if (!outgoing || outgoing.target !== senderPeerId) return;
      this.outgoingFiles.delete(payload.transfer_id);
      this.emitFileProgress({
        ...outgoing,
        direction: 'outgoing',
        transferred: outgoing.size,
        progress: 100,
        status: 'completed',
      });
      return;
    }
    if (payload.type === 'file_missing') {
      const outgoing = this.outgoingFiles.get(payload.transfer_id);
      if (!outgoing || outgoing.target !== senderPeerId) return;
      const missing = [...new Set(payload.missing)].filter(index => index < outgoing.chunks);
      if (missing.length === 0) return;
      if (outgoing.retry_rounds >= 3) {
        this.outgoingFiles.delete(payload.transfer_id);
        this.emitFileProgress({
          ...outgoing,
          direction: 'outgoing',
          transferred: 0,
          progress: 0,
          status: 'failed',
          error: 'Encrypted relay file remained incomplete after three retry rounds.',
        });
        return;
      }
      outgoing.retry_rounds += 1;
      void this.sendFileChunks(outgoing, missing);
      return;
    }
    if (payload.type === 'file_chunks_complete') {
      const incoming = this.incomingFiles.get(payload.transfer_id);
      if (!incoming || incoming.peer_id !== senderPeerId || incoming.chunksByIndex.size === incoming.chunks) return;
      const missing = Array.from({ length: incoming.chunks }, (_, index) => index)
        .filter(index => !incoming.chunksByIndex.has(index));
      const targetKey = relayPublicKey(senderPeerId);
      if (targetKey && missing.length > 0) {
        this.publishEncrypted(targetKey, {
          v: 1,
          ns: NAMESPACE,
          type: 'file_missing',
          session: this.session,
          sent_at: Date.now(),
          transfer_id: payload.transfer_id,
          missing,
        });
      }
      return;
    }
    if (payload.type !== 'file_chunk') return;
    const incoming = this.incomingFiles.get(payload.transfer_id);
    if (!incoming || incoming.peer_id !== senderPeerId || payload.index >= incoming.chunks) return;
    const bytes = base64ToBytes(payload.data);
    if (!bytes) return;
    const expected = payload.index + 1 === incoming.chunks
      ? incoming.size - payload.index * RELAY_FILE_CHUNK_BYTES
      : RELAY_FILE_CHUNK_BYTES;
    if (bytes.byteLength !== expected || incoming.chunksByIndex.has(payload.index)) return;
    incoming.chunksByIndex.set(payload.index, payload.data);
    incoming.received += bytes.byteLength;
    this.emitFileProgress({
      ...incoming,
      direction: 'incoming',
      transferred: incoming.received,
      progress: incoming.size === 0 ? 100 : (incoming.received / incoming.size) * 100,
      status: incoming.chunksByIndex.size === incoming.chunks ? 'verifying' : 'transferring',
    });
    if (incoming.chunksByIndex.size !== incoming.chunks) return;
    const combined = new Uint8Array(incoming.size);
    let offset = 0;
    for (let index = 0; index < incoming.chunks; index += 1) {
      const chunk = base64ToBytes(incoming.chunksByIndex.get(index) ?? '');
      if (!chunk) return;
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.callbacks?.onFileReady?.({ ...incoming, data_base64: bytesToBase64(combined) });
  }

  private sweep(): void {
    const now = Date.now();
    const cutoff = now - PRESENCE_TTL_MS;
    for (const [peerId, presence] of this.presence) {
      if (presence.seenAt < cutoff) {
        this.presence.delete(peerId);
        this.callbacks?.onOffline(peerId);
      }
    }
    while (this.pending.length && this.pending[0].until <= now) this.pending.shift();
  }

  private emitState(): void {
    this.callbacks?.onState({
      connected: [...this.sockets.values()].filter(state => state.socket?.readyState === WebSocket.OPEN).length,
      total: RELAYS.length,
    });
  }
}
