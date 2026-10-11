import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

globalThis.window = globalThis;

class MockTrack {
  enabled = true;
  stopped = false;
  stop() { this.stopped = true; }
}

class MockStream {
  constructor(tracks = [new MockTrack()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class MockChannel extends EventTarget {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  peer;
  onopen;
  onmessage;
  onerror;
  onclose;
  send(data) {
    if (this.readyState !== 'open') throw new Error('mock channel is closed');
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
  open() {
    this.readyState = 'open';
    queueMicrotask(() => this.onopen?.());
  }
}

class MockPeerConnection {
  static nextId = 1;
  static registry = new Map();
  id = MockPeerConnection.nextId++;
  localDescription = null;
  remoteDescription = null;
  connectionState = 'new';
  onicecandidate;
  ontrack;
  onconnectionstatechange;
  ondatachannel;
  channel;
  tracks = [];
  candidates = [];
  remote;
  constructor() { MockPeerConnection.registry.set(this.id, this); }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  createDataChannel() { this.channel = new MockChannel(); return this.channel; }
  async createOffer() {
    const media = this.tracks.length ? 'audio' : 'application';
    return { type: 'offer', sdp: `v=0\r\na=mock-pc:${this.id}\r\nm=${media} 9 UDP/DTLS/SCTP mock` };
  }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=mock-pc:${this.id}\r\na=mock-answer` }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    const id = Number(/a=mock-pc:(\d+)/.exec(description.sdp)?.[1]);
    const remote = MockPeerConnection.registry.get(id);
    if (!remote) throw new Error('missing mock remote');
    this.remote = remote;
    remote.remote = this;
    if (description.type === 'offer' && remote.channel && !this.channel) {
      this.channel = new MockChannel();
      this.channel.peer = remote.channel;
      remote.channel.peer = this.channel;
      queueMicrotask(() => this.ondatachannel?.({ channel: this.channel }));
    }
    if (description.type === 'answer') {
      this.connectionState = 'connected';
      remote.connectionState = 'connected';
      this.channel?.open();
      remote.channel?.open();
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

const outgoingBytes = Buffer.alloc(2 * 1024 * 1024 + 123);
for (let index = 0; index < outgoingBytes.length; index += 1) outgoingBytes[index] = index % 251;
const token = randomUUID();
const sha256 = createHash('sha256').update(outgoingBytes).digest('hex');
const incoming = new Map();

globalThis.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    if (command === 'pick_rtc_file') return { token, file_name: 'large-test.bin', size: outgoingBytes.length, sha256 };
    if (command === 'read_rtc_file_chunk') {
      const data = outgoingBytes.subarray(args.offset, Math.min(outgoingBytes.length, args.offset + args.maxBytes));
      return { offset: args.offset, data_base64: data.toString('base64'), eof: args.offset + data.length === outgoingBytes.length };
    }
    if (command === 'begin_rtc_file_receive') { incoming.set(args.token, Buffer.alloc(0)); return null; }
    if (command === 'write_rtc_file_chunk') {
      const before = incoming.get(args.token);
      assert.equal(before.length, args.offset, 'receiver must persist ordered chunks');
      const after = Buffer.concat([before, Buffer.from(args.dataBase64, 'base64')]);
      incoming.set(args.token, after);
      return after.length;
    }
    if (command === 'finish_rtc_file_receive') {
      const bytes = incoming.get(args.token);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
      return 'C:\\Downloads\\Konofix Chat\\large-test.bin';
    }
    if (command === 'close_rtc_file') return null;
    throw new Error(`unexpected command: ${command}`);
  },
};

const { PeerTransport } = await import('../src/peer-transport.ts');
const alice = new PeerTransport();
const bob = new PeerTransport();
const aliceId = `nostr:${'a'.repeat(64)}`;
const bobId = `nostr:${'b'.repeat(64)}`;
const aliceStates = [];
const bobStates = [];
const fileStates = [];
let bobRemoteAudio = 0;

alice.start({
  sendSignal(_peerId, signal) { queueMicrotask(() => void bob.handleSignal(aliceId, signal)); },
  onIncomingCall() {},
  onCallState(_peerId, state) { aliceStates.push(state); },
  onRemoteAudio() {},
  onFileOffer() {},
  onFileProgress(progress) { fileStates.push(`alice:${progress.status}`); },
});
bob.start({
  sendSignal(_peerId, signal) { queueMicrotask(() => void alice.handleSignal(bobId, signal)); },
  onIncomingCall(_peerId, connectionId) { queueMicrotask(() => void bob.acceptCall(connectionId)); },
  onCallState(_peerId, state) { bobStates.push(state); },
  onRemoteAudio(_peerId, stream) { if (stream) bobRemoteAudio += 1; },
  onFileOffer(offer) { queueMicrotask(() => void bob.acceptFile(offer.token)); },
  onFileProgress(progress) { fileStates.push(`bob:${progress.status}`); },
});

await alice.sendFile(bobId);
for (let attempt = 0; attempt < 500 && !fileStates.includes('alice:completed'); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.equal(incoming.get(token)?.equals(outgoingBytes), true, 'a file above the legacy 2 MiB cap must stream intact');
assert.ok(fileStates.includes('bob:completed'), 'receiver must verify and complete the large file');
assert.ok(fileStates.includes('alice:completed'), 'sender must receive the saved acknowledgement');

const reorderedOfferer = new MockPeerConnection();
reorderedOfferer.createDataChannel();
const reorderedId = randomUUID();
await bob.handleSignal(aliceId, {
  connection_id: reorderedId,
  action: 'ice',
  candidate: 'candidate:unit-test',
  sdp_mid: '0',
  sdp_mline_index: 0,
});
const reorderedOffer = await reorderedOfferer.createOffer();
await bob.handleSignal(aliceId, { connection_id: reorderedId, action: 'offer', sdp: reorderedOffer.sdp });
const reorderedReceiver = [...MockPeerConnection.registry.values()].find(connection => connection.remote === reorderedOfferer);
assert.equal(reorderedReceiver?.candidates.length, 1, 'ICE arriving before the offer must be buffered and applied');

const unsolicitedAudio = new MockPeerConnection();
unsolicitedAudio.addTrack(new MockTrack(), new MockStream());
const sessionsBeforeAudioAttack = MockPeerConnection.registry.size;
const unsolicitedOffer = await unsolicitedAudio.createOffer();
await bob.handleSignal(aliceId, { connection_id: randomUUID(), action: 'offer', sdp: unsolicitedOffer.sdp });
assert.equal(MockPeerConnection.registry.size, sessionsBeforeAudioAttack, 'unsolicited audio SDP must not create a receiving session');

await alice.startCall(bobId);
for (let attempt = 0; attempt < 100 && !aliceStates.includes('connected'); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.ok(aliceStates.includes('connected'), 'caller audio must reach connected state');
assert.ok(bobStates.includes('connected'), 'recipient audio must reach connected state');
assert.equal(bobRemoteAudio, 1, 'recipient must receive one remote audio stream');

alice.hangup(bobId);
alice.stop();
bob.stop();
console.log('Peer transport test passed: >2 MiB streamed file integrity and consent-based direct audio signaling.');
