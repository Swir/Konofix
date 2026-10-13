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

class MockPeerConnection extends EventTarget {
  static nextId = 1;
  static registry = new Map();
  static configs = [];
  static deferNextGathering = false;
  id = MockPeerConnection.nextId++;
  tracks = [];
  candidates = [];
  gatheringDeferred = false;
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
  remote;
  constructor(config) {
    super();
    MockPeerConnection.configs.push(config);
    MockPeerConnection.registry.set(this.id, this);
  }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  async createOffer() { return { type: 'offer', sdp: `v=0\r\na=mock-group:${this.id}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=mock-group:${this.id}\r\na=answer` }; }
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
    const id = Number(/a=mock-group:(\d+)/.exec(description.sdp)?.[1]);
    const remote = MockPeerConnection.registry.get(id);
    if (!remote) throw new Error('missing group mock remote');
    this.remote = remote;
    remote.remote = this;
    if (description.type === 'answer') {
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
      remote.connectionState = 'connected';
      remote.iceConnectionState = 'connected';
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
  close() { this.connectionState = 'closed'; MockPeerConnection.registry.delete(this.id); }
}

globalThis.RTCPeerConnection = MockPeerConnection;
globalThis.MediaStream = MockStream;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { async getUserMedia() { return new MockStream(); } } },
});

const { GroupVoice } = await import('../src/group-voice.ts');

const raceListener = new GroupVoice();
const raceSpeakerId = `nostr:${'c'.repeat(64)}`;
const raceListenerId = `nostr:${'d'.repeat(64)}`;
const staleRequestId = crypto.randomUUID();
const activeRequestId = crypto.randomUUID();
const staleConnectionId = crypto.randomUUID();
const activeConnectionId = crypto.randomUUID();
const raceAnswers = [];
raceListener.start(raceListenerId, 'Listener', '#35d07f', {
  sendSignal(_peerId, signal) { if (signal.action === 'answer') raceAnswers.push(signal); },
  publishWorld() {},
  peers() { return []; },
  onRemoteStream() {},
  onState() {},
});
const activeOfferer = new MockPeerConnection();
const staleOfferer = new MockPeerConnection();
const activeOffer = await activeOfferer.createOffer();
const staleOffer = await staleOfferer.createOffer();
await raceListener.handleSignal(raceSpeakerId, {
  connection_id: activeConnectionId, action: 'offer', scope: 'world', request_id: activeRequestId, sdp: activeOffer.sdp,
});
raceListener.updateWorldState({
  peer_id: raceSpeakerId, nick: 'Speaker', nick_color: '#4f7cff', status: 'idle', request_id: staleRequestId, joined_at: Date.now() - 10,
});
await raceListener.handleSignal(raceSpeakerId, {
  connection_id: staleConnectionId, action: 'offer', scope: 'world', request_id: staleRequestId, sdp: staleOffer.sdp,
});
raceListener.updateWorldState({
  peer_id: raceSpeakerId, nick: 'Speaker', nick_color: '#4f7cff', status: 'speaking', request_id: activeRequestId,
  joined_at: Date.now(), speaking_until: Date.now() + 60_000,
});
for (let attempt = 0; attempt < 100 && raceAnswers.length === 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
}
assert.equal(raceAnswers[0]?.connection_id, activeConnectionId, 'stale WORLD traffic must not replace the pending offer for the active request');
raceListener.stop();

const cancelledSpeaker = new GroupVoice();
let cancelledSpeakerOffers = 0;
cancelledSpeaker.start(`nostr:${'e'.repeat(64)}`, 'Cancelled', '#35d07f', {
  sendSignal(_peerId, signal) { if (signal.action === 'offer') cancelledSpeakerOffers += 1; },
  publishWorld() {},
  peers() { return [`nostr:${'f'.repeat(64)}`]; },
  onRemoteStream() {},
  onState() {},
});
MockPeerConnection.deferNextGathering = true;
await cancelledSpeaker.requestWorldTurn();
let cancelledGatheringSession;
for (let attempt = 0; attempt < 200 && !cancelledGatheringSession; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2));
  cancelledGatheringSession = [...MockPeerConnection.registry.values()].find(connection => connection.gatheringDeferred);
}
assert.ok(cancelledGatheringSession, 'the group cancellation regression must pause ICE gathering');
cancelledSpeaker.leaveWorld();
cancelledGatheringSession.completeIceGathering();
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(cancelledSpeakerOffers, 0, 'leaving WORLD during ICE gathering must not emit a ghost SDP offer');
cancelledSpeaker.stop();

const alice = new GroupVoice();
const bob = new GroupVoice();
const aliceId = `nostr:${'a'.repeat(64)}`;
const bobId = `nostr:${'b'.repeat(64)}`;
let bobWorldAudio = 0;
let aliceWorldAudio = 0;
let aliceRoomAudio = 0;
let bobRoomAudio = 0;
let bobSnapshot;
let delayedAliceSpeakingState;
let aliceOfferArrivedBeforeSpeakingState = false;
let aliceWorldOfferRequestId;
let aliceWorldConnectionId;
const signaledDescriptions = [];
let droppedFirstWorldAnswer = false;
let deliveredWorldAnswer;
let aliceMicrophonePreparations = 0;
let bobMicrophonePreparations = 0;

alice.start(aliceId, 'Alice', '#35d07f', {
  sendSignal(_peerId, signal) {
    if ((signal.action === 'offer' || signal.action === 'answer') && signal.sdp) signaledDescriptions.push(signal.sdp);
    queueMicrotask(async () => {
      await bob.handleSignal(aliceId, signal);
      if (signal.scope === 'world' && signal.action === 'offer') {
        if (!aliceWorldOfferRequestId) {
          aliceWorldOfferRequestId = signal.request_id;
          aliceWorldConnectionId = signal.connection_id;
          aliceOfferArrivedBeforeSpeakingState = bob.snapshot().speaker === undefined;
        }
        const speaking = delayedAliceSpeakingState;
        if (speaking) {
          delayedAliceSpeakingState = undefined;
          bob.updateWorldState(speaking);
        }
      }
    });
  },
  publishWorld(state) {
    // The public relay idle event can arrive later. The direct world_release
    // signal must still unlock the next person immediately.
    if (state.status === 'speaking') {
      delayedAliceSpeakingState = { ...state, peer_id: aliceId, nick: 'Alice', nick_color: '#35d07f' };
    } else if (state.status !== 'idle') {
      bob.updateWorldState({ ...state, peer_id: aliceId, nick: 'Alice', nick_color: '#35d07f' });
    }
  },
  peers() { return [bobId]; },
  beforeMicrophoneCapture() { aliceMicrophonePreparations += 1; },
  onRemoteStream(scope, _peerId, stream) {
    if (scope === 'world' && stream) aliceWorldAudio += 1;
    if (scope === 'test-room' && stream) aliceRoomAudio += 1;
  },
  onState() {},
});
bob.start(bobId, 'Bob', '#4f7cff', {
  sendSignal(_peerId, signal) {
    if ((signal.action === 'offer' || signal.action === 'answer') && signal.sdp) signaledDescriptions.push(signal.sdp);
    if (signal.scope === 'world' && signal.action === 'answer' && !droppedFirstWorldAnswer) {
      droppedFirstWorldAnswer = true;
      return;
    }
    if (signal.scope === 'world' && signal.action === 'answer') deliveredWorldAnswer = { ...signal };
    queueMicrotask(() => void alice.handleSignal(bobId, signal));
  },
  publishWorld(state) { alice.updateWorldState({ ...state, peer_id: bobId, nick: 'Bob', nick_color: '#4f7cff' }); },
  peers() { return [aliceId]; },
  beforeMicrophoneCapture() { bobMicrophonePreparations += 1; },
  onRemoteStream(scope, _peerId, stream) {
    if (scope === 'world' && stream) bobWorldAudio += 1;
    if (scope === 'test-room' && stream) bobRoomAudio += 1;
  },
  onState(snapshot) { bobSnapshot = snapshot; },
});

await alice.requestWorldTurn();
for (let attempt = 0; attempt < 400 && bobWorldAudio === 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(bobSnapshot.speaker?.nick, 'Alice', 'signed queue state must identify the current WORLD speaker');
assert.equal(aliceOfferArrivedBeforeSpeakingState, true, 'the regression must deliver the encrypted offer before public speaking state');
assert.equal(aliceWorldOfferRequestId, bobSnapshot.speaker?.request_id, 'WORLD offer must be bound to the active queue request');
assert.ok(bobSnapshot.secondsLeft > 0 && bobSnapshot.secondsLeft <= 60, 'WORLD turn must expose a bounded visible countdown');
assert.equal(bobWorldAudio, 1, 'WORLD speaker audio must reach a passive listener');
assert.equal(aliceMicrophonePreparations, 1, 'WORLD voice must release competing private microphone ownership before capture');
assert.equal(droppedFirstWorldAnswer, true, 'the regression must drop the first WORLD answer and recover by retry');
assert.ok(deliveredWorldAnswer, 'the WORLD listener must deliver a final gathered answer');
await alice.handleSignal(bobId, deliveredWorldAnswer);
await bob.handleSignal(aliceId, {
  connection_id: aliceWorldConnectionId,
  action: 'ice',
  scope: 'world',
  candidate: 'candidate:reject-me',
  sdp_mid: '0',
  sdp_mline_index: 0,
});
const sessionsBeforeStaleHangup = MockPeerConnection.registry.size;
await bob.handleSignal(aliceId, { connection_id: crypto.randomUUID(), action: 'hangup', scope: 'world' });
assert.equal(MockPeerConnection.registry.size, sessionsBeforeStaleHangup, 'a stale WORLD hangup must not close a newer session');
assert.ok(
  signaledDescriptions.length > 0 && signaledDescriptions.every(sdp => sdp.includes('a=candidate:mock-complete')),
  'group offers and answers must carry gathered ICE candidates in SDP instead of relying only on lossy trickle events',
);
const configuredGroupConnection = MockPeerConnection.configs.find(Boolean);
assert.ok(configuredGroupConnection.iceServers.some(server => String(server.urls).includes('stun:stun.cloudflare.com')), 'group audio must discover direct WAN candidates');
assert.ok(!configuredGroupConnection.iceServers.some(server => String(server.urls).includes('openrelay.metered.ca')), 'retired TURN endpoints must not delay or misrepresent group audio');

await bob.requestWorldTurn();
assert.equal(bob.snapshot().localWorld?.status, 'queued', 'a second speaker must wait while the current turn is active');
assert.equal(bob.snapshot().canStartWorld, false);

alice.leaveWorld();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(bob.snapshot().speaker, undefined, 'leaving a turn must release WORLD for the next queued person');
assert.equal(bob.snapshot().canStartWorld, true, 'a direct release must immediately unlock the next queued speaker');
bob.updateWorldState({
  peer_id: aliceId,
  nick: 'Alice',
  nick_color: '#35d07f',
  status: 'speaking',
  request_id: aliceWorldOfferRequestId,
  joined_at: Date.now() - 1_000,
  speaking_until: Date.now() + 30_000,
});
assert.equal(bob.snapshot().speaker, undefined, 'a delayed speaking heartbeat must not resurrect a released WORLD turn');
assert.equal(bob.snapshot().canStartWorld, true, 'the next queued speaker must stay unlocked after stale relay traffic');

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
assert.equal(aliceMicrophonePreparations, 2, 'Alice must release private audio before each WORLD or room microphone capture');
assert.equal(bobMicrophonePreparations, 2, 'Bob must release private audio before each WORLD or room microphone capture');
assert.equal(alice.snapshot().secondsLeft, 0, 'private room group voice must not use the WORLD timer');

await alice.requestWorldTurn();
for (let attempt = 0; attempt < 100 && alice.snapshot().localWorld?.status !== 'speaking'; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(alice.snapshot().roomActive, false, 'starting a WORLD turn must release an active room microphone');
assert.equal(alice.snapshot().localWorld?.status, 'speaking');

await alice.joinRoom('test-room');
assert.equal(alice.snapshot().localWorld, undefined, 'joining a room must release the WORLD turn and queue position');
assert.equal(alice.snapshot().roomActive, true, 'room audio must own the microphone after leaving WORLD');

alice.stop();
bob.stop();

const rejoinListener = new GroupVoice();
const rejoinListenerId = `nostr:${'f'.repeat(64)}`;
const rejoiningPeerId = `nostr:${'1'.repeat(64)}`;
const roomMembershipEpoch = crypto.randomUUID();
const oldMembershipId = crypto.randomUUID();
const newMembershipId = crypto.randomUUID();
const oldRoomConnectionId = crypto.randomUUID();
const newRoomConnectionId = crypto.randomUUID();
let rejoinNullStreams = 0;
rejoinListener.start(rejoinListenerId, 'Rejoin_listener', '#35d07f', {
  sendSignal() {},
  publishWorld() {},
  peers() { return []; },
  onRemoteStream(scope, peerId, stream) {
    if (scope === 'rejoin-room' && peerId === rejoiningPeerId && !stream) rejoinNullStreams += 1;
  },
  onState() {},
});
await rejoinListener.joinRoom('rejoin-room');
await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'rejoin-room',
  request_id: oldMembershipId, membership_epoch: roomMembershipEpoch,
  membership_generation: 1, reply: false,
});
const oldRoomOfferer = new MockPeerConnection();
const oldRoomOffer = await oldRoomOfferer.createOffer();
await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: oldRoomConnectionId, action: 'offer', scope: 'rejoin-room',
  request_id: oldMembershipId, membership_epoch: roomMembershipEpoch,
  membership_generation: 1, sdp: oldRoomOffer.sdp,
});
const staleRoomSession = rejoinListener.sessions.get(oldRoomConnectionId);
assert.ok(staleRoomSession, 'the first room membership must create one receiving session');

await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'rejoin-room',
  request_id: newMembershipId, membership_epoch: roomMembershipEpoch,
  membership_generation: 2, reply: false,
});
assert.equal(staleRoomSession.closed, true, 'a fresh room membership must retire the previous peer session');
const newRoomOfferer = new MockPeerConnection();
const newRoomOffer = await newRoomOfferer.createOffer();
await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: newRoomConnectionId, action: 'offer', scope: 'rejoin-room',
  request_id: newMembershipId, membership_epoch: roomMembershipEpoch,
  membership_generation: 2, sdp: newRoomOffer.sdp,
});
const peerScopeKey = `rejoin-room\u0000${rejoiningPeerId}`;
assert.equal(
  [...rejoinListener.sessions.values()].filter(session => session.scope === 'rejoin-room' && session.peerId === rejoiningPeerId).length,
  1,
  'a peer may own only one live WebRTC session in a room scope',
);
assert.equal(rejoinListener.sessionByPeerScope.get(peerScopeKey), newRoomConnectionId, 'the fresh room session must own the peer/scope slot');
const nullStreamsBeforeDelayedLeave = rejoinNullStreams;
await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: crypto.randomUUID(), action: 'leave', scope: 'rejoin-room',
  request_id: oldMembershipId, membership_epoch: roomMembershipEpoch, membership_generation: 1,
});
staleRoomSession.pc.onconnectionstatechange?.();
assert.equal(rejoinListener.sessions.has(newRoomConnectionId), true, 'a delayed old leave must not close a fresh room session');
assert.equal(rejoinListener.sessionByPeerScope.get(peerScopeKey), newRoomConnectionId, 'a stale close must not erase the fresh peer/scope mapping');
assert.equal(rejoinNullStreams, nullStreamsBeforeDelayedLeave, 'stale room control must not clear the fresh remote audio output');

const unseenOldPeerId = `nostr:${'2'.repeat(64)}`;
const unseenEpoch = crypto.randomUUID();
const unseenOldMembershipId = crypto.randomUUID();
const unseenNewMembershipId = crypto.randomUUID();
const unseenNewConnectionId = crypto.randomUUID();
await rejoinListener.handleSignal(unseenOldPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'rejoin-room',
  request_id: unseenNewMembershipId, membership_epoch: unseenEpoch,
  membership_generation: 2, reply: false,
});
const unseenNewOfferer = new MockPeerConnection();
const unseenNewOffer = await unseenNewOfferer.createOffer();
await rejoinListener.handleSignal(unseenOldPeerId, {
  connection_id: unseenNewConnectionId, action: 'offer', scope: 'rejoin-room',
  request_id: unseenNewMembershipId, membership_epoch: unseenEpoch,
  membership_generation: 2, sdp: unseenNewOffer.sdp,
});
await rejoinListener.handleSignal(unseenOldPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'rejoin-room',
  request_id: unseenOldMembershipId, membership_epoch: unseenEpoch,
  membership_generation: 1, reply: false,
});
assert.equal(
  rejoinListener.sessions.has(unseenNewConnectionId),
  true,
  'a delayed unseen old JOIN must not replace a newer room membership generation',
);
assert.equal(
  rejoinListener.sessionByPeerScope.get(`rejoin-room\u0000${unseenOldPeerId}`),
  unseenNewConnectionId,
  'a delayed unseen old JOIN must preserve the fresh room audio route',
);
await rejoinListener.handleSignal(rejoiningPeerId, {
  connection_id: crypto.randomUUID(), action: 'leave', scope: 'rejoin-room',
  request_id: newMembershipId, membership_epoch: roomMembershipEpoch, membership_generation: 2,
});
assert.equal(rejoinListener.sessions.has(newRoomConnectionId), false, 'the active membership leave must still close its room session');
rejoinListener.stop();

const heartbeatPeerId = `nostr:${'8'.repeat(64)}`;
const heartbeatVoice = new GroupVoice();
const heartbeatSignals = [];
heartbeatVoice.start(`nostr:${'7'.repeat(64)}`, 'Heartbeat', '#35d07f', {
  sendSignal(peerId, signal) { heartbeatSignals.push({ peerId, signal: { ...signal } }); },
  publishWorld() {},
  peers() { return [heartbeatPeerId]; },
  onRemoteStream() {},
  onState() {},
});
await heartbeatVoice.joinRoom('heartbeat-room');
for (let attempt = 0; attempt < 3; attempt += 1) {
  heartbeatVoice.nextRoomJoinAt = 0;
  heartbeatVoice.tick();
}
const heartbeatJoins = heartbeatSignals.filter(({ signal }) => signal.action === 'join');
assert.equal(heartbeatJoins.length, 4, 'room membership must send one JOIN plus a bounded two-message burst and one due heartbeat');
assert.equal(new Set(heartbeatJoins.map(({ signal }) => signal.request_id)).size, 1, 'room JOIN heartbeat must retain the exact membership id');
assert.equal(new Set(heartbeatJoins.map(({ signal }) => signal.membership_epoch)).size, 1, 'room JOIN heartbeat must retain the exact epoch');
assert.equal(new Set(heartbeatJoins.map(({ signal }) => signal.membership_generation)).size, 1, 'room JOIN heartbeat must retain the exact generation');
heartbeatVoice.leaveRoom();
const joinsAfterLeave = heartbeatSignals.filter(({ signal }) => signal.action === 'join').length;
heartbeatVoice.nextRoomJoinAt = 0;
heartbeatVoice.tick();
assert.equal(
  heartbeatSignals.filter(({ signal }) => signal.action === 'join').length,
  joinsAfterLeave,
  'leaving a room must cancel its scheduled JOIN heartbeat',
);
heartbeatVoice.stop();

const disconnectVoice = new GroupVoice();
const disconnectLocalId = `nostr:${'0'.repeat(64)}`;
const disconnectPeerId = `nostr:${'8'.repeat(64)}`;
const disconnectSignals = [];
disconnectVoice.start(disconnectLocalId, 'Disconnect', '#35d07f', {
  sendSignal(peerId, signal) { disconnectSignals.push({ peerId, signal: { ...signal } }); },
  publishWorld() {},
  peers() { return [disconnectPeerId]; },
  onRemoteStream() {},
  onState() {},
});
await disconnectVoice.joinRoom('disconnect-room');
await disconnectVoice.handleSignal(disconnectPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'disconnect-room',
  request_id: crypto.randomUUID(), membership_epoch: crypto.randomUUID(),
  membership_generation: 1, reply: false,
});
let disconnectSession = [...disconnectVoice.sessions.values()]
  .find(session => session.scope === 'disconnect-room');
assert.ok(disconnectSession, 'the disconnect regression needs an active canonical room session');
disconnectSession.pc.connectionState = 'connected';
disconnectSession.pc.iceConnectionState = 'connected';
disconnectSession.pc.onconnectionstatechange?.();

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const disconnectGraceCallbacks = new Map();
let nextDisconnectTimer = 900_000;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 8_000) {
    const timer = nextDisconnectTimer++;
    disconnectGraceCallbacks.set(timer, () => callback(...args));
    return timer;
  }
  return nativeSetTimeout(callback, delay, ...args);
};
globalThis.clearTimeout = timer => {
  if (!disconnectGraceCallbacks.delete(timer)) nativeClearTimeout(timer);
};
try {
  disconnectSession.pc.connectionState = 'disconnected';
  disconnectSession.pc.iceConnectionState = 'disconnected';
  disconnectSession.pc.onconnectionstatechange?.();
  const transientTimer = disconnectSession.disconnectTimer;
  const staleTransientCallback = disconnectGraceCallbacks.get(transientTimer);
  assert.ok(staleTransientCallback, 'a disconnected group session must start one grace timer');
  disconnectSession.pc.oniceconnectionstatechange?.();
  assert.equal(disconnectSession.disconnectTimer, transientTimer, 'connection and ICE events must share one grace timer');
  assert.equal(disconnectGraceCallbacks.size, 1, 'duplicate disconnected events must not allocate duplicate timers');

  disconnectSession.pc.connectionState = 'connected';
  disconnectSession.pc.iceConnectionState = 'completed';
  disconnectSession.pc.oniceconnectionstatechange?.();
  assert.equal(disconnectSession.disconnectTimer, undefined, 'ICE recovery must cancel the disconnect grace timer');
  assert.equal(disconnectGraceCallbacks.has(transientTimer), false, 'ICE recovery must clear the scheduled callback');
  staleTransientCallback();
  assert.equal(
    disconnectVoice.sessions.get(disconnectSession.id),
    disconnectSession,
    'an already-queued stale grace callback must not close a recovered session',
  );

  disconnectSession.pc.connectionState = 'disconnected';
  disconnectSession.pc.iceConnectionState = 'disconnected';
  disconnectSession.pc.onconnectionstatechange?.();
  const closeTimer = disconnectSession.disconnectTimer;
  const staleCloseCallback = disconnectGraceCallbacks.get(closeTimer);
  assert.ok(staleCloseCallback, 'a later disconnect must get a fresh grace timer');
  disconnectVoice.leaveRoom();
  const hangupsAfterClose = disconnectSignals.filter(({ signal }) => signal.action === 'hangup').length;
  assert.equal(disconnectGraceCallbacks.has(closeTimer), false, 'closing a session must cancel its disconnect timer');
  staleCloseCallback();
  assert.equal(
    disconnectSignals.filter(({ signal }) => signal.action === 'hangup').length,
    hangupsAfterClose,
    'a stale timer from a closed membership must not send a ghost hangup',
  );
  assert.equal(disconnectVoice.sessionRecoveries.size, 0, 'a stale timer from a closed membership must not schedule recovery');

  await disconnectVoice.joinRoom('disconnect-room');
  await disconnectVoice.handleSignal(disconnectPeerId, {
    connection_id: crypto.randomUUID(), action: 'join', scope: 'disconnect-room',
    request_id: crypto.randomUUID(), membership_epoch: crypto.randomUUID(),
    membership_generation: 1, reply: false,
  });
  disconnectSession = [...disconnectVoice.sessions.values()]
    .find(session => session.scope === 'disconnect-room');
  assert.ok(disconnectSession, 'the persistent-disconnect regression needs a fresh room session');
  disconnectSession.pc.connectionState = 'connected';
  disconnectSession.pc.iceConnectionState = 'connected';
  disconnectSession.pc.onconnectionstatechange?.();
  disconnectSession.pc.connectionState = 'disconnected';
  disconnectSession.pc.iceConnectionState = 'disconnected';
  disconnectSession.pc.oniceconnectionstatechange?.();
  const persistentTimer = disconnectSession.disconnectTimer;
  const persistentCallback = disconnectGraceCallbacks.get(persistentTimer);
  assert.ok(persistentCallback, 'a persistent disconnect must schedule its grace expiry');
  persistentCallback();
  assert.equal(disconnectVoice.sessions.has(disconnectSession.id), false, 'grace expiry must close the disconnected session');
  assert.equal(
    disconnectSignals.filter(({ signal }) => signal.action === 'hangup' && signal.connection_id === disconnectSession.id).length,
    1,
    'grace expiry must send exactly one hangup for the failed connection',
  );
  assert.equal(disconnectVoice.sessionRecoveries.size, 1, 'grace expiry must enter the existing bounded recovery chain');
  persistentCallback();
  assert.equal(
    disconnectSignals.filter(({ signal }) => signal.action === 'hangup' && signal.connection_id === disconnectSession.id).length,
    1,
    'replaying an expired grace callback must not duplicate cleanup',
  );
} finally {
  disconnectVoice.stop();
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}

const recoveryVoice = new GroupVoice();
const recoveryLocalId = `nostr:${'0'.repeat(64)}`;
const recoveryPeerId = `nostr:${'9'.repeat(64)}`;
const recoverySignals = [];
recoveryVoice.start(recoveryLocalId, 'Recovery', '#35d07f', {
  sendSignal(peerId, signal) { recoverySignals.push({ peerId, signal: { ...signal } }); },
  publishWorld() {},
  peers() { return [recoveryPeerId]; },
  onRemoteStream() {},
  onState() {},
});
await recoveryVoice.joinRoom('recovery-room');
await recoveryVoice.handleSignal(recoveryPeerId, {
  connection_id: crypto.randomUUID(), action: 'join', scope: 'recovery-room',
  request_id: crypto.randomUUID(), membership_epoch: crypto.randomUUID(),
  membership_generation: 1, reply: false,
});
let recoverySession = [...recoveryVoice.sessions.values()].find(session => session.scope === 'recovery-room');
assert.ok(recoverySession, 'the canonical room initiator must create the initial session');
const initialRecoveryConnectionId = recoverySession.id;
recoverySession.pc.connectionState = 'failed';
recoverySession.pc.onconnectionstatechange?.();
assert.ok(
  recoverySignals.some(({ signal }) => signal.action === 'hangup' && signal.connection_id === initialRecoveryConnectionId),
  'an ICE failure must send an exact-connection hangup before recovery',
);
assert.equal(recoveryVoice.sessionRecoveries.size, 1, 'an active membership must schedule one bounded recovery chain');

for (let retry = 1; retry <= 3; retry += 1) {
  const pending = [...recoveryVoice.sessionRecoveries.values()][0];
  pending.nextAt = 0;
  recoveryVoice.tick();
  await new Promise(resolve => setTimeout(resolve, 2));
  recoverySession = [...recoveryVoice.sessions.values()].find(session => session.scope === 'recovery-room');
  assert.ok(recoverySession, `room recovery attempt ${retry} must create a fresh session`);
  assert.notEqual(recoverySession.id, initialRecoveryConnectionId, 'a recovery must never reuse the failed connection id');
  recoverySession.pc.connectionState = 'failed';
  recoverySession.pc.onconnectionstatechange?.();
}
const recoveryOffersAtCap = recoverySignals.filter(({ signal }) => signal.action === 'offer').length;
const exhaustedRecovery = [...recoveryVoice.sessionRecoveries.values()][0];
assert.equal(exhaustedRecovery.attempts, 3, 'room recovery must retain its per-generation retry cap');
exhaustedRecovery.nextAt = 0;
recoveryVoice.tick();
await new Promise(resolve => setTimeout(resolve, 2));
assert.equal(
  recoverySignals.filter(({ signal }) => signal.action === 'offer').length,
  recoveryOffersAtCap,
  'an exhausted membership generation must not start an unbounded retry loop',
);
recoveryVoice.leaveRoom();
assert.equal(recoveryVoice.sessionRecoveries.size, 0, 'leaving a room must discard all pending recovery work');
recoveryVoice.tick();
await new Promise(resolve => setTimeout(resolve, 2));
assert.equal(
  recoverySignals.filter(({ signal }) => signal.action === 'offer').length,
  recoveryOffersAtCap,
  'a retired room membership must not emit a ghost offer',
);
recoveryVoice.stop();

const expiryVoice = new GroupVoice();
const expiryPeerId = `nostr:${'5'.repeat(64)}`;
const expirySignals = [];
expiryVoice.start(`nostr:${'2'.repeat(64)}`, 'Expiry', '#35d07f', {
  sendSignal(peerId, signal) { expirySignals.push({ peerId, signal: { ...signal } }); },
  publishWorld() {},
  peers() { return [expiryPeerId]; },
  onRemoteStream() {},
  onState() {},
});
await expiryVoice.requestWorldTurn();
expiryVoice.worldContentionUntil = 0;
expiryVoice.tick();
await new Promise(resolve => setTimeout(resolve, 5));
await expiryVoice.ensureWorldSpeakerSession(expiryPeerId);
const expiringSession = [...expiryVoice.sessions.values()].find(session => session.scope === 'world');
assert.ok(expiringSession, 'an active WORLD generation must create its speaker session');
expiringSession.pc.connectionState = 'failed';
expiringSession.pc.onconnectionstatechange?.();
assert.equal(expiryVoice.sessionRecoveries.size, 1, 'an active WORLD turn may schedule bounded recovery');
const expiryOffers = expirySignals.filter(({ signal }) => signal.action === 'offer').length;
expiryVoice.localWorld.speaking_until = Date.now() - 1;
expiryVoice.tick();
assert.equal(expiryVoice.sessionRecoveries.size, 0, 'WORLD expiry must cancel its pending generation recovery');
expiryVoice.tick();
await new Promise(resolve => setTimeout(resolve, 2));
assert.equal(
  expirySignals.filter(({ signal }) => signal.action === 'offer').length,
  expiryOffers,
  'an expired WORLD generation must not emit a ghost offer',
);
expiryVoice.stop();

const contentionAlice = new GroupVoice();
const contentionBob = new GroupVoice();
const contentionAliceId = `nostr:${'3'.repeat(64)}`;
const contentionBobId = `nostr:${'4'.repeat(64)}`;
let contentionCaptures = 0;
contentionAlice.start(contentionAliceId, 'Contention_A', '#35d07f', {
  sendSignal() {},
  publishWorld(state) {
    contentionBob.updateWorldState({ ...state, peer_id: contentionAliceId, nick: 'Contention_A', nick_color: '#35d07f' });
  },
  peers() { return []; },
  beforeMicrophoneCapture() { contentionCaptures += 1; },
  onRemoteStream() {},
  onState() {},
});
contentionBob.start(contentionBobId, 'Contention_B', '#4f7cff', {
  sendSignal() {},
  publishWorld(state) {
    contentionAlice.updateWorldState({ ...state, peer_id: contentionBobId, nick: 'Contention_B', nick_color: '#4f7cff' });
  },
  peers() { return []; },
  beforeMicrophoneCapture() { contentionCaptures += 1; },
  onRemoteStream() {},
  onState() {},
});
await contentionAlice.requestWorldTurn();
await contentionBob.requestWorldTurn();
assert.equal(contentionCaptures, 0, 'WORLD must wait for the contention window before claiming the microphone');
assert.equal(contentionAlice.snapshot().localWorld?.status, 'queued');
assert.equal(contentionBob.snapshot().localWorld?.status, 'queued');
contentionAlice.worldContentionUntil = 0;
contentionBob.worldContentionUntil = 0;
contentionAlice.tick();
contentionBob.tick();
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(
  [contentionAlice, contentionBob].filter(voice => voice.snapshot().localWorld?.status === 'speaking').length,
  1,
  'after queue convergence exactly one simultaneous WORLD requester may become speaker',
);
assert.equal(contentionCaptures, 1, 'WORLD contention must not capture two microphones');
contentionAlice.stop();
contentionBob.stop();

const demotionVoice = new GroupVoice();
const demotionPeerId = `nostr:${'1'.repeat(64)}`;
const demotionSignals = [];
const demotionWorldStates = [];
demotionVoice.start(`nostr:${'6'.repeat(64)}`, 'Demotion', '#35d07f', {
  sendSignal(peerId, signal) { demotionSignals.push({ peerId, signal: { ...signal } }); },
  publishWorld(state) { demotionWorldStates.push({ ...state }); },
  peers() { return [demotionPeerId]; },
  onRemoteStream() {},
  onState() {},
});
await demotionVoice.requestWorldTurn();
demotionVoice.worldContentionUntil = 0;
demotionVoice.tick();
await new Promise(resolve => setTimeout(resolve, 5));
const contendedRequestId = demotionVoice.snapshot().localWorld?.request_id;
assert.equal(demotionVoice.snapshot().localWorld?.status, 'speaking', 'the isolated WORLD requester must initially become speaker');
demotionVoice.updateWorldState({
  peer_id: demotionPeerId,
  nick: 'Earlier',
  nick_color: '#4f7cff',
  status: 'speaking',
  request_id: crypto.randomUUID(),
  joined_at: Date.now() - 5_000,
  speaking_until: Date.now() + 30_000,
});
demotionVoice.tick();
assert.equal(demotionVoice.snapshot().localWorld?.status, 'queued', 'a locally speaking WORLD loser must demote after queue convergence');
assert.notEqual(demotionVoice.snapshot().localWorld?.request_id, contendedRequestId, 'demotion must requeue with a fresh request id');
assert.ok(
  demotionSignals.some(({ signal }) => signal.action === 'world_release' && signal.request_id === contendedRequestId),
  'WORLD demotion must retire the losing request on every peer',
);
assert.ok(
  demotionWorldStates.some(state => state.status === 'idle' && state.request_id === contendedRequestId),
  'WORLD demotion must also publish an idle tombstone for the losing request',
);
demotionVoice.stop();

console.log('Group voice test passed: contention convergence, JOIN heartbeat, bounded recovery, exact hangup, room audio and stale-rejoin protection.');
