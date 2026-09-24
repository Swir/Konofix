import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testCaptureLifecycle } from './test-audio-capture-lifecycle.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-audio-media-'));
try {
  const sources = [
    path.resolve('src/audio-call-state.ts'),
    path.resolve('src/audio-media-engine.ts'),
    path.resolve('src/private-audio-call.ts'),
  ];
  const result = spawnSync(
    'npx',
    [
      'tsc', ...sources,
      '--ignoreConfig',
      '--target', 'ES2022',
      '--module', 'commonjs',
      '--moduleResolution', 'bundler',
      '--lib', 'ES2022,DOM,DOM.Iterable',
      '--outDir', tempDir,
      '--skipLibCheck',
      '--pretty', 'false',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to compile audio media/controller sources for tests:\n${result.stdout}${result.stderr}`);
  }
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');
  const requireFromTemp = createRequire(pathToFileURL(path.join(tempDir, 'entry.cjs')));
  const media = requireFromTemp('./audio-media-engine.js');
  const calls = requireFromTemp('./private-audio-call.js');
  await testCaptureLifecycle(media);

  const makeTrack = deviceId => ({
    kind: 'audio',
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; },
    getSettings() { return { deviceId }; },
  });
  const makeStream = deviceId => {
    const track = makeTrack(deviceId);
    return {
      track,
      getTracks() { return [track]; },
      getAudioTracks() { return [track]; },
    };
  };

  const grantedStream = makeStream('permission');
  const firstStream = makeStream('mic-1');
  const secondStream = makeStream('mic-2');
  const captureQueue = [grantedStream, firstStream, secondStream];
  const fakeDevices = {
    requests: [],
    async getUserMedia(constraints) {
      this.requests.push(constraints);
      const stream = captureQueue.shift();
      if (!stream) throw new Error('Unexpected getUserMedia call.');
      return stream;
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'default', groupId: 'g0', label: 'Default mic' },
        { kind: 'audioinput', deviceId: 'mic-2', groupId: 'g1', label: 'USB mic' },
        { kind: 'videoinput', deviceId: 'cam', groupId: 'g2', label: 'Camera' },
      ];
    },
  };

  const capture = new media.AudioCaptureController(fakeDevices);
  const devices = await capture.listInputDevices(true);
  if (devices.length !== 2 || !devices[0].isDefault || !grantedStream.track.stopped) {
    throw new Error('Microphone enumeration must be permission-aware and stop the temporary permission stream.');
  }
  await capture.start();
  capture.setMuted(true);
  if (!capture.isMuted() || firstStream.track.enabled) {
    throw new Error('Microphone mute must disable the current local audio track.');
  }
  await capture.switchInput('mic-2');
  if (!firstStream.track.stopped || secondStream.track.enabled) {
    throw new Error('Device switching must stop the old stream and preserve mute state.');
  }
  capture.stop();
  if (!secondStream.track.stopped || capture.currentStream() !== null) {
    throw new Error('Stopping capture must release the selected microphone.');
  }

  const denied = new Error('no');
  denied.name = 'NotAllowedError';
  const normalized = media.normalizeAudioMediaError(denied);
  if (normalized.code !== 'permission_denied') {
    throw new Error('Microphone permission denial must be normalized to a user-facing permission error.');
  }
  const candidate = media.decodeIceCandidate(JSON.stringify({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host', sdpMid: '0' }));
  if (!candidate.candidate.startsWith('candidate:1') || candidate.sdpMid !== '0') {
    throw new Error('ICE candidate decoding must preserve bounded candidate metadata.');
  }

  class FakeCapture {
    constructor() {
      this.stream = makeStream('private-mic');
      this.started = 0;
      this.stopped = 0;
      this.muted = false;
      this.switched = [];
    }
    async start() { this.started += 1; return this.stream; }
    stop() { this.stopped += 1; this.stream.getTracks().forEach(track => track.stop()); }
    setMuted(value) { this.muted = value; this.stream.getAudioTracks().forEach(track => { track.enabled = !value; }); }
    async switchInput(deviceId) { this.switched.push(deviceId); this.stream = makeStream(deviceId); return this.stream; }
    currentStream() { return this.started ? this.stream : null; }
    async listInputDevices() { return [{ deviceId: 'private-mic', groupId: 'g', label: 'Private mic', isDefault: false }]; }
  }

  class FakePeer {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.closed = false;
      this.localStreams = [];
      this.answers = [];
      this.candidates = [];
      this.restarts = 0;
    }
    async createOffer(stream) { if (stream) this.localStreams.push(stream); return 'offer-sdp'; }
    async acceptOffer(sdp, stream) { this.answers.push(sdp); this.localStreams.push(stream); return 'answer-sdp'; }
    async acceptAnswer(sdp) { this.answers.push(sdp); }
    async addIceCandidate(candidateValue) { this.candidates.push(candidateValue); }
    async setLocalStream(stream) { this.localStreams.push(stream); }
    setMuted(value) { this.muted = value; }
    restartIce() { this.restarts += 1; }
    close() { this.closed = true; }
    state(value) { this.callbacks.onConnectionState?.(value); }
    ice(value) { return this.callbacks.onIceCandidate?.(value); }
  }

  const outbound = [];
  const callerCapture = new FakeCapture();
  let callerPeer;
  const caller = new calls.PrivateAudioCallController(
    { send: async signal => { outbound.push(signal); } },
    {
      captureFactory: () => callerCapture,
      peerFactory: callbacks => (callerPeer = new FakePeer(callbacks)),
      sessionIdFactory: () => '11111111-1111-4111-8111-111111111111',
    },
  );
  await caller.startPrivateCall('peer-b', 'Bob');
  if (callerCapture.started !== 0 || outbound[0]?.action !== 'invite') {
    throw new Error('Outgoing invite must not activate the microphone before the remote peer accepts.');
  }
  await caller.handleSignal({
    id: 'sig-accept', session_id: '11111111-1111-4111-8111-111111111111', peer_id: 'peer-b', target_peer_id: 'peer-a',
    nick: 'Bob', scope: { kind: 'private' }, action: 'accept', timestamp: Date.now(),
  });
  if (callerCapture.started !== 1 || !outbound.some(signal => signal.action === 'offer' && signal.sdp === 'offer-sdp')) {
    throw new Error('Accepted outgoing calls must acquire audio and emit a WebRTC offer over the direct signaler.');
  }
  await caller.handleSignal({
    id: 'sig-answer', session_id: '11111111-1111-4111-8111-111111111111', peer_id: 'peer-b', target_peer_id: 'peer-a',
    nick: 'Bob', scope: { kind: 'private' }, action: 'answer', sdp: 'answer-sdp', timestamp: Date.now(),
  });
  callerPeer.state('connected');
  if (caller.activeSession()?.phase !== 'connected') {
    throw new Error('WebRTC connected state must promote the private call to connected.');
  }

  const privateOffersBeforeRestart = outbound.filter(signal => signal.action === 'offer').length;
  callerPeer.state('disconnected');
  await new Promise(resolve => setImmediate(resolve));
  if (
    caller.activeSession()?.phase !== 'reconnecting' ||
    callerPeer.restarts !== 1 ||
    outbound.filter(signal => signal.action === 'offer').length !== privateOffersBeforeRestart + 1
  ) {
    throw new Error('Outgoing private-call reconnect must restart ICE and send a fresh authenticated offer.');
  }
  await caller.handleSignal({
    id: 'sig-reconnect-answer', session_id: '11111111-1111-4111-8111-111111111111', peer_id: 'peer-b', target_peer_id: 'peer-a',
    nick: 'Bob', scope: { kind: 'private' }, action: 'answer', sdp: 'reconnect-answer-sdp', timestamp: Date.now(),
  });
  callerPeer.state('connected');
  if (caller.activeSession()?.phase !== 'connected') {
    throw new Error('Private-call reconnect must recover from reconnecting to connected after the restart answer.');
  }

  await caller.setMuted(true);
  if (!caller.activeSession()?.localMuted || !outbound.some(signal => signal.action === 'state' && signal.muted === true)) {
    throw new Error('Private-call microphone mute must update local state and authenticated peer state.');
  }
  await caller.switchInput('usb-mic');
  if (callerCapture.switched.at(-1) !== 'usb-mic') {
    throw new Error('Active private calls must support explicit microphone switching.');
  }
  await caller.endPrivateCall();
  if (!callerPeer.closed || callerCapture.stopped !== 1 || outbound.at(-1)?.action !== 'end') {
    throw new Error('Ending a private call must signal the peer and release local audio/WebRTC resources.');
  }

  const incomingOutbound = [];
  const incomingCapture = new FakeCapture();
  let incomingPeer;
  const incoming = new calls.PrivateAudioCallController(
    { send: async signal => { incomingOutbound.push(signal); } },
    {
      captureFactory: () => incomingCapture,
      peerFactory: callbacks => (incomingPeer = new FakePeer(callbacks)),
      sessionIdFactory: () => '22222222-2222-4222-8222-222222222222',
    },
  );
  await incoming.handleSignal({
    id: 'sig-invite', session_id: '33333333-3333-4333-8333-333333333333', peer_id: 'peer-a', target_peer_id: 'peer-b',
    nick: 'Alice', scope: { kind: 'private' }, action: 'invite', timestamp: Date.now(),
  });
  if (incoming.activeSession()?.phase !== 'ringing' || incomingCapture.started !== 0) {
    throw new Error('Incoming private calls must ring without activating the microphone.');
  }
  await incoming.acceptPrivateCall();
  if (incomingCapture.started !== 1 || incomingOutbound.at(-1)?.action !== 'accept') {
    throw new Error('Accepting an incoming private call must explicitly acquire audio before signaling acceptance.');
  }
  await incoming.handleSignal({
    id: 'sig-offer', session_id: '33333333-3333-4333-8333-333333333333', peer_id: 'peer-a', target_peer_id: 'peer-b',
    nick: 'Alice', scope: { kind: 'private' }, action: 'offer', sdp: 'offer-sdp', timestamp: Date.now(),
  });
  if (!incomingOutbound.some(signal => signal.action === 'answer' && signal.sdp === 'answer-sdp')) {
    throw new Error('Accepted incoming calls must answer the authenticated WebRTC offer.');
  }
  incomingPeer.state('connected');
  if (incoming.activeSession()?.phase !== 'connected') {
    throw new Error('Incoming private audio must reach connected state after WebRTC connects.');
  }

  const incomingAnswersBeforeRestart = incomingOutbound.filter(signal => signal.action === 'answer').length;
  incomingPeer.state('disconnected');
  if (incoming.activeSession()?.phase !== 'reconnecting' || incomingPeer.restarts !== 0) {
    throw new Error('Incoming private-call side must wait for the deterministic offerer to restart ICE.');
  }
  await incoming.handleSignal({
    id: 'sig-reconnect-offer', session_id: '33333333-3333-4333-8333-333333333333', peer_id: 'peer-a', target_peer_id: 'peer-b',
    nick: 'Alice', scope: { kind: 'private' }, action: 'offer', sdp: 'restart-offer-sdp', timestamp: Date.now(),
  });
  if (incomingOutbound.filter(signal => signal.action === 'answer').length !== incomingAnswersBeforeRestart + 1) {
    throw new Error('Incoming private-call side must answer a reconnect offer while in reconnecting state.');
  }
  incomingPeer.state('connected');
  if (incoming.activeSession()?.phase !== 'connected') {
    throw new Error('Incoming private-call side must return to connected after restart negotiation succeeds.');
  }
  await incoming.endPrivateCall();

  const blockedOutbound = [];
  const blocked = new calls.PrivateAudioCallController({ send: async signal => { blockedOutbound.push(signal); } });
  blocked.sessions.setPreferences({ allowPrivateCalls: false });
  const handled = await blocked.handleSignal({
    id: 'sig-blocked', session_id: '44444444-4444-4444-8444-444444444444', peer_id: 'peer-x', target_peer_id: 'peer-y',
    nick: 'Blocked', scope: { kind: 'private' }, action: 'invite', timestamp: Date.now(),
  });
  if (handled || blocked.activeSession() || blockedOutbound.at(-1)?.action !== 'reject') {
    throw new Error('Private voice opt-out must reject the invite without creating an active media session.');
  }

  console.log('Audio media engine and private-call controller tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
