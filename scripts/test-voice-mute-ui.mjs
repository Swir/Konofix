import fs from 'node:fs';
import assert from 'node:assert/strict';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/voice-mute-ui.ts', import.meta.url), 'utf8');

assert.match(index, /src\/voice-mute-ui\.ts/, 'quiet-mode UI must be loaded by the desktop shell');
assert.match(source, /konofix\.voiceChatMuted/, 'chat mute must persist locally');
assert.match(source, /konofix\.voiceNotificationsMuted/, 'notification mute must persist locally');
assert.match(source, /data-voice-chat-muted/, 'settings must expose an explicit chat-mute control');
assert.match(source, /data-voice-notifications-muted/, 'settings must expose an explicit notification-mute control');
assert.match(source, /konofix-chat-muted/, 'chat mute must have a live UI state');
assert.match(source, /#messages[\s\S]*\.composer[\s\S]*\.private-messages[\s\S]*\.private-compose/, 'chat mute must hide public/private chat surfaces without deleting their state');
assert.match(source, /private-notice-wrap/, 'quiet mode must suppress intrusive private-message notifications');
assert.match(source, /#privateAudioIncoming/, 'notification mute must suppress the incoming-call popup');
assert.match(source, /chat is muted|Czat jest wyciszony/i, 'muted chat must show a clear local status banner');
assert.match(source, /window\.dispatchEvent\(new Event\(PREFERENCES_EVENT\)\)/, 'preference changes must propagate immediately');
assert.doesNotMatch(source, /invoke\(/, 'local quiet mode must not alter authenticated P2P transport policy');
assert.doesNotMatch(source, /removeItem\(|clear\(/, 'quiet mode must not delete stored chat data');

console.log('Voice chat/notification mute UI contract checks passed.');
