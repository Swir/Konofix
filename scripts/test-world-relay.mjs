import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static sockets = [];
  static dropNextTarget = '';
  static droppedEventId = '';
  readyState = MockWebSocket.CONNECTING;
  listeners = new Map();
  subscribed = false;

  constructor(url) {
    this.url = url;
    MockWebSocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(raw) {
    const frame = JSON.parse(raw);
    if (frame[0] === 'REQ') {
      this.subscribed = true;
      return;
    }
    if (frame[0] !== 'EVENT') return;
    const event = frame[1];
    const target = event.tags.find(tag => tag[0] === 'p')?.[1] ?? '';
    if (event.id === MockWebSocket.droppedEventId
      || (!MockWebSocket.droppedEventId && target === MockWebSocket.dropNextTarget)) {
      MockWebSocket.droppedEventId = event.id;
      MockWebSocket.dropNextTarget = '';
      return;
    }
    for (const socket of MockWebSocket.sockets) {
      if (socket.readyState !== MockWebSocket.OPEN || !socket.subscribed) continue;
      // Four relays may deliver the same signed event. Deliver twice here as
      // an adversarial duplicate as well; the bridge must emit it once.
      socket.emit('message', { data: JSON.stringify(['EVENT', 'mock-sub', event]) });
      socket.emit('message', { data: JSON.stringify(['EVENT', 'mock-sub', event]) });
    }
    this.emit('message', { data: JSON.stringify(['OK', event.id, true, '']) });
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return true;
}

globalThis.window = globalThis;
globalThis.WebSocket = MockWebSocket;
const { WorldRelayBridge } = await import('../src/world-relay.ts');

globalThis.localStorage = new MemoryStorage();
const alice = new WorldRelayBridge();
globalThis.localStorage = new MemoryStorage();
const bob = new WorldRelayBridge();

const alicePeer = '12D3KooWUnitRelayAlice111111111111111111111111111';
const bobPeer = '12D3KooWUnitRelayBob22222222222222222222222222222';
let alicePresence = 0;
let bobPresence = 0;
let bobChats = 0;
let bobOffline = 0;
let aliceConnections = 0;
let bobConnections = 0;
let bobPrivate = 0;
let bobFileReady = 0;
let aliceFileCompleted = 0;
let bobRtcSignals = 0;
let bobRooms = 0;
let bobRoomMessages = 0;
let bobRoomClosed = 0;
let bobPublicFiles = 0;
let bobWorldVoice = 0;
let bobVoiceSignals = 0;
let expectedRelayFile;

alice.start(alicePeer, 'Alice_test', '#35d07f', {
  onPresence(peer) { if (peer.claimed_peer_id === bobPeer) alicePresence += 1; },
  onOffline() {},
  onChat(message) { if (message.text === 'public room relay test') bobRoomMessages += 1; },
  onState(state) { aliceConnections = state.connected; },
  onFileProgress(progress) {
    if (progress.status === 'completed') aliceFileCompleted += 1;
  },
});
bob.start(bobPeer, 'Bob_test', '#4f7cff', {
  onPresence(peer) { if (peer.claimed_peer_id === alicePeer) bobPresence += 1; },
  onOffline(peerId) { if (peerId === alice.virtualPeerId()) bobOffline += 1; },
  onChat(message) { if (message.text === 'signed relay test') bobChats += 1; },
  onRoom(room) { if (room.id === 'norway' && room.title === '# Norway') bobRooms += 1; },
  onRoomClosed(roomId) { if (roomId === 'norway') bobRoomClosed += 1; },
  onState(state) { bobConnections = state.connected; },
  onPrivate(message) {
    if (message.text === 'encrypted private test'
      && message.peer_id === alice.virtualPeerId()
      && message.target_peer_id === bob.virtualPeerId()) bobPrivate += 1;
  },
  onRtcSignal(peerId, signal) {
    if (peerId === alice.virtualPeerId()
      && signal.action === 'offer'
      && signal.sdp === 'v=0\r\nunit-test') bobRtcSignals += 1;
  },
  onPublicFile(offer) {
    if (offer.peer_id === alice.virtualPeerId()
      && offer.file_name === 'world-large.zip'
      && offer.sha256 === 'a'.repeat(64)) bobPublicFiles += 1;
  },
  onWorldVoice(state) {
    if (state.peer_id === alice.virtualPeerId()
      && state.status === 'queued'
      && state.nick === 'Alice_test') bobWorldVoice += 1;
  },
  onVoiceSignal(peerId, signal) {
    if (peerId === alice.virtualPeerId()
      && signal.action === 'join'
      && signal.scope === 'norway') bobVoiceSignals += 1;
  },
  onFileOffer(offer) {
    MockWebSocket.dropNextTarget = bob.virtualPeerId().slice('nostr:'.length);
    MockWebSocket.droppedEventId = '';
    bob.acceptFile(offer.transfer_id);
  },
  onFileReady(file) {
    const decoded = Buffer.from(file.data_base64, 'base64');
    if (expectedRelayFile && decoded.equals(expectedRelayFile)) bobFileReady += 1;
    bob.confirmFileSaved(file.transfer_id, file.peer_id);
  },
});

await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(aliceConnections, 4);
assert.equal(bobConnections, 4);
assert.equal(alicePresence, 1, 'duplicate relay presence must be deduplicated');
assert.equal(bobPresence, 1, 'duplicate relay presence must be deduplicated');

alice.publishChat({
  id: crypto.randomUUID(),
  kind: 'chat',
  peer_id: alicePeer,
  nick: 'Alice_test',
  nick_color: '#35d07f',
  room: 'world',
  text: 'signed relay test',
  timestamp: Date.now(),
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobChats, 1, 'one signed chat must be emitted once across duplicate relays');

alice.publishRoom({ id: 'norway', title: '# Norway', password_protected: false });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobRooms, 1, 'a public room announcement must be emitted once across duplicate relays');
assert.throws(
  () => alice.publishRoom({ id: 'private-room', title: '# Private room', password_protected: true }),
  /not announced publicly/,
  'password-protected rooms must fail closed instead of entering the public fallback',
);

globalThis.localStorage = new MemoryStorage();
const latePeer = new WorldRelayBridge();
let lateRooms = 0;
latePeer.start('12D3KooWLatePeer555555555555555555555555555555', 'Late_peer', '#bb66ff', {
  onPresence() {},
  onOffline() {},
  onChat() {},
  onRoom(room) { if (room.id === 'norway') lateRooms += 1; },
  onState() {},
});
await new Promise(resolve => setTimeout(resolve, 120));
assert.equal(lateRooms, 1, 'a late WAN peer must receive owned public rooms with the presence response');

bob.publishRoomChat({
  id: crypto.randomUUID(),
  kind: 'chat',
  peer_id: bobPeer,
  nick: 'Bob_test',
  nick_color: '#4f7cff',
  room: 'norway',
  text: 'public room relay test',
  timestamp: Date.now(),
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobRoomMessages, 1, 'public room chat must reach another WAN relay peer once');

alice.closeRoom('norway');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobRoomClosed, 1, 'closing a public room must remove it from relay peers');
latePeer.stop();

alice.publishPrivate(bob.virtualPeerId(), 'encrypted private test');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobPrivate, 1, 'one NIP-44 private message must be decrypted only by its recipient');

alice.publishRtcSignal(bob.virtualPeerId(), {
  connection_id: crypto.randomUUID(),
  action: 'offer',
  sdp: 'v=0\r\nunit-test',
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobRtcSignals, 1, 'encrypted WebRTC signaling must reach only the addressed live identity once');

const publicFileNow = Date.now();
alice.publishPublicFile({
  offer_id: crypto.randomUUID(),
  peer_id: alicePeer,
  nick: 'Alice_test',
  nick_color: '#35d07f',
  file_name: 'world-large.zip',
  size: 25 * 1024 * 1024,
  sha256: 'a'.repeat(64),
  kind: 'file',
  timestamp: publicFileNow,
  expires_at: publicFileNow + 10 * 60_000,
});
alice.publishWorldVoice({
  status: 'queued',
  request_id: crypto.randomUUID(),
  joined_at: Date.now(),
});
alice.publishVoiceSignal(bob.virtualPeerId(), {
  connection_id: crypto.randomUUID(),
  action: 'join',
  scope: 'norway',
  reply: false,
});
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(bobPublicFiles, 1, 'signed WORLD file metadata must cross WAN relays exactly once');
assert.equal(bobWorldVoice, 1, 'signed WORLD speaking queue state must cross relays exactly once');
assert.equal(bobVoiceSignals, 1, 'room voice signaling must stay encrypted and recipient-addressed');

const relayFile = Buffer.alloc(40 * 1024);
for (let index = 0; index < relayFile.length; index += 1) relayFile[index] = index % 251;
expectedRelayFile = relayFile;
alice.offerFile(bob.virtualPeerId(), {
  file_name: 'relay-test.txt',
  size: relayFile.length,
  sha256: createHash('sha256').update(relayFile).digest('hex'),
  data_base64: relayFile.toString('base64'),
});
await new Promise(resolve => setTimeout(resolve, 500));
assert.equal(bobFileReady, 1, 'accepted encrypted relay file must be reassembled once');
assert.equal(aliceFileCompleted, 1, 'sender must receive the encrypted file saved acknowledgement');
assert.ok(MockWebSocket.droppedEventId, 'test must drop one encrypted chunk across all relays and recover it');

alice.stop();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobOffline, 1, 'signed goodbye must remove relay presence once');
bob.stop();

globalThis.localStorage = new MemoryStorage();
const staleAlice = new WorldRelayBridge();
globalThis.localStorage = new MemoryStorage();
const freshAlice = new WorldRelayBridge();
globalThis.localStorage = new MemoryStorage();
const observerBob = new WorldRelayBridge();
const rotatedAlicePeer = '12D3KooWRotatedAlice3333333333333333333333333333';
const observerBobPeer = '12D3KooWObserverBob4444444444444444444444444444';
let activeAliceRelayPeer = '';
let staleAliceRetired = 0;
let staleAlicePrivate = 0;
let freshAlicePrivate = 0;
let freshAliceSeesObserver = false;

observerBob.start(observerBobPeer, 'Bob_observer', '#4f7cff', {
  onPresence(peer) {
    if (peer.claimed_peer_id === rotatedAlicePeer) activeAliceRelayPeer = peer.peer_id;
  },
  onOffline(peerId) {
    if (peerId === staleAlice.virtualPeerId()) staleAliceRetired += 1;
  },
  onChat() {},
  onState() {},
});
staleAlice.start(rotatedAlicePeer, 'Alice_old', '#35d07f', {
  onPresence() {},
  onOffline() {},
  onChat() {},
  onState() {},
  onPrivate() { staleAlicePrivate += 1; },
});
assert.equal(
  await waitFor(() => activeAliceRelayPeer === staleAlice.virtualPeerId()),
  true,
  'observer must discover the original relay identity',
);

freshAlice.start(rotatedAlicePeer, 'Alice_new', '#35d07f', {
  onPresence(peer) {
    if (peer.claimed_peer_id === observerBobPeer) freshAliceSeesObserver = true;
  },
  onOffline() {},
  onChat() {},
  onState() {},
  onPrivate() { freshAlicePrivate += 1; },
});
assert.equal(
  await waitFor(() => staleAliceRetired === 1
    && activeAliceRelayPeer === freshAlice.virtualPeerId()
    && freshAliceSeesObserver),
  true,
  'a newer relay identity must retire the stale route and become active',
);

observerBob.publishPrivate(activeAliceRelayPeer, 'identity rotation private test');
assert.equal(
  await waitFor(() => freshAlicePrivate === 1),
  true,
  'private delivery must reach the newest relay identity',
);
assert.equal(staleAlicePrivate, 0, 'private delivery must not target the retired relay identity');

staleAlice.stop();
freshAlice.stop();
observerBob.stop();

console.log('WORLD relay unit test passed: public rooms/chat, late discovery, signed WORLD, NIP-44 private chat/file/signaling, deduplication and cleanup.');
const peerTransport = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-peer-transport.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(peerTransport.status, 0, 'peer transport integration test must pass');
const groupVoice = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-group-voice.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(groupVoice.status, 0, 'group voice integration test must pass');
const i18n = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-i18n.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(i18n.status, 0, 'automatic language selection test must pass');
const callTones = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-call-tones.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(callTones.status, 0, 'call tone integration test must pass');
const audioDiagnostics = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-audio-diagnostics.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(audioDiagnostics.status, 0, 'audio diagnostics test must pass');
const stableUpdater = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-stable-updater.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
assert.equal(stableUpdater.status, 0, 'stable updater policy test must pass');
