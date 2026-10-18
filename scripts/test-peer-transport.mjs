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
  remoteDescriptionGate;
  remoteDescriptionCalls = 0;
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
    this.remoteDescriptionCalls += 1;
    // Browser SDP operations finish asynchronously: duplicate relay callbacks
    // can run while remoteDescription and signalingState still hold old values.
    await (this.remoteDescriptionGate ?? Promise.resolve());
    if (this.signalingState === 'closed') throw new DOMException('closed PC', 'InvalidStateError');
    const id = Number(/a=mock-pc:(\d+)/.exec(description.sdp)?.[1]);
    const remote = MockPeerConnection.registry.get(id);
    if (!remote) throw new Error('missing mock remote');
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('invalid remote offer state');
      this.signalingState = 'have-remote-offer';
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error('duplicate or invalid remote answer');
      this.signalingState = 'stable';
    }
    this.remoteDescription = description;
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
    this.signalingState = 'closed';
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
    if (command === 'resume_rtc_file_receive') return incoming.get(args.token)?.length ?? 0;
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
const { createMicrophoneCaptureScope } = await import('../src/microphone-capture.ts');
const newPeerTransport = () => new PeerTransport(createMicrophoneCaptureScope());
assert.ok(MockPeerConnection.configs.length === 0, 'peer connections must be created only when a transfer or call begins');
const alice = newPeerTransport();
const bob = newPeerTransport();
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

// Exercise overlapping SDP application independently of timer-based retries.
async function pendingAnswerFixture() {
  const transport = newPeerTransport();
  const signals = [];
  const states = [];
  const streams = [];
  const fileProgress = [];
  transport.start({
    sendSignal(_peerId, signal) { signals.push(signal); },
    onIncomingCall() {},
    onCallState(_peerId, state) { states.push(state); },
    onRemoteAudio(_peerId, stream) { streams.push(stream); },
    onFileOffer() {}, onFileProgress(progress) { fileProgress.push(progress); },
  });
  await transport.startCall(bobId);
  const id = signals.find(signal => signal.action === 'call_request').connection_id;
  await transport.handleSignal(bobId, { connection_id: id, action: 'call_accept' });
  const session = transport.sessions.get(id);
  assert.equal(session.pc.signalingState, 'have-local-offer');
  const remote = new MockPeerConnection();
  remote.addTrack(new MockTrack(), new MockStream());
  const answer = { connection_id: id, action: 'answer', sdp: (await remote.createAnswer()).sdp };
  return { transport, id, session, remote, answer, signals, states, streams, fileProgress };
}

const duplicateAnswer = await pendingAnswerFixture();
let finishDuplicateAnswer;
duplicateAnswer.session.pc.remoteDescriptionGate = new Promise(resolve => { finishDuplicateAnswer = resolve; });
const firstAnswer = duplicateAnswer.transport.handleSignal(bobId, duplicateAnswer.answer);
const secondAnswer = duplicateAnswer.transport.handleSignal(bobId, duplicateAnswer.answer);
assert.equal(duplicateAnswer.session.pc.remoteDescriptionCalls, 1, 'concurrent copies must reserve one browser SDP operation before yielding');
finishDuplicateAnswer();
await Promise.all([firstAnswer, secondAnswer]);
assert.equal(duplicateAnswer.session.pc.signalingState, 'stable');
assert.equal(duplicateAnswer.streams.filter(Boolean).length, 1, 'duplicate answers must not duplicate or silence private audio');
await duplicateAnswer.transport.handleSignal(bobId, duplicateAnswer.answer);
assert.equal(duplicateAnswer.session.pc.remoteDescriptionCalls, 1, 'stable duplicate answers must remain idempotent');
duplicateAnswer.transport.hangupAllCalls();
duplicateAnswer.transport.stop();
duplicateAnswer.remote.close();

const cancelledAnswer = await pendingAnswerFixture();
let finishCancelledAnswer;
cancelledAnswer.session.pc.remoteDescriptionGate = new Promise(resolve => { finishCancelledAnswer = resolve; });
const cancelledAnswers = [
  cancelledAnswer.transport.handleSignal(bobId, cancelledAnswer.answer),
  cancelledAnswer.transport.handleSignal(bobId, cancelledAnswer.answer),
];
cancelledAnswer.transport.hangupAllCalls();
const statesAtHangup = cancelledAnswer.states.length;
finishCancelledAnswer();
await Promise.all(cancelledAnswers);
await cancelledAnswer.transport.handleSignal(bobId, cancelledAnswer.answer);
await cancelledAnswer.transport.handleSignal(bobId, {
  connection_id: cancelledAnswer.id, action: 'ice', candidate: 'candidate:late',
});
assert.equal(cancelledAnswer.states.length, statesAtHangup, 'a closed SDP operation must not revive connected/failed UI');
assert.equal(cancelledAnswer.streams.filter(Boolean).length, 0, 'late answer must not revive private playback');
assert.equal(cancelledAnswer.transport.earlyIce.has(cancelledAnswer.id), false, 'late ICE for an ended call must not be buffered');
cancelledAnswer.transport.stop();
cancelledAnswer.remote.close();

const invalidAnswer = await pendingAnswerFixture();
await assert.rejects(invalidAnswer.transport.handleSignal(bobId, {
  ...invalidAnswer.answer, sdp: 'invalid SDP',
}), /missing mock remote/, 'actual errors on an active call must not be hidden');
assert.equal(invalidAnswer.session.remoteAnswerInFlight, undefined, 'failed SDP application must release the in-flight guard');
await invalidAnswer.transport.handleSignal(bobId, invalidAnswer.answer);
assert.equal(invalidAnswer.session.pc.signalingState, 'stable', 'a valid subsequent answer must still be applicable');
const invalidFile = { token: randomUUID(), file_name: 'concurrent.bin', size: 123, sha256 };
await invalidAnswer.transport.sendPreparedFile(bobId, invalidFile);
const invalidFileOffer = invalidAnswer.signals.find(signal => signal.action === 'offer' && signal.connection_id !== invalidAnswer.id);
const invalidFileAnswer = { connection_id: invalidFileOffer.connection_id, action: 'answer', sdp: 'invalid file SDP' };
const statesBeforeFileFailure = invalidAnswer.states.length;
const streamsBeforeFileFailure = invalidAnswer.streams.length;
const fileSignalError = await invalidAnswer.transport.handleSignal(bobId, invalidFileAnswer).catch(error => error);
assert.ok(fileSignalError instanceof Error, 'the concurrent file regression must produce a genuine SDP error');
invalidAnswer.transport.reportSignalError(bobId, invalidFileAnswer, fileSignalError);
assert.equal(invalidAnswer.transport.sessions.has(invalidFileOffer.connection_id), false, 'a failed file negotiation must be closed');
assert.ok(invalidAnswer.fileProgress.some(progress => progress.token === invalidFile.token && progress.status === 'failed'), 'the file must expose its own failed status');
assert.equal(invalidAnswer.states.length, statesBeforeFileFailure, 'a file signaling error must not report the live private call as failed');
assert.equal(invalidAnswer.streams.length, streamsBeforeFileFailure, 'a file signaling error must not silence private audio');
assert.equal(invalidAnswer.transport.sessions.get(invalidAnswer.id), invalidAnswer.session, 'the independent audio connection must survive a file failure');
const endedFile = { ...invalidFile, token: randomUUID(), file_name: 'ended.bin' };
await invalidAnswer.transport.sendPreparedFile(bobId, endedFile);
const endedFileOffer = invalidAnswer.signals.filter(signal => signal.action === 'offer').at(-1);
await invalidAnswer.transport.handleSignal(bobId, { connection_id: endedFileOffer.connection_id, action: 'hangup' });
assert.equal(invalidAnswer.states.length, statesBeforeFileFailure, 'file-only hangup must not end the private call with the same peer');
assert.equal(invalidAnswer.streams.length, streamsBeforeFileFailure, 'file-only hangup must leave private output intact');
assert.equal(invalidAnswer.transport.sessions.has(endedFileOffer.connection_id), false, 'file-only hangup must close that file connection');
assert.ok(invalidAnswer.fileProgress.some(progress => progress.token === endedFile.token && progress.status === 'failed'), 'file-only hangup must report termination to that transfer');
invalidAnswer.transport.reportSignalError(bobId, invalidAnswer.answer, new Error('genuine audio failure'));
assert.equal(invalidAnswer.states.at(-1), 'failed', 'genuine audio failures must remain visible');
assert.equal(invalidAnswer.streams.at(-1), null, 'genuine audio failures must clean up their own output');
const statesAfterAudioFailure = invalidAnswer.states.length;
invalidAnswer.transport.reportSignalError(bobId, invalidAnswer.answer, new Error('late failure'));
assert.equal(invalidAnswer.states.length, statesAfterAudioFailure, 'stale errors must not emit duplicate terminal state');
invalidAnswer.transport.hangupAllCalls();
invalidAnswer.transport.stop();
invalidAnswer.remote.close();

const cancelledOffer = newPeerTransport();
const cancelledOfferSignals = [];
cancelledOffer.start({
  sendSignal(_peerId, signal) { cancelledOfferSignals.push(signal); },
  onIncomingCall() {}, onCallState() {}, onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
const cancelledOfferId = randomUUID();
await cancelledOffer.handleSignal(aliceId, { connection_id: cancelledOfferId, action: 'call_request' });
await cancelledOffer.acceptCall(cancelledOfferId);
const cancelledOfferSession = cancelledOffer.sessions.get(cancelledOfferId);
let finishCancelledOffer;
cancelledOfferSession.pc.remoteDescriptionGate = new Promise(resolve => { finishCancelledOffer = resolve; });
const remoteOfferer = new MockPeerConnection();
remoteOfferer.addTrack(new MockTrack(), new MockStream());
const cancelledOfferSignal = { connection_id: cancelledOfferId, action: 'offer', sdp: (await remoteOfferer.createOffer()).sdp };
const applyingCancelledOffer = cancelledOffer.handleSignal(aliceId, cancelledOfferSignal);
await cancelledOffer.handleSignal(aliceId, { connection_id: cancelledOfferId, action: 'hangup' });
finishCancelledOffer();
await applyingCancelledOffer;
await cancelledOffer.handleSignal(aliceId, cancelledOfferSignal);
assert.equal(cancelledOfferSignals.some(signal => signal.action === 'answer'), false, 'hangup during offer application must prevent late answers');
assert.equal(cancelledOffer.sessions.size, 0, 'late offers after hangup must not recreate the call');
cancelledOffer.stop();
remoteOfferer.close();

const reorderedControlRecipient = newPeerTransport();
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

const delayedRecipient = newPeerTransport();
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
for (let attempt = 0; attempt < 200 && !resolveDelayedMicrophone; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.ok(resolveDelayedMicrophone, 'the delayed acceptance regression must reach browser microphone capture');
await delayedRecipient.handleSignal(aliceId, { connection_id: delayedConnectionId, action: 'hangup' });
resolveDelayedMicrophone(delayedStream);
const delayedAcceptError = await delayedAccept;
assert.match(String(delayedAcceptError), /wygasło/, 'accepting an expired call must fail after the microphone prompt resolves');
assert.equal(delayedStream.getTracks()[0].stopped, true, 'an expired acceptance must immediately release its microphone');
assert.equal(delayedSignals.some(signal => signal.action === 'call_accept'), false, 'an expired acceptance must not create an orphan audio session');
delayedRecipient.stop();

const captureRaceTransport = newPeerTransport();
const captureRaceStream = new MockStream();
const captureRaceSignals = [];
let resolveCaptureRace;
navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCaptureRace = resolve; });
captureRaceTransport.start({
  sendSignal(_peerId, signal) { captureRaceSignals.push(signal); },
  onIncomingCall() {}, onCallState() {}, onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
const captureRaceCall = captureRaceTransport.startCall(bobId).catch(error => error);
for (let attempt = 0; attempt < 200 && !resolveCaptureRace; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.ok(resolveCaptureRace, 'the private/group race regression must reach browser microphone capture');
captureRaceTransport.hangupAllCalls();
resolveCaptureRace(captureRaceStream);
const captureRaceError = await captureRaceCall;
assert.match(String(captureRaceError), /cancelled/, 'switching to group voice must cancel an unresolved private microphone request');
assert.equal(captureRaceStream.getTracks()[0].stopped, true, 'a cancelled private microphone request must release the late stream');
assert.equal(captureRaceSignals.length, 0, 'a cancelled private microphone request must not emit a ghost call request');
captureRaceTransport.stop();

const serializedTransport = newPeerTransport();
const serializedSignals = [];
let serializedCaptureCalls = 0;
let resolveFirstSerializedCapture;
const firstSerializedStream = new MockStream();
const secondSerializedStream = new MockStream();
navigator.mediaDevices.getUserMedia = () => {
  serializedCaptureCalls += 1;
  if (serializedCaptureCalls === 1) return new Promise(resolve => { resolveFirstSerializedCapture = resolve; });
  return Promise.resolve(secondSerializedStream);
};
serializedTransport.start({
  sendSignal(peerId, signal) { serializedSignals.push({ peerId, signal }); },
  onIncomingCall() {}, onCallState() {}, onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
const supersededCall = serializedTransport.startCall(aliceId).catch(error => error);
const winningCall = serializedTransport.startCall(bobId);
for (let attempt = 0; attempt < 200 && !resolveFirstSerializedCapture; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.ok(resolveFirstSerializedCapture, 'the serialized private-call regression must reach the first browser capture');
assert.equal(serializedCaptureCalls, 1, 'two rapid calls must not invoke getUserMedia concurrently');
resolveFirstSerializedCapture(firstSerializedStream);
const supersededError = await supersededCall;
await winningCall;
assert.match(String(supersededError), /cancelled/, 'the newer private call must cancel the unresolved earlier capture');
assert.equal(firstSerializedStream.getTracks()[0].stopped, true, 'the superseded capture must release its late stream');
assert.equal(serializedCaptureCalls, 2, 'the winning call may capture only after the superseded stream is released');
assert.equal(
  serializedSignals.filter(({ signal }) => signal.action === 'call_request').every(({ peerId }) => peerId === bobId),
  true,
  'only the winning rapid call may emit call requests',
);
serializedTransport.hangupAllCalls();
serializedTransport.stop();

const failedAcceptTransport = newPeerTransport();
const failedAcceptSignals = [];
const failedAcceptStates = [];
let terminalCaptureCalls = 0;
navigator.mediaDevices.getUserMedia = async () => {
  terminalCaptureCalls += 1;
  throw new DOMException('permission denied', 'NotAllowedError');
};
failedAcceptTransport.start({
  sendSignal(_peerId, signal) { failedAcceptSignals.push(signal); },
  onIncomingCall() {},
  onCallState(_peerId, state, error) { failedAcceptStates.push({ state, error }); },
  onRemoteAudio() {}, onFileOffer() {}, onFileProgress() {},
});
const failedAcceptId = randomUUID();
await failedAcceptTransport.handleSignal(aliceId, { connection_id: failedAcceptId, action: 'call_request' });
await assert.rejects(failedAcceptTransport.acceptCall(failedAcceptId), /microphone access is blocked/i);
assert.equal(terminalCaptureCalls, 1, 'permission denial must not be retried as a transient device race');
assert.equal(failedAcceptTransport.pendingCalls.has(failedAcceptId), false, 'failed answer capture must clear the incoming call and its timer');
assert.equal(
  failedAcceptSignals.filter(signal => signal.action === 'call_reject' && signal.connection_id === failedAcceptId).length,
  1,
  'failed answer capture must tell the caller to stop ringing',
);
assert.ok(failedAcceptStates.some(({ state }) => state === 'failed'), 'failed answer capture must expose a failed local state');
failedAcceptTransport.stop();

const configuredPeerConnections = MockPeerConnection.configs.filter(Boolean);
assert.ok(configuredPeerConnections.length > 0, 'the test must create configured WebRTC transports');
assert.ok(configuredPeerConnections.every(config => config.iceServers.some(server => String(server.urls).includes('stun:stun.cloudflare.com'))), 'files and private calls must discover direct WAN candidates');
assert.ok(configuredPeerConnections.every(config => !config.iceServers.some(server => String(server.urls).includes('openrelay.metered.ca'))), 'retired TURN endpoints must not delay or misrepresent WAN negotiation');
console.log('Peer transport test passed: gathered WAN signaling, >2 MiB streamed file integrity and bidirectional consent-based audio.');

// Resume a real streamed payload using the existing two-ended transport mocks.
async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Resume scenario timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function resumeScenario(initiator) {
const resumeAlice = newPeerTransport(), resumeBob = newPeerTransport();
const resumeToken = randomUUID();
let pauseRequested = false, receiverOffset = 0, finishedResume = false;
const resumeErrors = [];
resumeAlice.start({
  sendSignal(_peer, signal) { queueMicrotask(() => void resumeBob.handleSignal(aliceId, signal).catch(e => resumeErrors.push(e))); },
  onIncomingCall(){}, onCallState(){}, onRemoteAudio(){}, onFileOffer(){}, onFileProgress(){},
});
resumeBob.start({
  sendSignal(_peer, signal) { queueMicrotask(() => void resumeAlice.handleSignal(bobId, signal).catch(e => resumeErrors.push(e))); },
  onIncomingCall(){}, onCallState(){}, onRemoteAudio(){},
  onFileOffer(offer) { void resumeBob.acceptFile(offer.token).catch(e => resumeErrors.push(e)); },
  onFileProgress(progress) {
    if (progress.status === 'transferring' && progress.transferred >= 64*1024 && !pauseRequested) {
      pauseRequested = true; receiverOffset = progress.transferred;
      void (initiator === 'sender' ? resumeAlice : resumeBob).pauseFile(progress.token).catch(e => resumeErrors.push(e));
    }
    if (progress.status === 'completed') finishedResume = true;
  },
});
await resumeAlice.sendPreparedFile(bobId,{token:resumeToken,file_name:unicodeFileName,size:outgoingBytes.length,sha256});
await waitUntil(() => pauseRequested && resumeAlice.sessions.size === 0 && resumeBob.sessions.size === 0);
assert(receiverOffset > 0 && receiverOffset < outgoingBytes.length);
assert(resumeAlice.outgoing.has(resumeToken), 'pause preserves sender descriptor');
assert(resumeBob.incoming.has(resumeToken), 'pause preserves accepted receiver state');
const acceptedOffset = incoming.get(resumeToken).length;
assert(acceptedOffset >= receiverOffset);
const originalSession = resumeBob.incoming.get(resumeToken).sessionId;
await resumeBob.receiveWire({ id:'rogue',peerId:'attacker',closed:false }, {type:'file_offer',token:resumeToken,file_name:unicodeFileName,size:outgoingBytes.length,sha256,resumable:true});
assert.equal(resumeBob.incoming.get(resumeToken).sessionId,originalSession,'another identity cannot claim the partial file');
await resumeBob.receiveWire({ id:'altered',peerId:aliceId,closed:false }, {type:'file_offer',token:resumeToken,file_name:unicodeFileName,size:outgoingBytes.length,sha256:'0'.repeat(64),resumable:true});
assert.equal(resumeBob.incoming.get(resumeToken).sessionId,originalSession,'changed content cannot reuse previous consent or offsets');
await (initiator === 'sender' ? resumeAlice : resumeBob).resumeFile(resumeToken);
await waitUntil(() => finishedResume);
assert.deepEqual(resumeErrors,[]);
assert.deepEqual(incoming.get(resumeToken),outgoingBytes,'resumed content must match original bytes and hash without duplication');
resumeAlice.stop(); resumeBob.stop();
}
await resumeScenario('receiver');
await resumeScenario('sender');
const policyTransport = newPeerTransport(), policyStates=[];
policyTransport.start({sendSignal(){},onIncomingCall(_peer,id){policyTransport.rejectCall(id);},onCallState(_peer,state){policyStates.push(state);},onRemoteAudio(){},onFileOffer(){},onFileProgress(){}});
await policyTransport.handleSignal(aliceId,{connection_id:randomUUID(),action:'call_request'});
assert(!policyStates.includes('ringing'),'privacy-rejected invitations must never start ringing');
assert.equal(policyTransport.pendingCalls.size,0);
policyTransport.stop();
console.log('Resume tests passed: both sender/receiver pause and reconnect, complete hash-verified content, reject identity/metadata substitution, and suppress policy-rejected ringing.');
