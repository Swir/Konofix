import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const sourcePath = 'src/room-audio-call.ts';
const source = fs.readFileSync(sourcePath, 'utf8');

const compile = spawnSync(
  'npx',
  [
    'tsc', sourcePath,
    '--noEmit',
    '--ignoreConfig',
    '--target', 'ES2022',
    '--module', 'ES2022',
    '--moduleResolution', 'bundler',
    '--lib', 'ES2022,DOM',
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
  throw new Error(`Unable to type-check room-audio-call.ts:\n${compile.stdout}${compile.stderr}`);
}

assert.match(source, /intent: Exclude<RoomVoiceIntent, 'none'> = 'listen'/,
  'room voice must join in listen mode by default');
assert.match(source, /if \(intent === 'speak'\) \{[\s\S]*?await capture\.start\(\)/,
  'microphone capture must be gated behind explicit speak intent');
assert.match(source, /runtime\.capture\?\.stop\(\)/,
  'returning to listen/leave must release microphone capture');
assert.match(source, /Choose want-to-speak before enabling the microphone/,
  'unmute must fail closed until the user explicitly chooses speak');
assert.match(source, /!runtime \|\| runtime\.roomId !== roomId \|\| !this\.sessions\.canJoinRoomVoice\(\)/,
  'incoming room invites must be rejected unless this client explicitly joined the same room voice scope');
assert.match(source, /scope: roomScope\(runtime\.roomId\)/,
  'all room signaling must keep an explicit direct room scope');
assert.match(source, /MAX_ROOM_VOICE_PEERS = 24/,
  'room mesh fan-out must be bounded');
assert.match(source, /Promise\.allSettled\([\s\S]*?'end'/,
  'leaving room voice must best-effort signal every connected peer');
assert.match(source, /existing\.sessionId\.localeCompare\(signal\.session_id\) < 0/,
  'simultaneous room-join invites need deterministic collision handling');
assert.match(source, /setDeafened\(deafened: boolean\)/,
  'room voice must preserve a local incoming-audio opt-out');
assert.match(source, /switchInput\(deviceId: string\)/,
  'room voice must support explicit microphone selection while speaking');
assert.doesNotMatch(source, /GossipSub|publish|public fallback/i,
  'room media signaling controller must not add a public signaling fallback');

console.log('Room audio controller contract checks passed.');
await import('./test-room-audio-runtime.mjs');
