import { currentLocale } from './i18n';
import { CallSoundPlayer, boundedCallVolume, type CallSoundState, type CallSoundStatus } from './call-sounds';
import './call-sounds.css';

const KEYS = {
  incoming: 'konofix.callSoundIncoming', outgoing: 'konofix.callSoundOutgoing', volume: 'konofix.callSoundVolume',
};
const copy = currentLocale === 'pl' ? {
  title: 'Dźwięki połączeń', incoming: 'Dzwonek połączenia przychodzącego', outgoing: 'Sygnał oczekiwania „biiip… biiip…”',
  volume: 'Głośność dzwonków', preview: 'Odsłuchaj', stop: 'Zatrzymaj odsłuch',
  help: 'Dźwięki są lokalne i nie są wysyłane rozmówcy. Wyciszenie powiadomień lub odsłuchu wycisza również dzwonki.',
  blocked: 'Kliknij Odsłuchaj, aby włączyć dźwięki w tym oknie.', unavailable: 'Dźwięk powiadomień jest niedostępny. Rozmowy audio nie zostały wyłączone.',
  quiet: 'Dzwonki są wyciszone lub trwa rozmowa. Odsłuch jest wtedy niedostępny.', storage: 'Nie udało się zapisać ustawień; zmiana obowiązuje do zamknięcia aplikacji.',
} : {
  title: 'Call sounds', incoming: 'Incoming call ringtone', outgoing: 'Outgoing ringback “beep… beep…”',
  volume: 'Ringtone volume', preview: 'Preview', stop: 'Stop preview',
  help: 'Sounds are local and are not sent to the other participant. Muting notifications or incoming audio also silences ringtones.',
  blocked: 'Click Preview to enable sounds in this window.', unavailable: 'Notification audio is unavailable. Audio calls have not been disabled.',
  quiet: 'Ringtones are muted or a call is active. Preview is unavailable.', storage: 'Could not save preferences; changes last until the app closes.',
};

const memory = new Map<string, string>();
function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key); } catch { return null; }
}
function enabled(key: string): boolean { return read(key) !== '0'; }
function volume(): number {
  const value = read(KEYS.volume);
  return value === null || value.trim() === '' ? 0.45 : boundedCallVolume(Number(value));
}
function quiet(): boolean {
  return read('konofix.voiceNotificationsMuted') === '1'
    || read('konofix.voiceDefaultDeafened') === '1' || !enabled('konofix.privateCallsEnabled');
}
function status(message: string): void {
  document.querySelectorAll<HTMLElement>('[data-call-sound-status]').forEach(node => {
    if (node.textContent !== message) node.textContent = message;
  });
}
let lastStatus: CallSoundStatus = 'idle';
const player = new CallSoundPlayer(undefined, value => {
  lastStatus = value;
  status(value === 'blocked' ? copy.blocked : value === 'unavailable' ? copy.unavailable : '');
});
function preferences(): void {
  player.configure({ incoming: enabled(KEYS.incoming), outgoing: enabled(KEYS.outgoing), volume: volume(), quiet: quiet() });
}
function save(key: string, value: string): void {
  memory.set(key, value);
  let failed = false;
  try { localStorage.setItem(key, value); } catch { failed = true; }
  preferences();
  if (failed) status(copy.storage);
}

export function syncCallSoundSession(session: CallSoundState | null): void {
  preferences();
  player.setCall(session);
}

/** Called by the existing private-audio UI augmentation. No extra DOM observer. */
export function mountCallSoundSettings(parent: HTMLElement): void {
  if (parent.querySelector('[data-call-sound-settings]')) return;
  const section = document.createElement('section');
  section.className = 'private-settings-card call-sound-settings';
  section.dataset.callSoundSettings = 'true';
  const heading = document.createElement('strong'); heading.textContent = copy.title;
  const help = document.createElement('small'); help.textContent = copy.help;
  section.append(heading, help);
  for (const kind of ['incoming', 'outgoing'] as const) {
    const row = document.createElement('div'); row.className = 'call-sound-row';
    const label = document.createElement('label'); label.className = 'private-setting-toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = enabled(KEYS[kind]);
    input.dataset.callSoundEnabled = kind;
    const text = document.createElement('span'); text.textContent = copy[kind];
    label.append(input, text);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost';
    button.dataset.callSoundPreview = kind; button.textContent = copy.preview;
    button.setAttribute('aria-label', `${copy.preview}: ${copy[kind]}`);
    input.addEventListener('change', () => save(KEYS[kind], input.checked ? '1' : '0'));
    button.addEventListener('click', () => { preferences(); if (!player.preview(kind)) status(copy.quiet); });
    row.append(label, button); section.append(row);
  }
  const sliderLabel = document.createElement('label'); sliderLabel.className = 'call-sound-volume';
  const title = document.createElement('span'); title.textContent = copy.volume;
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
  slider.value = String(Math.round(volume() * 100)); slider.dataset.callSoundVolume = 'true';
  const output = document.createElement('output'); output.textContent = `${slider.value}%`;
  slider.setAttribute('aria-label', copy.volume);
  slider.addEventListener('input', () => { output.textContent = `${slider.value}%`; save(KEYS.volume, String(Number(slider.value) / 100)); });
  sliderLabel.append(title, slider, output); section.append(sliderLabel);
  const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'ghost';
  stop.dataset.callSoundStop = 'true'; stop.textContent = copy.stop;
  stop.addEventListener('click', () => { player.stopPreview(); status(''); });
  const note = document.createElement('small'); note.dataset.callSoundStatus = 'true';
  note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  section.append(stop, note); parent.append(section);
  if (lastStatus === 'blocked') status(copy.blocked);
  if (lastStatus === 'unavailable') status(copy.unavailable);
}

// Priming is output-only and silent. Remote signals never request a microphone
// merely to get around autoplay. A suspended context is retried on user gestures.
function unlock(event: Event): void {
  if (!event.isTrusted) return;
  preferences();
  player.unlock();
}
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);
window.addEventListener('konofix-voice-preferences-changed', preferences);
window.addEventListener('storage', () => { memory.clear(); preferences(); });
window.addEventListener('pagehide', () => player.dispose(), { once: true });
preferences();
