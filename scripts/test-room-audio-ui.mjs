import fs from 'node:fs';
import assert from 'node:assert/strict';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/room-audio-ui.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/room-audio-ui.css', import.meta.url), 'utf8');

assert.match(index, /src\/room-audio-ui\.ts/, 'room audio UI must be loaded by the desktop shell');
assert.match(source, /RoomAudioCallController/, 'room audio UI must use the tested room controller');
assert.match(source, /invoke\('send_voice_signal'/, 'room voice signaling must use the authenticated direct Tauri command');
assert.match(source, /invoke\('set_voice_policy'/, 'room voice opt-out must synchronize to the network runtime');
assert.match(source, /listen<DirectVoiceSignal>\('voice-signal'/, 'authenticated room voice signals must reach the controller');
assert.match(source, /controller\.joinRoom\(roomId, collectPeers\(\), 'listen'\)/, 'joining room voice must start listen-only and never open the microphone automatically');
assert.match(source, /controller\.setIntent\(session\.roomIntent === 'speak' \? 'listen' : 'speak'\)/, 'room voice must expose an explicit want-to-speak action');
assert.match(source, /data-room-audio-join/, 'WORLD and room headers need a clear join-voice action');
assert.match(source, /data-room-audio-intent/, 'room voice needs a listen/want-to-speak control');
assert.match(source, /data-room-audio-mute/, 'room voice needs microphone mute');
assert.match(source, /data-room-audio-deafen/, 'room voice needs incoming-audio mute');
assert.match(source, /data-room-audio-device/, 'room voice needs microphone selection');
assert.match(source, /data-room-audio-leave/, 'room voice needs an explicit leave action');
assert.match(source, /data-room-audio-enabled/, 'room voice needs a persistent full opt-out control');
assert.match(source, /participant\.speaking/, 'room voice must render participant speaking/microphone state');
assert.match(source, /remoteStreams/, 'room voice UI must own per-peer remote audio streams');
assert.doesNotMatch(source, /getUserMedia\s*\(/, 'UI wiring must not directly open the microphone before want-to-speak');
assert.match(css, /#roomAudioPanel/, 'room voice controls need dedicated visible styling');
assert.match(css, /room-audio-participant\.is-speaking/, 'participant speaking state needs visible styling');

console.log('Room audio UI contract checks passed.');
