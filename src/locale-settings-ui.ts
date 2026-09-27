import { currentLocale, type Locale } from './i18n';

// The existing i18n startup resolver already consumes this key. Never reload a
// connected WebView: that would discard chat state while leaving P2P running.
const STORAGE_KEY = 'konofix.locale';
const names: Record<Locale, string> = {
  en: 'English', pl: 'Polski', no: 'Norsk', de: 'Deutsch',
  fr: 'Français', es: 'Español', uk: 'Українська',
};
type Preference = Locale | 'auto';
const copy = currentLocale === 'pl'
  ? { language: 'Język aplikacji', auto: 'Automatycznie — język systemu', save: 'Zapisz język',
      help: 'Zmiana obowiązuje od następnego uruchomienia. Brakujące tłumaczenia są wyświetlane po angielsku.',
      saved: 'Zapisano. Uruchom ponownie Konofix po zakończeniu rozmów i transferów, aby zmienić język.',
      failed: 'Nie udało się zapisać języka. Poprzednie ustawienie pozostaje bez zmian.' }
  : { language: 'App language', auto: 'Automatic — system language', save: 'Save language',
      help: 'Applies on the next start. Missing translations are displayed in English.',
      saved: 'Saved. Restart Konofix after finishing calls and transfers to apply the language.',
      failed: 'Could not save the language. The previous preference is unchanged.' };

function known(value: string): value is Locale {
  return Object.prototype.hasOwnProperty.call(names, value);
}

export function readLocalePreference(): Preference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.toLowerCase().split('-')[0] ?? '';
    return known(saved) ? saved : 'auto';
  } catch { return 'auto'; }
}

export function saveLocalePreference(value: string): void {
  if (value === 'auto') localStorage.removeItem(STORAGE_KEY);
  else if (known(value)) localStorage.setItem(STORAGE_KEY, value);
  else throw new RangeError('Unsupported locale preference.');
}

export function mountLocaleSettings(modal: HTMLElement): void {
  if (!modal.isConnected || !modal.matches('#networkModal .modal')) return;
  if (modal.querySelector('[data-locale-settings]')) return;
  const head = modal.querySelector<HTMLElement>(':scope > .modal-head');
  if (!head) return;
  const card = document.createElement('section'); card.dataset.localeSettings = 'true';
  const row = document.createElement('div'); row.className = 'locale-settings-controls';
  const label = document.createElement('label'); label.htmlFor = 'konofix-locale'; label.textContent = copy.language;
  const select = document.createElement('select'); select.id = 'konofix-locale'; select.dataset.localeSelect = 'true';
  select.setAttribute('aria-describedby', 'konofix-locale-status');
  for (const [value, name] of [['auto', copy.auto], ...Object.entries(names)]) {
    const option = document.createElement('option'); option.value = value; option.textContent = name;
    select.append(option);
  }
  select.value = readLocalePreference();
  const save = document.createElement('button'); save.type = 'button'; save.className = 'ghost';
  save.dataset.localeSave = 'true'; save.textContent = copy.save; save.disabled = true;
  const note = document.createElement('p'); note.id = 'konofix-locale-status'; note.dataset.localeStatus = 'true';
  note.textContent = copy.help; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  select.addEventListener('change', () => { save.disabled = select.value === readLocalePreference(); note.textContent = copy.help; });
  save.addEventListener('click', () => {
    try {
      saveLocalePreference(select.value);
      note.textContent = copy.saved;
      save.disabled = true;
    } catch { note.textContent = copy.failed; save.disabled = false; }
  });
  row.append(label, select, save); card.append(row, note); head.append(card);
}

// Same lifecycle as the settings organizer, no additional observer or polling.
window.addEventListener('konofix-settings-present', event => {
  const modal = (event as CustomEvent<unknown>).detail;
  if (modal instanceof HTMLElement) mountLocaleSettings(modal);
});
const existing = document.querySelector<HTMLElement>('#networkModal .modal');
if (existing) mountLocaleSettings(existing);
