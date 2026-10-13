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

class MockPeerConnection extends EventTarget {
  static nextId = 1;
  static registry = new Map();
  static configs = [];
  static offerCount = 0;
  static deferNextGathering = false;
  id = MockPeerConnection.nextId++;
  localDescription = null;
  remoteDescription = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  iceGatheringState = 'new';
  onicecandidate;
  ontrack;
  onconnectionstatechange;
  oniceconnectionstatechange;
  ondatachannel;
  channel;
  tracks = [];
  candidates = [];
  gatheringDeferred = false;
  remote;
  constructor(config) {
    super();
    MockPeerConnection.configs.push(config);
    MockPeerConnection.registry.set(this.id, this);
  }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  createDataChannel() { this.channel = new MockChannel(); return this.channel; }
  async createOffer() {
    MockPeerConnection.offerCount += 1;
    const media = this.tracks.length ? 'audio' : 'application';
    return { type: 'offer', sdp: `v=0\r\na=mock-pc:${this.id}\r\nm=${media} 9 UDP/DTLS/SCTP mock` };
  }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=mock-pc:${this.id}\r\na=mock-answer` }; }
  async setLocalDescription(description) {
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('invalid local offer state');
      this.signalingState = 'have-local-offer';
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') throw new Error('invalid local answer state');
      this.signalingState = 'stable';
    }
    if (MockPeerConnection.deferNextGathering) {
      MockPeerConnection.deferNextGathering = false;
      this.gatheringDeferred = true;
      this.iceGatheringState = 'gathering';
      this.localDescription = { ...description };
    } else {
      this.iceGatheringState = 'complete';
      this.localDescription = {
        ...description,
        sdp: `${description.sdp}\r\na=candidate:mock-complete`,
      };
    }
  }
  completeIceGathering() {
    if (!this.gatheringDeferred) return;
    this.gatheringDeferred = false;
    this.iceGatheringState = 'complete';
    this.localDescription = {
      ...this.localDescription,
      sdp: `${this.localDescription.sdp}\r\na=candidate:mock-complete`,
    };
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
  async setRemoteDescription(description) {
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('invalid remote offer state');
      this.signalingState = 'have-remote-offer';
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error('duplicate or invalid remote answer');
      this.signalingState = 'stable';
    }
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
      this.iceConnectionState = 'connected';
      remote.connectionState = 'connected';
      remote.iceConnectionState = 'connected';
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
  async addIceCandidate(candidate) {
    if (candidate.candidate === 'candidate:reject-me') throw new Error('mock rejected stale ICE');
    this.candidates.push(candidate);
  }
  close() {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    MockPeerConnection.registry.delete(this.id);
  }
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
const unicodeFileName = `${'🧪'.repeat(100)}.bin`;
assert.ok(unicodeFileName.length > 180 && [...unicodeFileName].length <= 180,
  'the filename regression must distinguish UTF-16 units from Unicode characters');

globalThis.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    if (command === 'pick_rtc_file') return { token, file_name: unicodeFileName, size: outgoingBytes.length, sha256 };
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
assert.ok(MockPeerConnection.configs.length === 0, 'peer connections must be created only when a transfer or call begins');
const alice = new PeerTransport();
const bob = new PeerTransport();
const aliceId = `nostr:${'a'.repeat(64)}`;
const bobId = `nostr:${'b'.repeat(64)}`;
const aliceStates = [];
const bobStates = [];
const fileStates = [];
let bobRemoteAudio = 0;
let aliceRemoteAudio = 0;
const signaledDescriptions = [];
let droppedFirstOffer = false;
let droppedFirstCallAccept = false;
let acceptedCallConnectionId;
let deliveredCallAnswer;
let aliceOfferSignals = 0;
let aliceCallRequestSignals = 0;
let delayedIncomingCallConnectionId;
let delayFirstAudioAcceptance = true;
const aliceHangupSignals = [];
let aliceMicrophonePreparations = 0;
let bobMicrophonePreparations = 0;

alice.start({
  sendSignal(_peerId, signal) {
    if ((signal.action === 'offer' || signal.action === 'answer') && signal.sdp) signaledDescriptions.push(signal.sdp);
    if (signal.action === 'offer') aliceOfferSignals += 1;
    if (signal.action === 'offer' && !droppedFirstOffer) {
      droppedFirstOffer = true;
      return;
    }
    if (signal.action === 'call_request') aliceCallRequestSignals += 1;
    if (signal.action === 'hangup') aliceHangupSignals.push(signal.connection_id);
    queueMicrotask(() => void bob.handleSignal(aliceId, signal).then(() => {
      if (signal.action === 'call_request'
        && aliceCallRequestSignals === 3
        && delayedIncomingCallConnectionId === signal.connection_id) {
        delayFirstAudioAcceptance = false;
        void bob.acceptCall(signal.connection_id);
      }
    }));
  },
  beforeMicrophoneCapture() { aliceMicrophonePreparations += 1; },
  onIncomingCall() {},
  onCallState(_peerId, state) { aliceStates.push(state); },
  onRemoteAudio(_peerId, stream) { if (stream) aliceRemoteAudio += 1; },
  onFileOffer() {},
  onFileProgress(progress) { fileStates.push(`alice:${progress.status}`); },
});
bob.start({
  sendSignal(_peerId, signal) {
    if ((signal.action === 'offer' || signal.action === 'answer') && signal.sdp) signaledDescriptions.push(signal.sdp);
    if (signal.action === 'answer') deliveredCallAnswer = { ...signal };
    if (signal.action === 'call_accept' && !droppedFirstCallAccept) {
      droppedFirstCallAccept = true;
      return;
    }
    if (signal.action === 'call_accept') acceptedCallConnectionId = signal.connection_id;
    queueMicrotask(() => void alice.handleSignal(bobId, signal));
  },
  beforeMicrophoneCapture() { bobMicrophonePreparations += 1; },
  onIncomingCall(_peerId, connectionId) {
    delayedIncomingCallConnectionId = connectionId;
    if (!delayFirstAudioAcceptance) queueMicrotask(() => void bob.acceptCall(connectionId));
  },
  onCallState(_peerId, state) { bobStates.push(state); },
  onRemoteAudio(_peerId, stream) { if (stream) bobRemoteAudio += 1; },
  onFileOffer(offer) { queueMicrotask(() => void bob.acceptFile(offer.token)); },
  onFileProgress(progress) { fileStates.push(`bob:${progress.status}`); },
});

await alice.sendFile(bobId);
for (let attempt = 0; attempt < 1_000 && !fileStates.includes('alice:completed'); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.equal(incoming.get(token)?.equals(outgoingBytes), true, 'a file above the legacy 2 MiB cap must stream intact');
assert.ok(fileStates.includes('bob:completed'), 'receiver must verify and complete the large file');
assert.ok(fileStates.includes('alice:completed'), 'sender must receive the saved acknowledgement');
assert.equal(droppedFirstOffer, true, 'the regression must drop the first WAN offer');

MockPeerConnection.deferNextGathering = true;
const offersBeforeCancelledGathering = aliceOfferSignals;
const cancelledSend = alice.sendFile(bobId);
let gatheringSession;
for (let attempt = 0; attempt < 100 && !gatheringSession; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
  gatheringSession = [...MockPeerConnection.registry.values()].find(connection => connection.gatheringDeferred);
}
assert.ok(gatheringSession, 'the cancellation regression must pause ICE gathering');
await alice.cancelFile(token);
gatheringSession.completeIceGathering();
await cancelledSend;
assert.equal(aliceOfferSignals, offersBeforeCancelledGathering, 'cancelling during ICE gathering must not emit a ghost SDP offer');

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
for (let attempt = 0; attempt < 2_000 && !aliceStates.includes('connected'); attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.ok(aliceStates.includes('connected'), 'caller audio must reach connected state');
assert.ok(bobStates.includes('connected'), 'recipient audio must reach connected state');
assert.equal(aliceCallRequestSignals, 3, 'the recipient must answer only after the caller has exhausted request retries');
assert.equal(droppedFirstCallAccept, true, 'the regression must drop the first call acceptance and recover by retry');
assert.equal(aliceRemoteAudio, 1, 'caller must receive the recipient microphone stream');
assert.equal(bobRemoteAudio, 1, 'recipient must receive one remote audio stream');
assert.equal(aliceMicrophonePreparations, 1, 'caller must release competing group microphone ownership before capture');
assert.equal(bobMicrophonePreparations, 1, 'recipient must release competing group microphone ownership before accepting');
assert.ok(acceptedCallConnectionId, 'the delivered acceptance must identify the active call');
const offersBeforeDuplicateAccept = MockPeerConnection.offerCount;
await alice.handleSignal(bobId, { connection_id: acceptedCallConnectionId, action: 'call_accept' });
assert.equal(MockPeerConnection.offerCount, offersBeforeDuplicateAccept, 'a duplicate call acceptance must not renegotiate the active call');
assert.ok(deliveredCallAnswer, 'the recipient must deliver an SDP answer');
await alice.handleSignal(bobId, deliveredCallAnswer);
await alice.handleSignal(bobId, {
  connection_id: acceptedCallConnectionId,
  action: 'ice',
  candidate: 'candidate:reject-me',
  sdp_mid: '0',
  sdp_mline_index: 0,
});
const statesBeforeStaleControl = aliceStates.length;
await alice.handleSignal(bobId, { connection_id: randomUUID(), action: 'call_reject' });
await alice.handleSignal(bobId, { connection_id: randomUUID(), action: 'hangup' });
assert.equal(aliceStates.length, statesBeforeStaleControl, 'stale call control must not end a newer conversation with the same peer');
const firstAudioSession = alice.sessions.get(acceptedCallConnectionId);
assert.ok(firstAudioSession?.established, 'the transient disconnect regression requires an established audio session');
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(
  callback,
  delay === 8_000 ? 15 : delay,
  ...args,
);
try {
  firstAudioSession.pc.connectionState = 'disconnected';
  firstAudioSession.pc.iceConnectionState = 'disconnected';
  firstAudioSession.pc.onconnectionstatechange?.();
  firstAudioSession.pc.connectionState = 'connected';
  firstAudioSession.pc.iceConnectionState = 'completed';
  firstAudioSession.pc.oniceconnectionstatechange?.();
  await new Promise(resolve => realSetTimeout(resolve, 30));
} finally {
  globalThis.setTimeout = realSetTimeout;
}
assert.equal(alice.sessions.get(acceptedCallConnectionId), firstAudioSession, 'a transient disconnect followed by ICE recovery must preserve the call');
assert.ok(
  signaledDescriptions.length > 0 && signaledDescriptions.every(sdp => sdp.includes('a=candidate:mock-complete')),
  'offers and answers must carry gathered ICE candidates in SDP instead of relying only on lossy trickle events',
);

alice.hangupAllCalls();
await new Promise(resolve => setTimeout(resolve, 5));
assert.ok(aliceStates.includes('ended'), 'hangupAllCalls must end an active private audio call');
assert.ok(bobStates.includes('ended'), 'hangupAllCalls must notify the remote private audio peer');

async function startConnectedAudioCall() {
  const previousConnectionId = acceptedCallConnectionId;
  await alice.startCall(bobId);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (acceptedCallConnectionId
      && acceptedCallConnectionId !== previousConnectionId
      && alice.sessions.get(acceptedCallConnectionId)?.established
      && bob.sessions.get(acceptedCallConnectionId)?.established) return acceptedCallConnectionId;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('follow-up audio call did not connect');
}

const persistentDisconnectId = await startConnectedAudioCall();
const persistentAliceSession = alice.sessions.get(persistentDisconnectId);
const persistentBobSession = bob.sessions.get(persistentDisconnectId);
const persistentAliceTrack = persistentAliceSession.localStream.getTracks()[0];
const persistentBobTrack = persistentBobSession.localStream.getTracks()[0];
const persistentAliceStateStart = aliceStates.length;
const persistentBobStateStart = bobStates.length;
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(
  callback,
  delay === 8_000 ? 15 : delay,
  ...args,
);
try {
  persistentAliceSession.pc.connectionState = 'disconnected';
  persistentAliceSession.pc.iceConnectionState = 'disconnected';
  persistentAliceSession.pc.onconnectionstatechange?.();
  await new Promise(resolve => realSetTimeout(resolve, 30));
} finally {
  globalThis.setTimeout = realSetTimeout;
}
await Promise.resolve();
assert.equal(alice.sessions.has(persistentDisconnectId), false, 'a persistent disconnect must close the local audio session after grace');
assert.equal(bob.sessions.has(persistentDisconnectId), false, 'a persistent disconnect must deliver exact hangup and close the remote session');
assert.equal(aliceHangupSignals.filter(id => id === persistentDisconnectId).length, 1, 'persistent disconnect must signal one exact hangup');
assert.ok(aliceStates.slice(persistentAliceStateStart).includes('failed'), 'persistent disconnect must expose a local failed state');
assert.ok(bobStates.slice(persistentBobStateStart).includes('ended'), 'persistent disconnect must expose a remote ended state');
assert.equal(persistentAliceTrack.stopped, true, 'persistent disconnect must release the local microphone');
assert.equal(persistentBobTrack.stopped, true, 'persistent disconnect hangup must release the remote microphone');

const failedConnectionId = await startConnectedAudioCall();
const failedAliceSession = alice.sessions.get(failedConnectionId);
const failedBobSession = bob.sessions.get(failedConnectionId);
const failedAliceTrack = failedAliceSession.localStream.getTracks()[0];
const failedBobTrack = failedBobSession.localStream.getTracks()[0];
const failedAliceStateStart = aliceStates.length;
const failedBobStateStart = bobStates.length;
failedAliceSession.pc.connectionState = 'failed';
failedAliceSession.pc.iceConnectionState = 'failed';
failedAliceSession.pc.onconnectionstatechange?.();
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(alice.sessions.has(failedConnectionId), false, 'a failed connection must close the local audio session');
assert.equal(bob.sessions.has(failedConnectionId), false, 'a failed connection must notify and close the remote audio session');
assert.equal(aliceHangupSignals.filter(id => id === failedConnectionId).length, 1, 'failed connection must signal one exact hangup before close');
assert.ok(aliceStates.slice(failedAliceStateStart).includes('failed'), 'failed connection must expose a local failed state');
assert.ok(bobStates.slice(failedBobStateStart).includes('ended'), 'failed connection must expose a remote ended state');
assert.equal(failedAliceTrack.stopped, true, 'failed connection must release the local microphone');
assert.equal(failedBobTrack.stopped, true, 'failed connection hangup must release the remote microphone');
alice.stop();
bob.stop();

const reorderedControlRecipient = new PeerTransport();
const reorderedControlId = randomUUID();
let ghostIncomingCalls = 0;
let ghostRingingStates = 0;
let tombstoneHangups = 0;
reorderedControlRecipient.start({
  sendSignal(_peerId, signal) { if (signal.action === 'hangup') tombstoneHangups += 1; },
  onIncomingCall() { ghostIncomingCalls += 1; },
  onCallState(_peerId, state) { if (state === 'ringing') ghostRingingStates += 1; },
  onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
await reorderedControlRecipient.handleSignal(aliceId, { connection_id: reorderedControlId, action: 'hangup' });
await reorderedControlRecipient.handleSignal(aliceId, { connection_id: reorderedControlId, action: 'call_request' });
assert.equal(ghostIncomingCalls, 0, 'a delayed call request after hangup must not recreate an incoming call');
assert.equal(ghostRingingStates, 0, 'a delayed call request after hangup must not recreate ringing state');
assert.equal(tombstoneHangups, 1, 'a tombstoned delayed request should receive hangup again so its retries stop');
reorderedControlRecipient.stop();

const delayedRecipient = new PeerTransport();
const delayedConnectionId = randomUUID();
const delayedStream = new MockStream();
let resolveDelayedMicrophone;
const delayedSignals = [];
navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveDelayedMicrophone = resolve; });
delayedRecipient.start({
  sendSignal(_peerId, signal) { delayedSignals.push(signal); },
  onIncomingCall() {}, onCallState() {}, onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
await delayedRecipient.handleSignal(aliceId, { connection_id: delayedConnectionId, action: 'call_request' });
const delayedAccept = delayedRecipient.acceptCall(delayedConnectionId).catch(error => error);
await Promise.resolve();
await delayedRecipient.handleSignal(aliceId, { connection_id: delayedConnectionId, action: 'hangup' });
resolveDelayedMicrophone(delayedStream);
const delayedAcceptError = await delayedAccept;
assert.match(String(delayedAcceptError), /wygasło/, 'accepting an expired call must fail after the microphone prompt resolves');
assert.equal(delayedStream.getTracks()[0].stopped, true, 'an expired acceptance must immediately release its microphone');
assert.equal(delayedSignals.some(signal => signal.action === 'call_accept'), false, 'an expired acceptance must not create an orphan audio session');
delayedRecipient.stop();

const captureRaceTransport = new PeerTransport();
const captureRaceStream = new MockStream();
const captureRaceSignals = [];
let resolveCaptureRace;
navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCaptureRace = resolve; });
captureRaceTransport.start({
  sendSignal(_peerId, signal) { captureRaceSignals.push(signal); },
  onIncomingCall() {}, onCallState() {}, onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
const captureRaceCall = captureRaceTransport.startCall(bobId).catch(error => error);
await Promise.resolve();
captureRaceTransport.hangupAllCalls();
resolveCaptureRace(captureRaceStream);
const captureRaceError = await captureRaceCall;
assert.match(String(captureRaceError), /cancelled/, 'switching to group voice must cancel an unresolved private microphone request');
assert.equal(captureRaceStream.getTracks()[0].stopped, true, 'a cancelled private microphone request must release the late stream');
assert.equal(captureRaceSignals.length, 0, 'a cancelled private microphone request must not emit a ghost call request');
captureRaceTransport.stop();

const configuredPeerConnections = MockPeerConnection.configs.filter(Boolean);
assert.ok(configuredPeerConnections.length > 0, 'the test must create configured WebRTC transports');
assert.ok(configuredPeerConnections.every(config => config.iceServers.some(server => String(server.urls).includes('stun:stun.cloudflare.com'))), 'files and private calls must discover direct WAN candidates');
assert.ok(configuredPeerConnections.every(config => !config.iceServers.some(server => String(server.urls).includes('openrelay.metered.ca'))), 'retired TURN endpoints must not delay or misrepresent WAN negotiation');
console.log('Peer transport test passed: gathered WAN signaling, >2 MiB streamed file integrity and bidirectional consent-based audio.');
