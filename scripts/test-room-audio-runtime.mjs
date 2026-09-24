import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-room-audio-runtime-'));

try {
  const sources = [
    path.resolve('src/audio-call-state.ts'),
    path.resolve('src/audio-media-engine.ts'),
    path.resolve('src/private-audio-call.ts'),
    path.resolve('src/room-audio-call.ts'),
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
    throw new Error(`Unable to compile room audio runtime sources:\n${compile.stdout}${compile.stderr}`);
  }

  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');
  const requireFromTemp = createRequire(pathToFileURL(path.join(tempDir, 'entry.cjs')));
  const { RoomAudioCallController } = requireFromTemp('./room-audio-call.js');

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
      if (!remote) throw new Error('Linked room-audio peer is not ready.');
      return remote.handleSignal({
        id: `runtime-signal-${++signalSequence}`,
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

  alice = new RoomAudioCallController(
    linkedSignaler('peer-alice', 'Alice', aliceOutbound, () => bob),
    {
      captureFactory: () => aliceCapture,
      peerFactory: callbacks => {
        const peer = new FakePeer(callbacks, 'alice');
        alicePeers.push(peer);
        return peer;
      },
      sessionIdFactory: (() => {
        let value = 0;
        return () => `alice-session-${++value}`;
      })(),
      events: {
        onSession: session => aliceSessions.push(session),
      },
    },
  );
  bob = new RoomAudioCallController(
    linkedSignaler('peer-bob', 'Bob', bobOutbound, () => alice),
    {
      captureFactory: () => bobCapture,
      peerFactory: callbacks => {
        const peer = new FakePeer(callbacks, 'bob');
        bobPeers.push(peer);
        return peer;
      },
      sessionIdFactory: (() => {
        let value = 0;
        return () => `bob-session-${++value}`;
      })(),
      events: {
        onSession: session => bobSessions.push(session),
      },
    },
  );

  await bob.joinRoom('world', [], 'listen');
  await alice.joinRoom('world', [{ peerId: 'peer-bob', nick: 'Bob' }], 'listen');

  if (aliceCapture.started !== 0 || bobCapture.started !== 0) {
    throw new Error('Listen-first WORLD join must not activate either microphone.');
  }
  if (!aliceOutbound.some(signal => signal.action === 'invite') || !bobOutbound.some(signal => signal.action === 'accept')) {
    throw new Error('Two room controllers must complete the authenticated invite/accept handshake.');
  }
  if (!aliceOutbound.some(signal => signal.action === 'offer') || !bobOutbound.some(signal => signal.action === 'answer')) {
    throw new Error('Two room controllers must negotiate offer/answer media signaling.');
  }

  alicePeers.at(-1)?.state('connected');
  bobPeers.at(-1)?.state('connected');
  if (alice.activeSession()?.phase !== 'connected' || bob.activeSession()?.phase !== 'connected') {
    throw new Error('Paired WORLD voice controllers must converge on connected state.');
  }

  await alice.setIntent('speak');
  if (aliceCapture.started !== 1 || alice.activeSession()?.roomIntent !== 'speak') {
    throw new Error('Want-to-speak must be the action that activates the microphone.');
  }
  const aliceAtBob = bob.activeSession()?.participants.get('peer-alice');
  if (!aliceAtBob || aliceAtBob.muted || !aliceAtBob.speaking) {
    throw new Error('Remote participant state must show an opted-in unmuted speaker.');
  }

  await alice.setMuted(true);
  const mutedAliceAtBob = bob.activeSession()?.participants.get('peer-alice');
  if (!mutedAliceAtBob?.muted || mutedAliceAtBob.speaking) {
    throw new Error('Remote participant state must stop speaking when the microphone is muted.');
  }

  await alice.switchInput('usb-mic');
  if (aliceCapture.switched.at(-1) !== 'usb-mic') {
    throw new Error('Active room voice must switch the selected microphone.');
  }

  await bob.setDeafened(true);
  if (!bob.activeSession()?.deafened) {
    throw new Error('A room listener must be able to deafen incoming audio independently.');
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
    throw new Error('WORLD reconnect must use one deterministic ICE restart offerer and complete a fresh offer/answer exchange.');
  }
  alicePeers.at(-1)?.state('connected');
  if (alice.activeSession()?.phase !== 'connected' || bob.activeSession()?.phase !== 'reconnecting') {
    throw new Error('Room reconnect state must remain active until every reconnecting peer reports connected.');
  }
  bobPeers.at(-1)?.state('connected');
  if (alice.activeSession()?.phase !== 'connected' || bob.activeSession()?.phase !== 'connected') {
    throw new Error('WORLD voice must recover both peers from reconnecting to connected after renegotiation succeeds.');
  }

  await alice.leaveRoom();
  if (
    alice.activeSession() !== undefined ||
    aliceSessions.at(-1)?.phase !== 'ended' ||
    !alicePeers.at(-1)?.closed ||
    aliceCapture.stopped !== 1
  ) {
    throw new Error('Leaving room voice must emit ended state, clear active state and release microphone/WebRTC resources.');
  }
  if (bob.activeSession()?.participants.has('peer-alice')) {
    throw new Error('Remote leave must remove the departed voice participant.');
  }
  await bob.leaveRoom();

  const rejected = [];
  const outsider = new RoomAudioCallController({
    send: async signal => { rejected.push(signal); },
  });
  const unsolicitedHandled = await outsider.handleSignal({
    id: 'unsolicited',
    session_id: 'unsolicited-session',
    peer_id: 'peer-alice',
    target_peer_id: 'peer-outsider',
    nick: 'Alice',
    scope: { kind: 'room', room_id: 'world' },
    action: 'invite',
    room_intent: 'listen',
    timestamp: Date.now(),
  });
  if (unsolicitedHandled || rejected.at(-1)?.action !== 'reject') {
    throw new Error('A client that did not join room voice must reject unsolicited room invites.');
  }

  class DeniedCapture extends FakeCapture {
    async start() {
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      throw error;
    }
  }
  const deniedErrors = [];
  const denied = new RoomAudioCallController(
    { send: async () => undefined },
    {
      captureFactory: () => new DeniedCapture('denied'),
      events: { onMediaError: error => deniedErrors.push(error) },
      sessionIdFactory: () => 'denied-session',
    },
  );
  await denied.joinRoom('world', [], 'listen');
  let permissionRejected = false;
  try {
    await denied.setIntent('speak');
  } catch (error) {
    permissionRejected = error?.code === 'permission_denied';
  }
  if (!permissionRejected || denied.activeSession()?.roomIntent !== 'listen' || deniedErrors.at(-1)?.code !== 'permission_denied') {
    throw new Error('Microphone permission failure must return to listen mode and expose a normalized permission error.');
  }
  await denied.leaveRoom();

  if (!bobSessions.some(session => session.participants.get('peer-alice')?.speaking === true)) {
    throw new Error('Session events must expose the active remote speaker for UI rendering.');
  }

  console.log('Room audio paired-controller runtime tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
