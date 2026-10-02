import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-private-audio-runtime-'));

try {
  const sources = [
    path.resolve('src/audio-call-state.ts'),
    path.resolve('src/audio-media-engine.ts'),
    path.resolve('src/private-audio-call.ts'),
  ];
  const compile = spawnSync(
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
  if (compile.status !== 0) {
    throw new Error(`Unable to compile private audio runtime sources:\n${compile.stdout}${compile.stderr}`);
  }

  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');
  const requireFromTemp = createRequire(pathToFileURL(path.join(tempDir, 'entry.cjs')));
  const { PrivateAudioCallController } = requireFromTemp('./private-audio-call.js');

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

  class FakeCapture {
    constructor(label) {
      this.label = label;
      this.stream = makeStream(`${label}-mic`);
      this.active = false;
      this.started = 0;
      this.stopped = 0;
      this.muted = false;
      this.switched = [];
    }
    async start() {
      this.started += 1;
      this.active = true;
      return this.stream;
    }
    stop() {
      if (this.active) this.stopped += 1;
      this.stream.getTracks().forEach(track => track.stop());
      this.active = false;
    }
    setMuted(value) {
      this.muted = value;
      this.stream.getAudioTracks().forEach(track => { track.enabled = !value; });
    }
    async switchInput(deviceId) {
      this.switched.push(deviceId);
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = makeStream(deviceId);
      this.active = true;
      return this.stream;
    }
    currentStream() {
      return this.active ? this.stream : null;
    }
    async listInputDevices() {
      return [{ deviceId: `${this.label}-mic`, groupId: this.label, label: `${this.label} mic`, isDefault: false }];
    }
  }

  class FakePeer {
    constructor(callbacks, label) {
      this.callbacks = callbacks;
      this.label = label;
      this.closed = false;
      this.localStreams = [];
      this.offers = [];
      this.answers = [];
      this.candidates = [];
      this.muted = false;
      this.restarts = 0;
    }
    async createOffer(stream) {
      if (stream) this.localStreams.push(stream);
      const value = `offer:${this.label}:${this.offers.length + 1}`;
      this.offers.push(value);
      return value;
    }
    async acceptOffer(sdp, stream) {
      this.offers.push(sdp);
      if (stream) this.localStreams.push(stream);
      const value = `answer:${this.label}:${this.answers.length + 1}`;
      this.answers.push(value);
      return value;
    }
    async acceptAnswer(sdp) { this.answers.push(sdp); }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    async setLocalStream(stream) { this.localStreams.push(stream); }
    setMuted(value) { this.muted = value; }
    restartIce() { this.restarts += 1; }
    close() { this.closed = true; }
    state(value) { this.callbacks.onConnectionState?.(value); }
  }

  let signalSequence = 0;
  let alice;
  let bob;
  const aliceOutbound = [];
  const bobOutbound = [];
  const linkedSignaler = (sourcePeerId, sourceNick, outbound, remoteController) => ({
    async send(signal) {
      outbound.push(signal);
      const remote = remoteController();
      if (!remote) throw new Error('Linked private-audio peer is not ready.');
      return remote.handleSignal({
        id: `private-runtime-signal-${++signalSequence}`,
        session_id: signal.sessionId,
        peer_id: sourcePeerId,
        target_peer_id: signal.peerId,
        nick: sourceNick,
        scope: signal.scope,
        action: signal.action,
        sdp: signal.sdp ?? null,
        candidate: signal.candidate ?? null,
        room_intent: signal.roomIntent ?? null,
        muted: signal.muted ?? null,
        timestamp: Date.now(),
      });
    },
  });

  const aliceCapture = new FakeCapture('alice');
  const bobCapture = new FakeCapture('bob');
  const alicePeers = [];
  const bobPeers = [];
  const aliceSessions = [];
  const bobSessions = [];

  alice = new PrivateAudioCallController(
    linkedSignaler('peer-alice', 'Alice', aliceOutbound, () => bob),
    {
      captureFactory: () => aliceCapture,
      peerFactory: callbacks => {
        const peer = new FakePeer(callbacks, 'alice');
        alicePeers.push(peer);
        return peer;
      },
      sessionIdFactory: () => '11111111-1111-4111-8111-111111111111',
      events: { onSession: session => aliceSessions.push(session) },
    },
  );
  bob = new PrivateAudioCallController(
    linkedSignaler('peer-bob', 'Bob', bobOutbound, () => alice),
    {
      captureFactory: () => bobCapture,
      peerFactory: callbacks => {
        const peer = new FakePeer(callbacks, 'bob');
        bobPeers.push(peer);
        return peer;
      },
      sessionIdFactory: () => '22222222-2222-4222-8222-222222222222',
      events: { onSession: session => bobSessions.push(session) },
    },
  );

  await alice.startPrivateCall('peer-bob', 'Bob');
  if (aliceCapture.started !== 0 || bobCapture.started !== 0) {
    throw new Error('Private invite/ringing must not activate either microphone before explicit acceptance.');
  }
  if (alice.activeSession()?.phase !== 'calling' || bob.activeSession()?.phase !== 'ringing') {
    throw new Error('Linked private controllers must converge on calling/ringing before acceptance.');
  }
  if (aliceOutbound.at(-1)?.action !== 'invite') {
    throw new Error('Private call setup must start with the authenticated direct invite action.');
  }

  await bob.acceptPrivateCall();
  if (aliceCapture.started !== 1 || bobCapture.started !== 1) {
    throw new Error('Both microphones must start only after the callee explicitly accepts.');
  }
  if (!aliceOutbound.some(signal => signal.action === 'offer') || !bobOutbound.some(signal => signal.action === 'answer')) {
    throw new Error('Paired private controllers must complete direct offer/answer signaling after acceptance.');
  }

  alicePeers.at(-1)?.state('connected');
  bobPeers.at(-1)?.state('connected');
  if (alice.activeSession()?.phase !== 'connected' || bob.activeSession()?.phase !== 'connected') {
    throw new Error('Paired private controllers must both reach connected state.');
  }

  await alice.setMuted(true);
  const aliceAtBob = bob.activeSession()?.participants.get('peer-alice');
  if (!aliceAtBob?.muted || aliceAtBob.speaking) {
    throw new Error('Authenticated private state signaling must expose remote microphone mute.');
  }
  await alice.setDeafened(true);
  if (!alice.activeSession()?.deafened) {
    throw new Error('Private incoming-audio deafening must remain an independent local state.');
  }
  await bob.switchInput('usb-bob-mic');
  if (bobCapture.switched.at(-1) !== 'usb-bob-mic') {
    throw new Error('Accepted private calls must support explicit microphone selection.');
  }

  const aliceOffersBeforeRestart = aliceOutbound.filter(signal => signal.action === 'offer').length;
  const bobOffersBeforeRestart = bobOutbound.filter(signal => signal.action === 'offer').length;
  const bobAnswersBeforeRestart = bobOutbound.filter(signal => signal.action === 'answer').length;
  alicePeers.at(-1)?.state('disconnected');
  alicePeers.at(-1)?.state('disconnected');
  bobPeers.at(-1)?.state('disconnected');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  if (
    alice.activeSession()?.phase !== 'reconnecting' ||
    bob.activeSession()?.phase !== 'reconnecting' ||
    alicePeers.at(-1)?.restarts !== 1 ||
    bobPeers.at(-1)?.restarts !== 0 ||
    aliceOutbound.filter(signal => signal.action === 'offer').length !== aliceOffersBeforeRestart + 1 ||
    bobOutbound.filter(signal => signal.action === 'offer').length !== bobOffersBeforeRestart ||
    bobOutbound.filter(signal => signal.action === 'answer').length !== bobAnswersBeforeRestart + 1
  ) {
    throw new Error('Private reconnect must use one deterministic ICE restart offerer and a fresh direct offer/answer exchange.');
  }
  alicePeers.at(-1)?.state('connected');
  bobPeers.at(-1)?.state('connected');
  if (alice.activeSession()?.phase !== 'connected' || bob.activeSession()?.phase !== 'connected') {
    throw new Error('Private reconnect must recover both controllers to connected.');
  }

  await alice.endPrivateCall();
  if (
    alice.activeSession() !== undefined || bob.activeSession() !== undefined ||
    aliceSessions.at(-1)?.phase !== 'ended' || bobSessions.at(-1)?.phase !== 'ended' ||
    !alicePeers.at(-1)?.closed || !bobPeers.at(-1)?.closed ||
    aliceCapture.stopped !== 1 || bobCapture.stopped !== 1
  ) {
    throw new Error('Private hang-up must converge both peers on ended and release microphone/WebRTC resources.');
  }
  if (aliceOutbound.at(-1)?.action !== 'end') {
    throw new Error('Private hang-up must use authenticated direct end signaling.');
  }


  {
    let releaseEnd;
    const endGate = new Promise(resolve => { releaseEnd = resolve; });
    let endSignalStarted = false;
    const slowCapture = new FakeCapture('slow-end');
    const slowPeers = [];
    const slowController = new PrivateAudioCallController(
      {
        async send(signal) {
          if (signal.action === 'end') {
            endSignalStarted = true;
            await endGate;
          }
        },
      },
      {
        captureFactory: () => slowCapture,
        peerFactory: callbacks => {
          const peer = new FakePeer(callbacks, 'slow-end');
          slowPeers.push(peer);
          return peer;
        },
        sessionIdFactory: () => '55555555-5555-4555-8555-555555555555',
      },
    );
    await slowController.startPrivateCall('peer-slow', 'Slow peer');
    await slowController.handleSignal({
      id: 'slow-private-accept',
      session_id: '55555555-5555-4555-8555-555555555555',
      peer_id: 'peer-slow',
      target_peer_id: 'peer-local',
      nick: 'Slow peer',
      scope: { kind: 'private' },
      action: 'accept',
      timestamp: Date.now(),
    });
    const ending = slowController.endPrivateCall();
    await new Promise(resolve => setImmediate(resolve));
    if (
      !endSignalStarted ||
      slowController.activeSession() !== undefined ||
      slowCapture.stopped !== 1 ||
      !slowPeers.at(-1)?.closed
    ) {
      throw new Error('Private hang-up must release microphone/WebRTC immediately without waiting for slow end signaling.');
    }
    releaseEnd();
    await ending;
  }

  let blockedCaller;
  let blockedCallee;
  const blockedCallerCapture = new FakeCapture('blocked-caller');
  const blockedCalleeCapture = new FakeCapture('blocked-callee');
  const blockedCallerOutbound = [];
  const blockedCalleeOutbound = [];
  blockedCaller = new PrivateAudioCallController(
    linkedSignaler('peer-caller', 'Caller', blockedCallerOutbound, () => blockedCallee),
    {
      captureFactory: () => blockedCallerCapture,
      peerFactory: callbacks => new FakePeer(callbacks, 'blocked-caller'),
      sessionIdFactory: () => '33333333-3333-4333-8333-333333333333',
    },
  );
  blockedCallee = new PrivateAudioCallController(
    linkedSignaler('peer-callee', 'Callee', blockedCalleeOutbound, () => blockedCaller),
    {
      captureFactory: () => blockedCalleeCapture,
      peerFactory: callbacks => new FakePeer(callbacks, 'blocked-callee'),
      sessionIdFactory: () => '44444444-4444-4444-8444-444444444444',
    },
  );
  blockedCallee.sessions.setPreferences({ allowPrivateCalls: false });
  await blockedCaller.startPrivateCall('peer-callee', 'Callee');
  if (
    blockedCaller.activeSession() !== undefined || blockedCallee.activeSession() !== undefined ||
    blockedCallerCapture.started !== 0 || blockedCalleeCapture.started !== 0 ||
    blockedCalleeOutbound.at(-1)?.action !== 'reject'
  ) {
    throw new Error('Private voice opt-out must reject direct invites without activating media on either side.');
  }

  console.log('Private audio paired-controller runtime tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
