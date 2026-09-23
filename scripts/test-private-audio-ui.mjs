import fs from 'node:fs';
import assert from 'node:assert/strict';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/private-audio-ui.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/private-audio-ui.css', import.meta.url), 'utf8');

assert.match(index, /src\/private-audio-ui\.ts/, 'private audio UI must be loaded by the desktop shell');
assert.match(source, /PrivateAudioCallController/, 'private audio UI must use the tested call controller');
assert.match(source, /invoke\('send_voice_signal'/, 'voice signaling must use the authenticated Tauri command');
assert.match(source, /invoke\('set_voice_policy'/, 'voice opt-out must synchronize to the network runtime');
assert.match(source, /listen<DirectVoiceSignal>\('voice-signal'/, 'incoming authenticated voice signals must reach the call controller');
assert.match(source, /data-private-audio-accept/, 'incoming calls need an explicit accept action');
assert.match(source, /data-private-audio-reject/, 'incoming calls need an explicit reject action');
assert.match(source, /data-private-audio-mute/, 'active calls need microphone mute');
assert.match(source, /data-private-audio-deafen/, 'active calls need incoming-audio mute');
assert.match(source, /data-private-audio-device/, 'active calls need microphone selection');
assert.match(source, /data-private-audio-end/, 'active calls need an explicit leave/end action');
assert.match(source, /PRIVATE_CALLS_ENABLED_KEY/, 'private-call opt-out must persist locally');
assert.match(source, /defaultDeafened/, 'default listen opt-out must be represented');
assert.doesNotMatch(source, /getUserMedia\s*\(/, 'UI wiring must not directly open the microphone before call acceptance');
assert.match(css, /#privateAudioPanel/, 'active call controls need dedicated visible styling');
assert.match(css, /private-audio-incoming-wrap/, 'incoming call prompt needs dedicated visible styling');

console.log('Private audio UI contract checks passed.');
