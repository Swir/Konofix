import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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
let expectedRelayFile;

alice.start(alicePeer, 'Alice_test', '#35d07f', {
  onPresence(peer) { if (peer.claimed_peer_id === bobPeer) alicePresence += 1; },
  onOffline() {},
  onChat() {},
  onState(state) { aliceConnections = state.connected; },
  onFileProgress(progress) {
    if (progress.status === 'completed') aliceFileCompleted += 1;
  },
});
bob.start(bobPeer, 'Bob_test', '#4f7cff', {
  onPresence(peer) { if (peer.claimed_peer_id === alicePeer) bobPresence += 1; },
  onOffline() { bobOffline += 1; },
  onChat(message) { if (message.text === 'signed relay test') bobChats += 1; },
  onState(state) { bobConnections = state.connected; },
  onPrivate(message) {
    if (message.text === 'encrypted private test'
      && message.peer_id === alice.virtualPeerId()
      && message.target_peer_id === bob.virtualPeerId()) bobPrivate += 1;
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

alice.publishPrivate(bob.virtualPeerId(), 'encrypted private test');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(bobPrivate, 1, 'one NIP-44 private message must be decrypted only by its recipient');

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

console.log('WORLD relay unit test passed: signed public chat, NIP-44 private chat/file fallback, deduplication and cleanup.');
