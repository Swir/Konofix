import { currentLocale } from './i18n';
import './professional-ui.css';

// Reuse the updater's existing, coalesced DOM lifecycle. No polling or observer.
type Group = 'audio' | 'privacy' | 'updates' | 'network';
const groups: Group[] = ['audio', 'privacy', 'updates', 'network'];
const labels = currentLocale === 'pl'
  ? { title: 'Ustawienia', audio: 'Audio', privacy: 'Prywatność', updates: 'Aktualizacje', network: 'Sieć', empty: 'Ten moduł ustawień jest niedostępny.' }
  : { title: 'Settings', audio: 'Audio', privacy: 'Privacy', updates: 'Updates', network: 'Network', empty: 'This settings module is unavailable.' };
type View = { shell: HTMLElement; nav: HTMLElement; panels: Map<Group, HTMLElement>; buttons: Map<Group, HTMLButtonElement>; active: Group };
const views = new WeakMap<HTMLElement, View>();

function category(node: HTMLElement): Group {
  if (node.matches('[data-voice-settings], [data-room-voice-settings], [data-call-sound-settings]')) return 'audio';
  if (node.matches('[data-test-updater]')) return 'updates';
  if (node.matches('.private-settings-card')) return 'privacy';
  return 'network';
}

function select(view: View, group: Group, focus = false): void {
  view.active = group;
  for (const name of groups) {
    const button = view.buttons.get(name)!;
    const selected = name === group;
    const value = String(selected);
    if (button.getAttribute('aria-selected') !== value) button.setAttribute('aria-selected', value);
    if (button.tabIndex !== (selected ? 0 : -1)) button.tabIndex = selected ? 0 : -1;
    if (view.panels.get(name)!.hidden === selected) view.panels.get(name)!.hidden = !selected;
  }
  if (focus) view.buttons.get(group)!.focus();
}

export function organizeSettingsModal(modal: HTMLElement): void {
  if (!modal.isConnected || !modal.matches('#networkModal .modal')) return;
  let view = views.get(modal);
  const created = !view;
  if (!view) {
    const head = modal.querySelector<HTMLElement>(':scope > .modal-head');
    if (!head) return; // Do not rearrange an incomplete/unknown dialog.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.createElement('div'); shell.className = 'settings-shell';
    const nav = document.createElement('div'); nav.className = 'settings-tabs';
    nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', labels.title);
    const body = document.createElement('div'); body.className = 'settings-body';
    view = { shell, nav, panels: new Map(), buttons: new Map(), active: 'audio' };
    const local = view;
    for (const group of groups) {
      const button = document.createElement('button'); button.type = 'button';
      button.id = `konofix-settings-tab-${group}`; button.dataset.settingsTab = group;
      button.textContent = labels[group]; button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `konofix-settings-${group}`);
      const panel = document.createElement('section'); panel.className = 'settings-panel';
      panel.id = `konofix-settings-${group}`; panel.dataset.settingsPanel = group;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      const empty = document.createElement('p'); empty.dataset.settingsEmpty = 'true';
      empty.className = 'settings-empty'; empty.textContent = labels.empty; panel.append(empty);
      button.addEventListener('click', () => select(local, group));
      button.addEventListener('keydown', event => {
        const index = groups.indexOf(group);
        const next = event.key === 'ArrowRight' ? (index + 1) % groups.length
          : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); select(local, groups[next], true);
      });
      local.buttons.set(group, button); local.panels.set(group, panel);
      nav.append(button); body.append(panel);
    }
    shell.append(nav, body); modal.append(shell);
    modal.classList.add('organized-settings');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', labels.title);
    const title = head.querySelector('h3'); if (title) title.textContent = labels.title;
    const eyebrow = head.querySelector('.eyebrow'); if (eyebrow) eyebrow.textContent = 'KONOFIX';
    const close = head.querySelector<HTMLButtonElement>('#closeModal');
    close?.setAttribute('aria-label', currentLocale === 'pl' ? 'Zamknij ustawienia' : 'Close settings');
    close?.addEventListener('click', () => {
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else document.querySelector<HTMLElement>('#networkSettings, #loginNetwork')?.focus();
      });
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close?.click(); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(modal.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden]') && node.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    views.set(modal, view);
  }
  // Move the actual controls, never clone innerHTML or discard their listeners.
  for (const node of Array.from(modal.children)) {
    if (!(node instanceof HTMLElement) || node === view.shell || node.matches('.modal-head')) continue;
    const group = category(node);
    const focused = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : null;
    view.panels.get(group)!.append(node);
    if (focused) { select(view, group); focused.focus({ preventScroll: true }); }
  }
  for (const panel of view.panels.values()) {
    const empty = panel.querySelector<HTMLElement>('[data-settings-empty]')!;
    const hide = panel.children.length > 1;
    if (empty.hidden !== hide) empty.hidden = hide;
  }
  select(view, view.active);
  if (created && !modal.contains(document.activeElement)) view.buttons.get(view.active)!.focus();
}

window.addEventListener('konofix-settings-present', event => {
  const modal = (event as CustomEvent<unknown>).detail;
  if (modal instanceof HTMLElement) organizeSettingsModal(modal);
});
const existing = document.querySelector<HTMLElement>('#networkModal .modal');
if (existing) organizeSettingsModal(existing);
