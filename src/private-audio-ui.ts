import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentLocale } from './i18n';
import {
  PrivateAudioCallController,
  type DirectVoiceSignal,
} from './private-audio-call';
import {
  AudioMediaError,
  normalizeAudioMediaError,
  type AudioInputDevice,
} from './audio-media-engine';
import type { VoiceSession } from './audio-call-state';
import './private-audio-ui.css';

const PRIVATE_CALLS_ENABLED_KEY = 'konofix.privateCallsEnabled';
const ROOM_VOICE_ENABLED_KEY = 'konofix.roomVoiceEnabled';
const DEFAULT_DEAFENED_KEY = 'konofix.voiceDefaultDeafened';

type ActivePeer = {
  peerId: string;
  nick: string;
  color: string;
};

const copy = currentLocale === 'pl'
  ? {
      call: 'Rozmowa audio',
      callWith: 'Zadzwoń do {nick}',
      incoming: '{nick} dzwoni',
      incomingHint: 'Mikrofon nie zostanie włączony, dopóki nie zaakceptujesz rozmowy.',
      accept: 'Odbierz',
      reject: 'Odrzuć',
      calling: 'Dzwonienie…',
      ringing: 'Połączenie przychodzące',
      joining: 'Łączenie audio…',
      connected: 'Połączono',
      reconnecting: 'Ponowne łączenie…',
      ended: 'Rozmowa zakończona',
      error: 'Błąd rozmowy',
      mute: 'Wycisz mikrofon',
      unmute: 'Włącz mikrofon',
      deafen: 'Wycisz odsłuch',
      undeafen: 'Włącz odsłuch',
      end: 'Zakończ',
      close: 'Zamknij',
      microphone: 'Mikrofon',
      defaultMic: 'Domyślny mikrofon',
      remoteMuted: 'Rozmówca ma wyciszony mikrofon',
      remoteActive: 'Rozmówca jest połączony',
      allowCalls: 'Zezwalaj na prywatne rozmowy audio',
      allowCallsHelp: 'Po wyłączeniu nowe połączenia audio są odrzucane na uwierzytelnionym kanale P2P.',
      defaultDeafened: 'Nowe rozmowy zaczynaj z wyciszonym odsłuchem',
      settingsTitle: 'Rozmowy audio',
      disabled: 'Prywatne rozmowy audio są wyłączone w ustawieniach.',
      busy: 'Inna prywatna rozmowa audio jest już aktywna.',
      policyError: 'Nie udało się zsynchronizować ustawień audio z siecią P2P.',
      permissionDenied: 'Brak dostępu do mikrofonu. Zezwól aplikacji Konofix na użycie mikrofonu.',
      deviceMissing: 'Nie znaleziono działającego mikrofonu.',
      deviceBusy: 'Mikrofon jest zajęty lub niedostępny.',
      constraintFailed: 'Wybrany mikrofon nie obsługuje wymaganych ustawień audio.',
      unsupported: 'Ten system/WebView nie obsługuje wymaganej obsługi audio WebRTC.',
      captureFailed: 'Nie udało się uruchomić lub zmienić mikrofonu.',
      invalidSignal: 'Odrzucono nieprawidłowy sygnał audio.',
      playbackBlocked: 'Odsłuch został zablokowany przez system. Kliknij przycisk odsłuchu ponownie.',
      peerOffline: 'Rozmówca jest offline.',
    }
  : {
      call: 'Audio call',
      callWith: 'Call {nick}',
      incoming: '{nick} is calling',
      incomingHint: 'Your microphone will not turn on until you accept the call.',
      accept: 'Accept',
      reject: 'Reject',
      calling: 'Calling…',
      ringing: 'Incoming call',
      joining: 'Joining audio…',
      connected: 'Connected',
      reconnecting: 'Reconnecting…',
      ended: 'Call ended',
      error: 'Call error',
      mute: 'Mute microphone',
      unmute: 'Unmute microphone',
      deafen: 'Mute incoming audio',
      undeafen: 'Enable incoming audio',
      end: 'End call',
      close: 'Close',
      microphone: 'Microphone',
      defaultMic: 'Default microphone',
      remoteMuted: 'The other participant muted their microphone',
      remoteActive: 'The other participant is connected',
      allowCalls: 'Allow private audio calls',
      allowCallsHelp: 'When disabled, new audio calls are rejected on the authenticated P2P channel.',
      defaultDeafened: 'Start new calls with incoming audio muted',
      settingsTitle: 'Audio calls',
      disabled: 'Private audio calls are disabled in settings.',
      busy: 'Another private audio call is already active.',
      policyError: 'Could not synchronize audio preferences with the P2P network.',
      permissionDenied: 'Microphone access was denied. Allow Konofix to use the microphone.',
      deviceMissing: 'No usable microphone was found.',
      deviceBusy: 'The microphone is busy or unavailable.',
      constraintFailed: 'The selected microphone cannot satisfy the requested audio settings.',
      unsupported: 'This system/WebView does not support the required WebRTC audio features.',
      captureFailed: 'Unable to start or switch the microphone.',
      invalidSignal: 'An invalid audio signal was rejected.',
      playbackBlocked: 'Incoming audio playback was blocked. Toggle incoming audio again.',
      peerOffline: 'The other participant is offline.',
    };

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match);
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value !== '0';
}

function setStoredBoolean(key: string, value: boolean): void {
  localStorage.setItem(key, value ? '1' : '0');
}

function privateCallsEnabled(): boolean {
  return storedBoolean(PRIVATE_CALLS_ENABLED_KEY, true);
}

function roomVoiceEnabled(): boolean {
  return storedBoolean(ROOM_VOICE_ENABLED_KEY, true);
}

function defaultDeafened(): boolean {
  return storedBoolean(DEFAULT_DEAFENED_KEY, false);
}

function safeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#62E5FF';
}

function phaseLabel(session: VoiceSession): string {
  switch (session.phase) {
    case 'calling': return copy.calling;
    case 'ringing': return copy.ringing;
    case 'joining': return copy.joining;
    case 'connected': return copy.connected;
    case 'reconnecting': return copy.reconnecting;
    case 'ended': return copy.ended;
    case 'error': return copy.error;
    default: return copy.call;
  }
}

function mediaErrorText(error: unknown): string {
  const normalized = error instanceof AudioMediaError ? error : normalizeAudioMediaError(error);
  switch (normalized.code) {
    case 'permission_denied': return copy.permissionDenied;
    case 'device_missing': return copy.deviceMissing;
    case 'device_busy': return copy.deviceBusy;
    case 'constraint_failed': return copy.constraintFailed;
    case 'unsupported': return copy.unsupported;
    case 'invalid_signal': return copy.invalidSignal;
    default: return copy.captureFailed;
  }
}

let activePeer: ActivePeer | null = null;
let lastPrivatePeer: ActivePeer | null = null;
let latestSession: VoiceSession | null = null;
let remoteStream: MediaStream | null = null;
let currentError = '';
let devices: AudioInputDevice[] = [];
let selectedDeviceId = '';
let loadedDevicesForSession = '';
let policySynced = false;

const signaler = {
  async send(signal: {
    peerId: string;
    sessionId: string;
    scope: { kind: 'private' } | { kind: 'room'; room_id: string };
    action: string;
    sdp?: string | null;
    candidate?: string | null;
    roomIntent?: 'listen' | 'speak' | null;
    muted?: boolean | null;
  }): Promise<unknown> {
    return invoke('send_voice_signal', {
      peerId: signal.peerId,
      sessionId: signal.sessionId,
      scope: signal.scope,
      action: signal.action,
      sdp: signal.sdp ?? null,
      candidate: signal.candidate ?? null,
      roomIntent: signal.roomIntent ?? null,
      muted: signal.muted ?? null,
    });
  },
};

const controller = new PrivateAudioCallController(signaler, {
  events: {
    onSession(session) {
      latestSession = session;
      if (session.scope.kind === 'private' && (!activePeer || activePeer.peerId !== session.scope.peerId)) {
        activePeer = resolvePeer(session.scope.peerId) ?? {
          peerId: session.scope.peerId,
          nick: session.scope.peerId,
          color: '#62E5FF',
        };
      }
      if (session.phase !== 'ringing') removeIncomingDialog();
      if (session.phase === 'connected' && loadedDevicesForSession !== session.id) {
        loadedDevicesForSession = session.id;
        void refreshDevices();
      }
      renderCallPanel();
    },
    onIncomingCall(signal) {
      activePeer = {
        peerId: signal.peer_id,
        nick: signal.nick || signal.peer_id,
        color: safeColor(signal.nick_color ?? ''),
      };
      showIncomingDialog(signal);
    },
    onRemoteStream(stream) {
      remoteStream = stream;
      renderCallPanel();
    },
    onMediaError(error) {
      currentError = mediaErrorText(error);
      renderCallPanel();
    },
  },
});

function applyLocalPreferences(): void {
  controller.sessions.setPreferences({
    allowPrivateCalls: privateCallsEnabled(),
    allowRoomVoice: roomVoiceEnabled(),
    defaultDeafened: defaultDeafened(),
  });
}

async function syncVoicePolicy(showError = false): Promise<void> {
  applyLocalPreferences();
  try {
    await invoke('set_voice_policy', {
      privateCallsEnabled: privateCallsEnabled(),
      roomVoiceEnabled: roomVoiceEnabled(),
    });
    policySynced = true;
    updateSettingsStatus('');
  } catch {
    policySynced = false;
    if (showError) updateSettingsStatus(copy.policyError);
  }
}

function updateSettingsStatus(message: string): void {
  const node = document.querySelector<HTMLElement>('[data-voice-settings-status]');
  if (node) node.textContent = message;
}

function resolvePeer(peerId: string): ActivePeer | null {
  const button = document.querySelector<HTMLButtonElement>(`[data-send-peer="${CSS.escape(peerId)}"]`);
  const row = button?.closest<HTMLElement>('.user');
  if (!row) return null;
  return {
    peerId,
    nick: row.querySelector('strong')?.textContent?.trim() || peerId,
    color: safeColor(row.querySelector<HTMLElement>('strong')?.style.color || ''),
  };
}

function resolvePrivateModalPeer(): ActivePeer | null {
  if (lastPrivatePeer && document.querySelector('#privateChatModal')) return lastPrivatePeer;
  const nick = document.querySelector<HTMLElement>('#privateChatTitle')?.textContent?.trim();
  if (!nick) return null;
  const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-private-peer]'))
    .filter(button => (button.dataset.privateNick || '').trim() === nick);
  if (candidates.length !== 1) return null;
  const button = candidates[0];
  return {
    peerId: button.dataset.privatePeer || '',
    nick: button.dataset.privateNick || nick,
    color: safeColor(button.dataset.privateColor || ''),
  };
}

async function startPrivateCall(peer: ActivePeer): Promise<void> {
  if (!privateCallsEnabled()) {
    alert(copy.disabled);
    return;
  }
  currentError = '';
  remoteStream = null;
  devices = [];
  selectedDeviceId = '';
  loadedDevicesForSession = '';
  activePeer = peer;
  try {
    latestSession = await controller.startPrivateCall(peer.peerId, peer.nick);
    renderCallPanel();
  } catch (error) {
    currentError = error instanceof Error && /already active/i.test(error.message)
      ? copy.busy
      : mediaErrorText(error);
    renderCallPanel();
  }
}

async function acceptIncomingCall(): Promise<void> {
  currentError = '';
  removeIncomingDialog();
  try {
    latestSession = await controller.acceptPrivateCall();
    renderCallPanel();
  } catch (error) {
    currentError = mediaErrorText(error);
    renderCallPanel();
  }
}

async function rejectIncomingCall(): Promise<void> {
  removeIncomingDialog();
  try {
    await controller.rejectPrivateCall();
  } finally {
    latestSession = controller.activeSession() ?? latestSession;
    renderCallPanel();
  }
}

async function endCurrentCall(): Promise<void> {
  await controller.endPrivateCall();
  latestSession = latestSession && latestSession.phase === 'ended'
    ? latestSession
    : controller.activeSession() ?? latestSession;
  renderCallPanel();
}

async function toggleMute(): Promise<void> {
  const session = controller.activeSession();
  if (!session) return;
  try {
    latestSession = await controller.setMuted(!session.localMuted);
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderCallPanel();
}

async function toggleDeafen(): Promise<void> {
  const session = controller.activeSession();
  if (!session) return;
  try {
    latestSession = await controller.setDeafened(!session.deafened);
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderCallPanel();
}

async function refreshDevices(): Promise<void> {
  const session = controller.activeSession();
  if (!session || !['joining', 'connected', 'reconnecting'].includes(session.phase)) return;
  try {
    devices = await controller.listInputDevices(false);
    if (!selectedDeviceId) {
      selectedDeviceId = devices.find(device => device.isDefault)?.deviceId ?? devices[0]?.deviceId ?? '';
    }
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderCallPanel();
}

async function switchDevice(deviceId: string): Promise<void> {
  if (!deviceId) return;
  try {
    await controller.switchInput(deviceId);
    selectedDeviceId = deviceId;
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderCallPanel();
}

function removeIncomingDialog(): void {
  document.querySelector('#privateAudioIncoming')?.remove();
}

function showIncomingDialog(signal: DirectVoiceSignal): void {
  if (!privateCallsEnabled()) return;
  removeIncomingDialog();
  const wrap = document.createElement('div');
  wrap.id = 'privateAudioIncoming';
  wrap.className = 'private-audio-incoming-wrap';
  wrap.innerHTML = `
    <section class="private-audio-incoming glass" role="dialog" aria-modal="true" aria-labelledby="privateAudioIncomingTitle">
      <div class="private-audio-pulse" aria-hidden="true">📞</div>
      <span class="eyebrow">PRIVATE AUDIO P2P</span>
      <h3 id="privateAudioIncomingTitle" style="color:${safeColor(signal.nick_color ?? '')}">${escapeHtml(format(copy.incoming, { nick: signal.nick || signal.peer_id }))}</h3>
      <p>${escapeHtml(copy.incomingHint)}</p>
      <div class="private-audio-incoming-actions">
        <button type="button" class="ghost" data-private-audio-reject>${escapeHtml(copy.reject)}</button>
        <button type="button" class="primary compact" data-private-audio-accept>${escapeHtml(copy.accept)}</button>
      </div>
    </section>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-private-audio-reject]')?.addEventListener('click', () => { void rejectIncomingCall(); });
  wrap.querySelector('[data-private-audio-accept]')?.addEventListener('click', () => { void acceptIncomingCall(); });
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

function closeEndedPanel(): void {
  document.querySelector('#privateAudioPanel')?.remove();
  latestSession = null;
  remoteStream = null;
  currentError = '';
  activePeer = null;
  devices = [];
  selectedDeviceId = '';
  loadedDevicesForSession = '';
  controller.reset();
}

function renderCallPanel(): void {
  const session = controller.activeSession() ?? latestSession;
  if (!session || !activePeer) {
    document.querySelector('#privateAudioPanel')?.remove();
    return;
  }

  let wrap = document.querySelector<HTMLDivElement>('#privateAudioPanel');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'privateAudioPanel';
    document.body.appendChild(wrap);
  }

  const active = ['joining', 'connected', 'reconnecting'].includes(session.phase);
  const terminal = ['ended', 'error'].includes(session.phase);
  const remote = Array.from(session.participants.values())[0];
  const remoteStatus = remote?.muted ? copy.remoteMuted : copy.remoteActive;
  const options = devices.length
    ? devices.map(device => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === selectedDeviceId ? 'selected' : ''}>${escapeHtml(device.label || copy.microphone)}</option>`).join('')
    : `<option value="">${escapeHtml(copy.defaultMic)}</option>`;

  wrap.innerHTML = `
    <section class="private-audio-panel glass" role="region" aria-label="${escapeHtml(copy.call)}">
      <header>
        <div class="private-audio-avatar" style="--voice-color:${safeColor(activePeer.color)}">${escapeHtml(activePeer.nick.slice(0, 1).toUpperCase())}</div>
        <div class="private-audio-heading">
          <strong style="color:${safeColor(activePeer.color)}">${escapeHtml(activePeer.nick)}</strong>
          <span class="private-audio-phase phase-${escapeHtml(session.phase)}"><i></i>${escapeHtml(phaseLabel(session))}</span>
        </div>
      </header>
      <div class="private-audio-participant">${escapeHtml(remoteStatus)}</div>
      <label class="private-audio-device">
        <span>${escapeHtml(copy.microphone)}</span>
        <select data-private-audio-device ${active && devices.length ? '' : 'disabled'}>${options}</select>
      </label>
      <div class="private-audio-controls">
        <button type="button" data-private-audio-mute class="${session.localMuted ? 'is-active' : ''}" ${active ? '' : 'disabled'} title="${escapeHtml(session.localMuted ? copy.unmute : copy.mute)}" aria-label="${escapeHtml(session.localMuted ? copy.unmute : copy.mute)}">${session.localMuted ? '🔇' : '🎙️'}</button>
        <button type="button" data-private-audio-deafen class="${session.deafened ? 'is-active' : ''}" ${active ? '' : 'disabled'} title="${escapeHtml(session.deafened ? copy.undeafen : copy.deafen)}" aria-label="${escapeHtml(session.deafened ? copy.undeafen : copy.deafen)}">${session.deafened ? '🔕' : '🔊'}</button>
        ${terminal
          ? `<button type="button" class="private-audio-close" data-private-audio-close>${escapeHtml(copy.close)}</button>`
          : `<button type="button" class="private-audio-end" data-private-audio-end title="${escapeHtml(copy.end)}" aria-label="${escapeHtml(copy.end)}">✕</button>`}
      </div>
      <div class="private-audio-error" data-private-audio-error role="status" aria-live="polite">${escapeHtml(currentError || session.error || '')}</div>
      <audio data-private-audio-remote autoplay></audio>
    </section>`;

  wrap.querySelector('[data-private-audio-mute]')?.addEventListener('click', () => { void toggleMute(); });
  wrap.querySelector('[data-private-audio-deafen]')?.addEventListener('click', () => { void toggleDeafen(); });
  wrap.querySelector('[data-private-audio-end]')?.addEventListener('click', () => { void endCurrentCall(); });
  wrap.querySelector('[data-private-audio-close]')?.addEventListener('click', closeEndedPanel);
  wrap.querySelector<HTMLSelectElement>('[data-private-audio-device]')?.addEventListener('change', event => {
    void switchDevice((event.currentTarget as HTMLSelectElement).value);
  });

  const audio = wrap.querySelector<HTMLAudioElement>('[data-private-audio-remote]');
  if (audio && remoteStream) {
    audio.srcObject = remoteStream;
    audio.muted = session.deafened;
    void audio.play().catch(() => {
      const errorNode = wrap?.querySelector<HTMLElement>('[data-private-audio-error]');
      if (errorNode && !errorNode.textContent) errorNode.textContent = copy.playbackBlocked;
    });
  }
}

function augmentPeerButtons(): void {
  document.querySelectorAll<HTMLElement>('#peerList .user').forEach(row => {
    const sendButton = row.querySelector<HTMLButtonElement>('[data-send-peer]');
    const peerId = sendButton?.dataset.sendPeer ?? '';
    if (!sendButton || !peerId || row.querySelector(`[data-private-audio-peer="${CSS.escape(peerId)}"]`)) return;
    const nick = row.querySelector('strong')?.textContent?.trim() || peerId;
    const color = safeColor(row.querySelector<HTMLElement>('strong')?.style.color || '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini-private-audio';
    button.dataset.privateAudioPeer = peerId;
    button.dataset.privateAudioNick = nick;
    button.dataset.privateAudioColor = color;
    button.textContent = '📞';
    button.title = format(copy.callWith, { nick });
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void startPrivateCall({ peerId, nick, color });
    });
    const privateButton = row.querySelector('[data-private-peer]');
    if (privateButton) privateButton.insertAdjacentElement('beforebegin', button);
    else sendButton.insertAdjacentElement('beforebegin', button);
  });
}

function augmentPrivateChat(): void {
  const modal = document.querySelector<HTMLElement>('#privateChatModal .private-chat-modal');
  const header = modal?.querySelector<HTMLElement>('.private-chat-head');
  if (!modal || !header || header.querySelector('[data-private-audio-chat-call]')) return;
  const peer = resolvePrivateModalPeer();
  if (!peer?.peerId) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'private-audio-chat-call';
  button.dataset.privateAudioChatCall = peer.peerId;
  button.textContent = '📞';
  button.title = format(copy.callWith, { nick: peer.nick });
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void startPrivateCall(peer);
  });
  header.querySelector('[data-private-close]')?.insertAdjacentElement('beforebegin', button);
}

function augmentVoiceSettings(): void {
  const modal = document.querySelector<HTMLDivElement>('#networkModal .modal');
  if (!modal || modal.querySelector('[data-voice-settings]')) return;
  const section = document.createElement('section');
  section.className = 'private-settings-card private-audio-settings-card';
  section.dataset.voiceSettings = 'true';
  section.innerHTML = `
    <div>
      <strong>${escapeHtml(copy.settingsTitle)}</strong>
      <small>${escapeHtml(copy.allowCallsHelp)}</small>
    </div>
    <label class="private-setting-toggle">
      <input type="checkbox" data-private-audio-enabled ${privateCallsEnabled() ? 'checked' : ''} />
      <span>${escapeHtml(copy.allowCalls)}</span>
    </label>
    <label class="private-setting-toggle">
      <input type="checkbox" data-private-audio-default-deafened ${defaultDeafened() ? 'checked' : ''} />
      <span>${escapeHtml(copy.defaultDeafened)}</span>
    </label>
    <small class="private-audio-settings-status" data-voice-settings-status>${policySynced ? '' : ''}</small>`;
  modal.appendChild(section);

  section.querySelector<HTMLInputElement>('[data-private-audio-enabled]')?.addEventListener('change', event => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    setStoredBoolean(PRIVATE_CALLS_ENABLED_KEY, enabled);
    applyLocalPreferences();
    if (!enabled) {
      removeIncomingDialog();
      void controller.endPrivateCall().finally(() => renderCallPanel());
    }
    void syncVoicePolicy(true);
  });

  section.querySelector<HTMLInputElement>('[data-private-audio-default-deafened]')?.addEventListener('change', event => {
    setStoredBoolean(DEFAULT_DEAFENED_KEY, (event.currentTarget as HTMLInputElement).checked);
    applyLocalPreferences();
  });
}

function augmentUi(): void {
  augmentPeerButtons();
  augmentPrivateChat();
  augmentVoiceSettings();
}

window.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('[data-private-peer]');
  if (!button) return;
  const peerId = button.dataset.privatePeer ?? '';
  if (!peerId) return;
  lastPrivatePeer = {
    peerId,
    nick: button.dataset.privateNick || peerId,
    color: safeColor(button.dataset.privateColor || ''),
  };
}, true);

applyLocalPreferences();

void listen<DirectVoiceSignal>('voice-signal', event => {
  void controller.handleSignal(event.payload).catch(error => {
    currentError = mediaErrorText(error);
    renderCallPanel();
  });
});

void listen<{ phase?: string }>('network-status', event => {
  if (event.payload?.phase === 'offline') {
    policySynced = false;
    return;
  }
  void syncVoicePolicy();
});

void listen<{ peer_id: string }>('peer-offline', event => {
  if (activePeer?.peerId !== event.payload.peer_id) return;
  currentError = copy.peerOffline;
  void controller.endPrivateCall().finally(() => renderCallPanel());
});

void listen('network-error', () => {
  controller.reset();
  removeIncomingDialog();
  document.querySelector('#privateAudioPanel')?.remove();
  activePeer = null;
  latestSession = null;
  remoteStream = null;
  currentError = '';
  devices = [];
  selectedDeviceId = '';
  loadedDevicesForSession = '';
  policySynced = false;
});

new MutationObserver(augmentUi).observe(document.body, { childList: true, subtree: true });
augmentUi();
