import { currentLocale } from './i18n';

const CHAT_MUTED_KEY = 'konofix.voiceChatMuted';
const NOTIFICATIONS_MUTED_KEY = 'konofix.voiceNotificationsMuted';
const PREFERENCES_EVENT = 'konofix-voice-preferences-changed';

const copy = currentLocale === 'pl'
  ? {
      title: 'Wyciszenie i spokój',
      help: 'Te ustawienia są lokalne i odwracalne. Nie przerywają połączenia P2P ani nie usuwają wiadomości.',
      chat: 'Wycisz czat',
      chatHelp: 'Ukrywa wiadomości i pola pisania. Wiadomości nadal są odbierane i pojawią się po ponownym włączeniu czatu.',
      notifications: 'Wycisz powiadomienia',
      notificationsHelp: 'Ukrywa wyskakujące powiadomienia prywatnych wiadomości i rozmów audio. Nie odrzuca samych wiadomości ani połączeń.',
      chatMuted: 'Czat jest wyciszony. Wiadomości są zachowywane lokalnie i wrócą po wyłączeniu wyciszenia.',
    }
  : {
      title: 'Quiet mode',
      help: 'These controls are local and reversible. They do not disconnect P2P or delete messages.',
      chat: 'Mute chat',
      chatHelp: 'Hides messages and message composers. Messages are still received and reappear when chat is unmuted.',
      notifications: 'Mute notifications',
      notificationsHelp: 'Hides private-message and incoming-audio popups. It does not reject the underlying message or call.',
      chatMuted: 'Chat is muted. Messages are preserved locally and will reappear when chat is unmuted.',
    };

function storedBoolean(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

function setStoredBoolean(key: string, value: boolean): void {
  localStorage.setItem(key, value ? '1' : '0');
}

function chatMuted(): boolean {
  return storedBoolean(CHAT_MUTED_KEY);
}

function notificationsMuted(): boolean {
  return storedBoolean(NOTIFICATIONS_MUTED_KEY);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;',
  }[character]!));
}

function ensureStyles(): void {
  if (document.querySelector('[data-voice-mute-styles]')) return;
  const style = document.createElement('style');
  style.dataset.voiceMuteStyles = 'true';
  style.textContent = `
    body.konofix-chat-muted #messages,
    body.konofix-chat-muted .composer,
    body.konofix-chat-muted .private-messages,
    body.konofix-chat-muted .private-compose { display: none !important; }
    body.konofix-notifications-muted .private-notice-wrap,
    body.konofix-notifications-muted #privateAudioIncoming { display: none !important; }
    .voice-mute-banner {
      margin: 12px 18px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(98, 229, 255, 0.28);
      background: rgba(0, 136, 255, 0.1);
      color: #ccecf5;
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .voice-mute-settings-card { gap: 10px; }
    .voice-mute-settings-card > div:first-child { display: grid; gap: 4px; }
    .voice-mute-setting-copy { display: grid; gap: 2px; min-width: 0; }
    .voice-mute-setting-copy small { color: #8da8b8; line-height: 1.35; }
  `;
  document.head.appendChild(style);
}

function renderMutedBanners(): void {
  if (!chatMuted()) {
    document.querySelectorAll('[data-voice-chat-muted-banner]').forEach(node => node.remove());
    return;
  }

  const ensureBanner = (kind: 'main' | 'private', header: HTMLElement | null): void => {
    if (!header || document.querySelector(`[data-voice-chat-muted-banner="${kind}"]`)) return;
    const banner = document.createElement('div');
    banner.className = 'voice-mute-banner';
    banner.dataset.voiceChatMutedBanner = kind;
    banner.textContent = copy.chatMuted;
    header.insertAdjacentElement('afterend', banner);
  };

  ensureBanner('main', document.querySelector<HTMLElement>('.chat-main .chat-header'));
  ensureBanner('private', document.querySelector<HTMLElement>('#privateChatModal .private-chat-head'));
}

function applyState(): void {
  ensureStyles();
  document.body.classList.toggle('konofix-chat-muted', chatMuted());
  document.body.classList.toggle('konofix-notifications-muted', notificationsMuted());

  if (notificationsMuted()) {
    document.querySelectorAll('.private-notice-wrap').forEach(node => node.remove());
    document.querySelector('#privateAudioIncoming')?.remove();
  }

  document.querySelectorAll<HTMLInputElement>('[data-voice-chat-muted]').forEach(input => {
    input.checked = chatMuted();
  });
  document.querySelectorAll<HTMLInputElement>('[data-voice-notifications-muted]').forEach(input => {
    input.checked = notificationsMuted();
  });
  renderMutedBanners();
}

function setPreference(key: string, value: boolean): void {
  setStoredBoolean(key, value);
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

function augmentSettings(): void {
  const modal = document.querySelector<HTMLDivElement>('#networkModal .modal');
  if (!modal || modal.querySelector('[data-voice-mute-settings]')) return;

  const section = document.createElement('section');
  section.className = 'private-settings-card voice-mute-settings-card';
  section.dataset.voiceMuteSettings = 'true';
  section.innerHTML = `
    <div>
      <strong>${escapeHtml(copy.title)}</strong>
      <small>${escapeHtml(copy.help)}</small>
    </div>
    <label class="private-setting-toggle">
      <input type="checkbox" data-voice-chat-muted ${chatMuted() ? 'checked' : ''} />
      <span class="voice-mute-setting-copy">
        <strong>${escapeHtml(copy.chat)}</strong>
        <small>${escapeHtml(copy.chatHelp)}</small>
      </span>
    </label>
    <label class="private-setting-toggle">
      <input type="checkbox" data-voice-notifications-muted ${notificationsMuted() ? 'checked' : ''} />
      <span class="voice-mute-setting-copy">
        <strong>${escapeHtml(copy.notifications)}</strong>
        <small>${escapeHtml(copy.notificationsHelp)}</small>
      </span>
    </label>`;
  modal.appendChild(section);

  section.querySelector<HTMLInputElement>('[data-voice-chat-muted]')?.addEventListener('change', event => {
    setPreference(CHAT_MUTED_KEY, (event.currentTarget as HTMLInputElement).checked);
  });
  section.querySelector<HTMLInputElement>('[data-voice-notifications-muted]')?.addEventListener('change', event => {
    setPreference(NOTIFICATIONS_MUTED_KEY, (event.currentTarget as HTMLInputElement).checked);
  });
}

let augmentQueued = false;
function augmentUi(): void {
  if (augmentQueued) return;
  augmentQueued = true;
  queueMicrotask(() => {
    augmentQueued = false;
    augmentSettings();
    applyState();
  });
}

window.addEventListener(PREFERENCES_EVENT, applyState);
new MutationObserver(augmentUi).observe(document.body, { childList: true, subtree: true });
applyState();
augmentUi();
