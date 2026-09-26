let count = 0;
function check(condition, name) { count++; if (!condition) throw new Error(name); }
const native = new OfflineAudioContext(1, 48000, 48000);
for (const kind of ['incoming', 'outgoing']) {
  const samples = synthesizeCallTone(kind, native.sampleRate);
  const sound = native.createBuffer(1, samples.length, native.sampleRate);
  sound.copyToChannel(samples, 0);
  check(sound.getChannelData(0).some(value => Math.abs(value) > 0.01), `${kind} native buffer is audible PCM, not silence`);
}
const store = new Map();
const previousStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value),
} });
document.body.replaceChildren();
const style = document.createElement('style'); style.textContent = REPOSITORY_CSS; document.head.append(style);
const parent = document.createElement('div'); parent.style.width = '330px'; document.body.append(parent);
mountCallSoundSettings(parent);
const section = parent.querySelector('[data-call-sound-settings]');
const slider = parent.querySelector('[data-call-sound-volume]');
slider.focus();
let mutations = 0;
const observer = new MutationObserver(records => { mutations += records.length; mountCallSoundSettings(parent); });
observer.observe(parent, { childList: true, subtree: true });
for (let i = 0; i < 100; i++) mountCallSoundSettings(parent);
await Promise.resolve();
check(mutations === 0 && parent.querySelector('[data-call-sound-settings]') === section, 'repeated augmentation does not mutate or recreate settings');
check(document.activeElement === slider, 'focus survives unchanged augmentation');
slider.value = '30'; slider.dispatchEvent(new Event('input'));
check(store.get('konofix.callSoundVolume') === '0.3' && parent.querySelector('output').textContent === '30%', 'volume stored and displayed');
const incoming = parent.querySelector('[data-call-sound-enabled="incoming"]');
incoming.checked = false; incoming.dispatchEvent(new Event('change'));
check(store.get('konofix.callSoundIncoming') === '0', 'incoming toggle persists');
check(parent.querySelectorAll('[data-call-sound-preview]').length === 2, 'separate accessible previews');
for (const button of parent.querySelectorAll('button')) {
  const bounds = button.getBoundingClientRect(), owner = parent.getBoundingClientRect();
  check(bounds.width > 0 && bounds.right <= owner.right + 1, 'sound controls remain in bounds');
}
store.set('konofix.voiceNotificationsMuted', '1');
window.dispatchEvent(new Event('konofix-voice-preferences-changed'));
parent.querySelector('[data-call-sound-preview="outgoing"]').click();
check(parent.querySelector('[data-call-sound-status]').textContent === copy.quiet, 'global mute does not get bypassed by preview');
store.delete('konofix.voiceNotificationsMuted');
syncCallSoundSession({ id: 'active', phase: 'connected', deafened: false });
parent.querySelector('[data-call-sound-preview="outgoing"]').click();
check(parent.querySelector('[data-call-sound-status]').textContent === copy.quiet, 'preview cannot interrupt connected speech');
syncCallSoundSession(null);
observer.disconnect(); section.remove(); mountCallSoundSettings(parent);
check(parent.querySelector('[data-call-sound-volume]').value === '30', 'settings reopened with saved volume');
check(!parent.querySelector('[data-call-sound-enabled="incoming"]').checked, 'settings reopened with saved toggle');
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); },
} });
const input = parent.querySelector('[data-call-sound-volume]'); input.value = '25'; input.dispatchEvent(new Event('input'));
check(parent.querySelector('[data-call-sound-status]').textContent === copy.storage, 'storage errors remain nonfatal and visible');
player.dispose(); style.remove(); document.body.replaceChildren();
window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true);
window.removeEventListener('konofix-voice-preferences-changed', preferences);
if (previousStorage) Object.defineProperty(window, 'localStorage', previousStorage); else delete window.localStorage;
return { pass: true, checks: count, locale: currentLocale, nativePcm: true, physicalSpeakersTested: false };
