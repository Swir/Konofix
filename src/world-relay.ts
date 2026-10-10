import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/core';

const EVENT_KIND = 28_733; // NIP-01 ephemeral range: compliant relays should not retain history.
const TOPIC = 'konofix-world-v1';
const NAMESPACE = 'konofix/world-relay/1';
const SECRET_STORAGE_KEY = 'konofix.worldRelaySecret.v1';
const PRESENCE_TTL_MS = 75_000;
const MESSAGE_TTL_MS = 120_000;
const MAX_CONTENT_BYTES = 12 * 1024;
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

type Callbacks = {
  onPresence(peer: RelayPeer): void;
  onOffline(peerId: string): void;
  onChat(message: RelayChatMessage): void;
  onState(state: RelayState): void;
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

type RemotePresence = { peer: RelayPeer; seenAt: number };

type RelaySocket = {
  url: string;
  socket?: WebSocket;
  reconnect?: number;
  failures: number;
};

type PendingEvent = { wire: string; until: number; sent: Set<string> };

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
    this.emitState();
    this.callbacks = undefined;
  }

  publishChat(message: RelayChatMessage): void {
    if (!this.running || message.room !== 'world' || message.peer_id !== this.peerId) return;
    this.publish('chat', message);
  }

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
    if (typeof data !== 'string' || data.length > MAX_CONTENT_BYTES * 2) return;
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
