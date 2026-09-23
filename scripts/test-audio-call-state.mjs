import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = path.resolve('src/audio-call-state.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-audio-call-state-'));
try {
  const result = spawnSync(
    'npx',
    [
      'tsc', sourcePath,
      '--target', 'ES2022',
      '--module', 'ES2022',
      '--moduleResolution', 'bundler',
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
    throw new Error(`Unable to compile audio-call-state.ts for tests:\n${result.stdout}${result.stderr}`);
  }

  const output = fs.readFileSync(path.join(tempDir, 'audio-call-state.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  const mod = await import(moduleUrl);
  const store = new mod.VoiceSessionStore();

  const privateScope = mod.privateVoiceScope('peer-a');
  const roomScope = mod.roomVoiceScope('world');

  const outgoing = store.begin('call-1', privateScope, 'calling');
  if (outgoing.phase !== 'calling' || outgoing.localMuted || outgoing.deafened) {
    throw new Error('Private call must start in an explicit outgoing calling state.');
  }
  const joiningOutgoing = store.transition(privateScope, 'joining', 90);
  if (joiningOutgoing.phase !== 'joining') {
    throw new Error('Accepted outgoing calls must be able to enter the joining phase before WebRTC connects.');
  }
  const connected = store.transition(privateScope, 'connected', 100);
  if (connected.phase !== 'connected' || connected.startedAt !== 100) {
    throw new Error('Connected private call must record its first connected timestamp.');
  }
  store.transition(privateScope, 'reconnecting', 110);
  const reconnected = store.transition(privateScope, 'connected', 120);
  if (reconnected.startedAt !== 100) {
    throw new Error('Reconnect must preserve the original connected timestamp.');
  }
  store.setLocalMuted(privateScope, true);
  store.setDeafened(privateScope, true);
  const muted = store.session(privateScope);
  if (!muted?.localMuted || !muted.deafened) {
    throw new Error('Microphone mute and local deafening must remain independent controls.');
  }
  store.transition(privateScope, 'ended', 130);

  store.setPreferences({ allowPrivateCalls: false });
  let blockedPrivate = false;
  try {
    store.begin('call-blocked', mod.privateVoiceScope('peer-b'), 'ringing');
  } catch {
    blockedPrivate = true;
  }
  if (!blockedPrivate) {
    throw new Error('Disabled incoming private voice must fail closed before a ringing session is created.');
  }

  const room = store.begin('room-1', roomScope, 'joining');
  if (room.roomIntent !== 'listen') {
    throw new Error('Room voice must be opt-in listen by default, never implicit microphone publication.');
  }
  const speaking = store.setRoomIntent(roomScope, 'speak');
  if (speaking.localMuted || speaking.roomIntent !== 'speak') {
    throw new Error('Explicit speak intent must enable the local microphone state.');
  }
  const listening = store.setRoomIntent(roomScope, 'listen');
  if (!listening.localMuted || listening.roomIntent !== 'listen') {
    throw new Error('Returning to listen mode must mute local microphone publication.');
  }
  store.setDeafened(roomScope, true);
  if (!store.session(roomScope)?.deafened) {
    throw new Error('Room listener must be able to silence all incoming voice.');
  }

  store.upsertParticipant(roomScope, { peerId: 'peer-a', nick: 'Alice', muted: false, speaking: true });
  store.upsertParticipant(roomScope, { peerId: 'peer-b', nick: 'Bob', muted: true, speaking: false });
  if (store.session(roomScope)?.participants.size !== 2) {
    throw new Error('Room voice participant state must track multiple opt-in peers.');
  }
  store.removeParticipant(roomScope, 'peer-b');
  if (store.session(roomScope)?.participants.size !== 1) {
    throw new Error('Leaving voice must remove only the selected participant.');
  }

  store.setPreferences({ allowRoomVoice: false, chatMuted: true, notificationsMuted: true });
  if (store.canJoinRoomVoice() || !store.getPreferences().chatMuted || !store.getPreferences().notificationsMuted) {
    throw new Error('Voice/chat/notification opt-out preferences must remain explicit and independent.');
  }
  let blockedRoom = false;
  try {
    store.begin('room-blocked', mod.roomVoiceScope('other-room'), 'joining');
  } catch {
    blockedRoom = true;
  }
  if (!blockedRoom) {
    throw new Error('Disabled room voice must fail closed before joining.');
  }

  store.reset();
  if (store.session(privateScope) || store.session(roomScope)) {
    throw new Error('Network/session reset must clear transient voice state.');
  }

  console.log('Audio call state and opt-out tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

await import('./test-audio-media-engine.mjs');
