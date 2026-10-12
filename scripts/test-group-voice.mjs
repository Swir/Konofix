import assert from 'node:assert/strict';

globalThis.window = globalThis;

class MockTrack {
  enabled = true;
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}

class MockStream {
  constructor(tracks = [new MockTrack()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class MockPeerConnection {
  static nextId = 1;
  static registry = new Map();
  static configs = [];
  id = MockPeerConnection.nextId++;
  tracks = [];
  candidates = [];
  localDescription = null;
  remoteDescription = null;
  connectionState = 'new';
  onicecandidate;
  ontrack;
  onconnectionstatechange;
  remote;
  constructor(config) {
    MockPeerConnection.configs.push(config);
    MockPeerConnection.registry.set(this.id, this);
  }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  async createOffer() { return { type: 'offer', sdp: `v=0\r\na=mock-group:${this.id}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=mock-group:${this.id}\r\na=answer` }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    const id = Number(/a=mock-group:(\d+)/.exec(description.sdp)?.[1]);
    const remote = MockPeerConnection.registry.get(id);
    if (!remote) throw new Error('missing group mock remote');
    this.remote = remote;
    remote.remote = this;
    if (description.type === 'answer') {
      this.connectionState = 'connected';
      remote.connectionState = 'connected';
      queueMicrotask(() => {
        this.onconnectionstatechange?.();
        remote.onconnectionstatechange?.();
        for (const { stream } of this.tracks) remote.ontrack?.({ streams: [stream], track: stream.getTracks()[0] });
        for (const { stream } of remote.tracks) this.ontrack?.({ streams: [stream], track: stream.getTracks()[0] });
      });
    }
  }
  async addIceCandidate(candidate) { this.candidates.push(candidate); }
  close() { this.connectionState = 'closed'; MockPeerConnection.registry.delete(this.id); }
}

globalThis.RTCPeerConnection = MockPeerConnection;
globalThis.MediaStream = MockStream;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { async getUserMedia() { return new MockStream(); } } },
});

const { GroupVoice } = await import('../src/group-voice.ts');
const alice = new GroupVoice();
const bob = new GroupVoice();
const aliceId = `nostr:${'a'.repeat(64)}`;
const bobId = `nostr:${'b'.repeat(64)}`;
let bobWorldAudio = 0;
let aliceWorldAudio = 0;
let aliceRoomAudio = 0;
let bobRoomAudio = 0;
let bobSnapshot;

alice.start(aliceId, 'Alice', '#35d07f', {
  sendSignal(_peerId, signal) { queueMicrotask(() => void bob.handleSignal(aliceId, signal)); },
  publishWorld(state) {
    // The public relay idle event can arrive later. The direct world_release
    // signal must still unlock the next person immediately.
    if (state.status !== 'idle') bob.updateWorldState({ ...state, peer_id: aliceId, nick: 'Alice', nick_color: '#35d07f' });
  },
  peers() { return [bobId]; },
  onRemoteStream(scope, _peerId, stream) {
    if (scope === 'world' && stream) aliceWorldAudio += 1;
    if (scope === 'test-room' && stream) aliceRoomAudio += 1;
  },
  onState() {},
});
bob.start(bobId, 'Bob', '#4f7cff', {
  sendSignal(_peerId, signal) { queueMicrotask(() => void alice.handleSignal(bobId, signal)); },
  publishWorld(state) { alice.updateWorldState({ ...state, peer_id: bobId, nick: 'Bob', nick_color: '#4f7cff' }); },
  peers() { return [aliceId]; },
  onRemoteStream(scope, _peerId, stream) {
    if (scope === 'world' && stream) bobWorldAudio += 1;
    if (scope === 'test-room' && stream) bobRoomAudio += 1;
  },
  onState(snapshot) { bobSnapshot = snapshot; },
});

await alice.requestWorldTurn();
for (let attempt = 0; attempt < 200 && bobWorldAudio === 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(bobSnapshot.speaker?.nick, 'Alice', 'signed queue state must identify the current WORLD speaker');
assert.ok(bobSnapshot.secondsLeft > 0 && bobSnapshot.secondsLeft <= 60, 'WORLD turn must expose a bounded visible countdown');
assert.equal(bobWorldAudio, 1, 'WORLD speaker audio must reach a passive listener');
assert.ok(MockPeerConnection.configs[0].iceServers.some(server => String(server.urls).includes('turn:openrelay.metered.ca')), 'group audio must offer a TURN route for LTE and symmetric NAT');

await bob.requestWorldTurn();
assert.equal(bob.snapshot().localWorld?.status, 'queued', 'a second speaker must wait while the current turn is active');
assert.equal(bob.snapshot().canStartWorld, false);

alice.leaveWorld();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(bob.snapshot().speaker, undefined, 'leaving a turn must release WORLD for the next queued person');
assert.equal(bob.snapshot().canStartWorld, true, 'a direct release must immediately unlock the next queued speaker');

await bob.startWorldTurn();
for (let attempt = 0; attempt < 200 && aliceWorldAudio === 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(aliceWorldAudio, 1, 'the next queued speaker must take over and reach the previous speaker');
bob.leaveWorld();

await alice.joinRoom('test-room');
await bob.joinRoom('test-room');
for (let attempt = 0; attempt < 100 && (aliceRoomAudio === 0 || bobRoomAudio === 0); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(aliceRoomAudio, 1, 'room voice must carry Bob microphone audio to Alice');
assert.equal(bobRoomAudio, 1, 'room voice must carry Alice microphone audio to Bob');
assert.equal(alice.snapshot().secondsLeft, 0, 'private room group voice must not use the WORLD timer');

alice.stop();
bob.stop();
console.log('Group voice test passed: TURN audio, immediate early release, queued takeover and simultaneous room audio.');
