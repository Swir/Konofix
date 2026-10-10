// Manual two-client acceptance test for the exact browser bridge implementation.
// Run with: node --experimental-strip-types scripts/test-world-relay-live.mjs

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

globalThis.window = globalThis;
const { WorldRelayBridge } = await import('../src/world-relay.ts');

globalThis.localStorage = new MemoryStorage();
const alice = new WorldRelayBridge();
globalThis.localStorage = new MemoryStorage();
const bob = new WorldRelayBridge();

let aliceState = { connected: 0, total: 0 };
let bobState = { connected: 0, total: 0 };
let aliceSawBob = false;
let bobSawAlice = false;
const received = [];
const alicePeer = '12D3KooWLiveRelayAlice111111111111111111111111111';
const bobPeer = '12D3KooWLiveRelayBob22222222222222222222222222222';
const messageId = crypto.randomUUID();

alice.start(alicePeer, 'Alice_live', '#35d07f', {
  onPresence(peer) { if (peer.claimed_peer_id === bobPeer) aliceSawBob = true; },
  onOffline() {},
  onChat() {},
  onState(state) { aliceState = state; },
});
bob.start(bobPeer, 'Bob_live', '#4f7cff', {
  onPresence(peer) { if (peer.claimed_peer_id === alicePeer) bobSawAlice = true; },
  onOffline() {},
  onChat(message) { if (message.id === messageId) received.push(message); },
  onState(state) { bobState = state; },
});

const waitUntil = async (predicate, timeout, label) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  await waitUntil(() => aliceState.connected >= 2 && bobState.connected >= 2, 20_000, 'two relay connections per client');
  await waitUntil(() => aliceSawBob && bobSawAlice, 15_000, 'mutual signed presence');
  alice.publishChat({
    id: messageId,
    kind: 'chat',
    peer_id: alicePeer,
    nick: 'Alice_live',
    nick_color: '#35d07f',
    room: 'world',
    text: 'Konofix live WORLD relay acceptance',
    timestamp: Date.now(),
  });
  await waitUntil(() => received.length > 0, 15_000, 'WORLD chat delivery');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  if (received.length !== 1) throw new Error(`Expected one deduplicated chat event, received ${received.length}`);
  console.log(JSON.stringify({
    result: 'PASS',
    alice_relays: aliceState.connected,
    bob_relays: bobState.connected,
    mutual_presence: aliceSawBob && bobSawAlice,
    deduplicated_chat_events: received.length,
  }));
} finally {
  alice.stop();
  bob.stop();
}
