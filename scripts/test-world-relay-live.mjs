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
let aliceRelayPeer = '';
let bobRelayPeer = '';
const received = [];
const privateReceived = [];
const fileOffers = [];
const filesReady = [];
const outgoingFileStates = [];
const runId = crypto.randomUUID().replaceAll('-', '');
const alicePeer = `12D3KooWLiveRelayAlice${runId}`;
const bobPeer = `12D3KooWLiveRelayBob${runId}`;
const messageId = crypto.randomUUID();

alice.start(alicePeer, 'Alice_live', '#35d07f', {
  onPresence(peer) {
    if (peer.claimed_peer_id === bobPeer) {
      aliceSawBob = true;
      aliceRelayPeer = peer.peer_id;
    }
  },
  onOffline() {},
  onChat() {},
  onState(state) { aliceState = state; },
  onPrivate(message) { privateReceived.push({ recipient: 'alice', message }); },
  onFileProgress(progress) { outgoingFileStates.push(progress); },
});
bob.start(bobPeer, 'Bob_live', '#4f7cff', {
  onPresence(peer) {
    if (peer.claimed_peer_id === alicePeer) {
      bobSawAlice = true;
      bobRelayPeer = peer.peer_id;
    }
  },
  onOffline() {},
  onChat(message) { if (message.id === messageId) received.push(message); },
  onState(state) { bobState = state; },
  onPrivate(message) { privateReceived.push({ recipient: 'bob', message }); },
  onFileOffer(offer) {
    fileOffers.push(offer);
    bob.acceptFile(offer.transfer_id);
  },
  onFileReady(file) {
    filesReady.push(file);
    bob.confirmFileSaved(file.transfer_id, file.peer_id);
  },
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
  if (aliceRelayPeer !== bob.virtualPeerId() || bobRelayPeer !== alice.virtualPeerId()) {
    throw new Error('Relay presence resolved to the wrong encryption identity.');
  }
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

  const alicePrivate = alice.publishPrivate(aliceRelayPeer, 'Konofix encrypted private acceptance');
  await waitUntil(
    () => privateReceived.some(entry => entry.recipient === 'bob' && entry.message.id === alicePrivate.id),
    15_000,
    'Alice-to-Bob encrypted private delivery',
  );
  const bobPrivate = bob.publishPrivate(bobRelayPeer, 'Konofix encrypted private reply');
  await waitUntil(
    () => privateReceived.some(entry => entry.recipient === 'alice' && entry.message.id === bobPrivate.id),
    15_000,
    'Bob-to-Alice encrypted private delivery',
  );

  const fileBytes = new TextEncoder().encode('Konofix encrypted relay file acceptance');
  const fileSha = Buffer.from(await crypto.subtle.digest('SHA-256', fileBytes)).toString('hex');
  const file = alice.offerFile(aliceRelayPeer, {
    file_name: 'konofix-live.txt',
    size: fileBytes.byteLength,
    sha256: fileSha,
    data_base64: Buffer.from(fileBytes).toString('base64'),
  });
  await waitUntil(() => fileOffers.some(offer => offer.transfer_id === file.transfer_id), 15_000, 'encrypted file offer');
  await waitUntil(() => filesReady.some(ready => ready.transfer_id === file.transfer_id), 15_000, 'encrypted file bytes');
  await waitUntil(
    () => outgoingFileStates.some(progress => progress.transfer_id === file.transfer_id && progress.status === 'completed'),
    15_000,
    'encrypted file save acknowledgement',
  );
  console.log(JSON.stringify({
    result: 'PASS',
    alice_relays: aliceState.connected,
    bob_relays: bobState.connected,
    mutual_presence: aliceSawBob && bobSawAlice,
    deduplicated_chat_events: received.length,
    bidirectional_private_messages: privateReceived.length,
    encrypted_file_offers: fileOffers.length,
    encrypted_files_ready: filesReady.length,
    encrypted_file_saved: true,
  }));
} finally {
  alice.stop();
  bob.stop();
}
