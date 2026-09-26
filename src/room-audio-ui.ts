import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentLocale } from './i18n';
import {
  RoomAudioCallController,
  type RoomVoicePeer,
} from './room-audio-call';
import {
  AudioMediaError,
  normalizeAudioMediaError,
  type AudioInputDevice,
} from './audio-media-engine';
import type { DirectVoiceSignal } from './private-audio-call';
import type { VoiceSession } from './audio-call-state';
import './room-audio-ui.css';

const ROOM_VOICE_ENABLED_KEY = 'konofix.roomVoiceEnabled';
const PRIVATE_CALLS_ENABLED_KEY = 'konofix.privateCallsEnabled';
const DEFAULT_DEAFENED_KEY = 'konofix.voiceDefaultDeafened';

const copy = currentLocale === 'pl'
  ? {
      join: 'Dołącz do głosu',
      change: 'Zmień kanał głosowy',
      voice: 'Głos',
      listen: 'Tylko słucham',
      wantToSpeak: 'Chcę mówić',
      stopSpeaking: 'Przestań mówić',
      mute: 'Wycisz mikrofon',
      unmute: 'Włącz mikrofon',
      deafen: 'Wycisz odsłuch',
      undeafen: 'Włącz odsłuch',
      leave: 'Opuść voice',
      close: 'Zamknij',
      microphone: 'Mikrofon',
      defaultMic: 'Domyślny mikrofon',
      joining: 'Dołączanie…',
      connected: 'Połączono',
      reconnecting: 'Ponowne łączenie…',
      ended: 'Voice zakończony',
      error: 'Błąd voice',
      participant: 'uczestnik',
      participants: 'uczestników',
      nobody: 'Na razie jesteś tu sam.',
      listening: 'słucha',
      micOn: 'mikrofon aktywny',
      micMuted: 'mikrofon wyciszony',
      allow: 'Zezwalaj na voice w WORLD i pokojach',
      allowHelp: 'Voice jest zawsze opt-in. Wyłączenie tej opcji opuszcza aktywny voice i odrzuca nowe zaproszenia pokojowe.',
      settingsTitle: 'Voice WORLD / pokoje',
      disabled: 'Voice WORLD/pokoje jest wyłączony w ustawieniach.',
      privateBusy: 'Najpierw zakończ prywatną rozmowę audio.',
      permissionDenied: 'Brak dostępu do mikrofonu. Zezwól Konofix na użycie mikrofonu.',
      deviceMissing: 'Nie znaleziono działającego mikrofonu.',
      deviceBusy: 'Mikrofon jest zajęty lub niedostępny.',
      constraintFailed: 'Wybrany mikrofon nie obsługuje wymaganych ustawień.',
      unsupported: 'Ten system/WebView nie obsługuje wymaganego audio WebRTC.',
      captureFailed: 'Nie udało się uruchomić lub zmienić mikrofonu.',
      invalidSignal: 'Odrzucono nieprawidłowy sygnał audio.',
      playbackBlocked: 'Odsłuch został zablokowany przez system. Użyj ponownie przycisku odsłuchu.',
      policyError: 'Nie udało się zsynchronizować ustawień voice z siecią P2P.',
      signalingError: 'Nie udało się połączyć z jednym z uczestników.',
    }
  : {
      join: 'Join voice',
      change: 'Change voice channel',
      voice: 'Voice',
      listen: 'Listen only',
      wantToSpeak: 'Want to speak',
      stopSpeaking: 'Stop speaking',
      mute: 'Mute microphone',
      unmute: 'Unmute microphone',
      deafen: 'Mute incoming audio',
      undeafen: 'Enable incoming audio',
      leave: 'Leave voice',
      close: 'Close',
      microphone: 'Microphone',
      defaultMic: 'Default microphone',
      joining: 'Joining…',
      connected: 'Connected',
      reconnecting: 'Reconnecting…',
      ended: 'Voice ended',
      error: 'Voice error',
      participant: 'participant',
      participants: 'participants',
      nobody: 'You are the only listener here for now.',
      listening: 'listening',
      micOn: 'microphone active',
      micMuted: 'microphone muted',
      allow: 'Allow voice in WORLD and rooms',
      allowHelp: 'Voice is always opt-in. Disabling this leaves active voice and rejects new room voice invites.',
      settingsTitle: 'WORLD / room voice',
      disabled: 'WORLD/room voice is disabled in settings.',
      privateBusy: 'End the private audio call before joining room voice.',
      permissionDenied: 'Microphone access was denied. Allow Konofix to use the microphone.',
      deviceMissing: 'No usable microphone was found.',
      deviceBusy: 'The microphone is busy or unavailable.',
      constraintFailed: 'The selected microphone cannot satisfy the requested settings.',
      unsupported: 'This system/WebView does not support the required WebRTC audio features.',
      captureFailed: 'Unable to start or switch the microphone.',
      invalidSignal: 'An invalid audio signal was rejected.',
      playbackBlocked: 'Incoming audio playback was blocked. Toggle incoming audio again.',
      policyError: 'Could not synchronize room voice preferences with the P2P network.',
      signalingError: 'Could not connect to one of the voice participants.',
    };

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value !== '0';
}

function setStoredBoolean(key: string, value: boolean): void {
  localStorage.setItem(key, value ? '1' : '0');
}

function roomVoiceEnabled(): boolean {
  return storedBoolean(ROOM_VOICE_ENABLED_KEY, true);
}

function privateCallsEnabled(): boolean {
  return storedBoolean(PRIVATE_CALLS_ENABLED_KEY, true);
}

function defaultDeafened(): boolean {
  return storedBoolean(DEFAULT_DEAFENED_KEY, false);
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

function phaseLabel(session: VoiceSession): string {
  switch (session.phase) {
    case 'joining': return copy.joining;
    case 'connected': return copy.connected;
    case 'reconnecting': return copy.reconnecting;
    case 'ended': return copy.ended;
    case 'error': return copy.error;
    default: return copy.voice;
  }
}

function currentRoomId(): string {
  return document.querySelector<HTMLButtonElement>('button[data-room].active')?.dataset.room ?? '';
}

function currentRoomTitle(): string {
  return document.querySelector<HTMLElement>('.chat-header h2')?.textContent?.trim() || '# WORLD';
}

function collectPeers(): RoomVoicePeer[] {
  const peers = new Map<string, RoomVoicePeer>();
  document.querySelectorAll<HTMLElement>('#peerList .user').forEach(row => {
    const fileButton = row.querySelector<HTMLButtonElement>('[data-send-peer]');
    const peerId = fileButton?.dataset.sendPeer?.trim() ?? '';
    if (!peerId || peers.has(peerId)) return;
    const nick = row.querySelector('strong')?.textContent?.trim() || peerId;
    peers.set(peerId, { peerId, nick });
  });
  return [...peers.values()];
}

function privateCallActive(): boolean {
  const phase = document.querySelector<HTMLElement>('#privateAudioPanel .private-audio-phase');
  if (!phase) return false;
  return !phase.classList.contains('phase-ended') && !phase.classList.contains('phase-error');
}

let latestSession: VoiceSession | null = null;
let activeRoomId = '';
let activeRoomTitle = '';
let currentError = '';
let devices: AudioInputDevice[] = [];
let selectedDeviceId = '';
let loadedDevicesForSession = '';
let peerSyncQueued = false;
let policySynced = false;
const remoteStreams = new Map<string, MediaStream>();

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

const controller = new RoomAudioCallController(signaler, {
  events: {
    onSession(session) {
      latestSession = session;
      if (session.scope.kind === 'room') activeRoomId = session.scope.roomId;
      if (session.phase === 'connected' && session.roomIntent === 'speak' && loadedDevicesForSession !== session.id) {
        loadedDevicesForSession = session.id;
        void refreshDevices();
      }
      renderRoomVoicePanel();
      augmentJoinButton();
    },
    onRemoteStream(peerId, stream) {
      remoteStreams.set(peerId, stream);
      renderRoomVoicePanel();
    },
    onParticipantLeft(peerId) {
      remoteStreams.delete(peerId);
      renderRoomVoicePanel();
    },
    onMediaError(error) {
      currentError = mediaErrorText(error);
      renderRoomVoicePanel();
    },
    onSignalingError() {
      currentError = copy.signalingError;
      renderRoomVoicePanel();
    },
  },
});

function applyPreferences(): void {
  controller.sessions.setPreferences({
    allowRoomVoice: roomVoiceEnabled(),
    defaultDeafened: defaultDeafened(),
  });
}

async function syncVoicePolicy(showError = false): Promise<void> {
  applyPreferences();
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
  const node = document.querySelector<HTMLElement>('[data-room-voice-settings-status]');
  if (node) node.textContent = message;
}

function resetRoomVoiceUi(): void {
  controller.reset();
  latestSession = null;
  activeRoomId = '';
  activeRoomTitle = '';
  currentError = '';
  devices = [];
  selectedDeviceId = '';
  loadedDevicesForSession = '';
  remoteStreams.clear();
  document.querySelector('#roomAudioPanel')?.remove();
  augmentJoinButton();
}

async function joinCurrentRoom(): Promise<void> {
  if (!roomVoiceEnabled()) {
    alert(copy.disabled);
    return;
  }
  if (privateCallActive()) {
    alert(copy.privateBusy);
    return;
  }
  const roomId = currentRoomId();
  if (!roomId) return;
  const existing = controller.activeSession();
  if (existing?.scope.kind === 'room' && existing.scope.roomId === roomId) {
    renderRoomVoicePanel();
    return;
  }
  if (existing) await controller.leaveRoom();
  if (latestSession && ['ended', 'error'].includes(latestSession.phase)) resetRoomVoiceUi();

  activeRoomId = roomId;
  activeRoomTitle = currentRoomTitle();
  currentError = '';
  devices = [];
  selectedDeviceId = '';
  loadedDevicesForSession = '';
  remoteStreams.clear();
  try {
    latestSession = await controller.joinRoom(roomId, collectPeers(), 'listen');
    renderRoomVoicePanel();
  } catch (error) {
    currentError = mediaErrorText(error);
    renderRoomVoicePanel();
  }
}

async function leaveRoomVoice(): Promise<void> {
  await controller.leaveRoom();
  latestSession = latestSession && latestSession.phase === 'ended'
    ? latestSession
    : controller.activeSession() ?? latestSession;
  remoteStreams.clear();
  renderRoomVoicePanel();
  augmentJoinButton();
}

async function toggleSpeakIntent(): Promise<void> {
  const session = controller.activeSession();
  if (!session) return;
  try {
    latestSession = await controller.setIntent(session.roomIntent === 'speak' ? 'listen' : 'speak');
    currentError = '';
    if (latestSession.roomIntent === 'speak') await refreshDevices();
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderRoomVoicePanel();
}

async function toggleMute(): Promise<void> {
  const session = controller.activeSession();
  if (!session || session.roomIntent !== 'speak') return;
  try {
    latestSession = await controller.setMuted(!session.localMuted);
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderRoomVoicePanel();
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
  renderRoomVoicePanel();
}

async function refreshDevices(): Promise<void> {
  const session = controller.activeSession();
  if (!session || session.roomIntent !== 'speak') return;
  try {
    devices = await controller.listInputDevices(false);
    if (!selectedDeviceId) {
      selectedDeviceId = devices.find(device => device.isDefault)?.deviceId ?? devices[0]?.deviceId ?? '';
    }
    currentError = '';
  } catch (error) {
    currentError = mediaErrorText(error);
  }
  renderRoomVoicePanel();
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
  renderRoomVoicePanel();
}

function participantStatus(session: VoiceSession, peerId: string): string {
  const participant = session.participants.get(peerId);
  if (!participant) return copy.listening;
  if (participant.speaking && !participant.muted) return copy.micOn;
  if (participant.muted) return copy.micMuted;
  return copy.listening;
}

function renderRoomVoicePanel(): void {
  const session = controller.activeSession() ?? latestSession;
  if (!session || session.scope.kind !== 'room' || !activeRoomId) {
    document.querySelector('#roomAudioPanel')?.remove();
    return;
  }

  let wrap = document.querySelector<HTMLDivElement>('#roomAudioPanel');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'roomAudioPanel';
    document.body.appendChild(wrap);
  }

  const terminal = ['ended', 'error'].includes(session.phase);
  const active = ['joining', 'connected', 'reconnecting'].includes(session.phase);
  const speaking = session.roomIntent === 'speak';
  const participants = [...session.participants.values()];
  const total = participants.length + 1;
  const participantWord = total === 1 ? copy.participant : copy.participants;
  const options = devices.length
    ? devices.map(device => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === selectedDeviceId ? 'selected' : ''}>${escapeHtml(device.label || copy.microphone)}</option>`).join('')
    : `<option value="">${escapeHtml(copy.defaultMic)}</option>`;
  const participantRows = participants.length
    ? participants.map(participant => `
        <div class="room-audio-participant ${participant.speaking && !participant.muted ? 'is-speaking' : ''}">
          <span class="room-audio-participant-icon">${participant.speaking && !participant.muted ? '🎙️' : participant.muted ? '🔇' : '🎧'}</span>
          <span><strong>${escapeHtml(participant.nick)}</strong><small>${escapeHtml(participantStatus(session, participant.peerId))}</small></span>
        </div>`).join('')
    : `<div class="room-audio-empty">${escapeHtml(copy.nobody)}</div>`;

  wrap.innerHTML = `
    <section class="room-audio-panel glass" role="region" aria-label="${escapeHtml(copy.voice)}">
      <header class="room-audio-head">
        <div>
          <span class="eyebrow">P2P ROOM VOICE</span>
          <strong>${escapeHtml(activeRoomTitle || activeRoomId)}</strong>
          <span class="room-audio-phase phase-${escapeHtml(session.phase)}"><i></i>${escapeHtml(phaseLabel(session))}</span>
        </div>
        <span class="room-audio-count">${total} ${escapeHtml(participantWord)}</span>
      </header>
      <div class="room-audio-participants">${participantRows}</div>
      <div class="room-audio-intent">
        <button type="button" data-room-audio-intent class="${speaking ? 'is-speaking' : ''}" ${active && !terminal ? '' : 'disabled'}>
          ${speaking ? '🎙️ ' + escapeHtml(copy.stopSpeaking) : '✋ ' + escapeHtml(copy.wantToSpeak)}
        </button>
        <span>${escapeHtml(speaking ? copy.micOn : copy.listen)}</span>
      </div>
      <label class="room-audio-device">
        <span>${escapeHtml(copy.microphone)}</span>
        <select data-room-audio-device ${speaking && active && devices.length ? '' : 'disabled'}>${options}</select>
      </label>
      <div class="room-audio-controls">
        <button type="button" data-room-audio-mute class="${session.localMuted ? 'is-active' : ''}" ${speaking && active ? '' : 'disabled'} title="${escapeHtml(session.localMuted ? copy.unmute : copy.mute)}" aria-label="${escapeHtml(session.localMuted ? copy.unmute : copy.mute)}">${session.localMuted ? '🔇' : '🎙️'}</button>
        <button type="button" data-room-audio-deafen class="${session.deafened ? 'is-active' : ''}" ${active ? '' : 'disabled'} title="${escapeHtml(session.deafened ? copy.undeafen : copy.deafen)}" aria-label="${escapeHtml(session.deafened ? copy.undeafen : copy.deafen)}">${session.deafened ? '🔕' : '🔊'}</button>
        ${terminal
          ? `<button type="button" class="room-audio-close" data-room-audio-close>${escapeHtml(copy.close)}</button>`
          : `<button type="button" class="room-audio-leave" data-room-audio-leave>${escapeHtml(copy.leave)}</button>`}
      </div>
      <div class="room-audio-error" data-room-audio-error role="status" aria-live="polite">${escapeHtml(currentError || session.error || '')}</div>
      <div class="room-audio-streams" aria-hidden="true">
        ${[...remoteStreams.keys()].map(peerId => `<audio data-room-audio-peer="${escapeHtml(peerId)}" autoplay></audio>`).join('')}
      </div>
    </section>`;

  wrap.querySelector('[data-room-audio-intent]')?.addEventListener('click', () => { void toggleSpeakIntent(); });
  wrap.querySelector('[data-room-audio-mute]')?.addEventListener('click', () => { void toggleMute(); });
  wrap.querySelector('[data-room-audio-deafen]')?.addEventListener('click', () => { void toggleDeafen(); });
  wrap.querySelector('[data-room-audio-leave]')?.addEventListener('click', () => { void leaveRoomVoice(); });
  wrap.querySelector('[data-room-audio-close]')?.addEventListener('click', resetRoomVoiceUi);
  wrap.querySelector<HTMLSelectElement>('[data-room-audio-device]')?.addEventListener('change', event => {
    void switchDevice((event.currentTarget as HTMLSelectElement).value);
  });

  remoteStreams.forEach((stream, peerId) => {
    const audio = wrap?.querySelector<HTMLAudioElement>(`audio[data-room-audio-peer="${CSS.escape(peerId)}"]`);
    if (!audio) return;
    audio.srcObject = stream;
    audio.muted = session.deafened;
    void audio.play().catch(() => {
      const errorNode = wrap?.querySelector<HTMLElement>('[data-room-audio-error]');
      if (errorNode && !errorNode.textContent) errorNode.textContent = copy.playbackBlocked;
    });
  });
}

function augmentJoinButton(): void {
  const actions = document.querySelector<HTMLElement>('.chat-header .header-actions');
  if (!actions) return;
  let button = actions.querySelector<HTMLButtonElement>('[data-room-audio-join]');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost room-audio-join';
    button.dataset.roomAudioJoin = 'true';
    actions.prepend(button);
    button.addEventListener('click', () => { void joinCurrentRoom(); });
  }

  const roomId = currentRoomId();
  const session = controller.activeSession();
  const sameRoom = Boolean(session?.scope.kind === 'room' && session.scope.roomId === roomId);
  const count = sameRoom && session ? session.participants.size + 1 : 0;
  button.classList.toggle('is-active', sameRoom);
  button.disabled = !roomVoiceEnabled();
  const label = sameRoom
    ? `🎧 ${copy.voice} ${count}`
    : session
      ? `🎧 ${copy.change}`
      : `🎧 ${copy.join}`;

  // This function runs from a childList MutationObserver. Reassigning textContent
  // unconditionally creates another childList mutation and can spin the WebView
  // in a self-triggering loop immediately after the chat UI appears.
  if (button.textContent !== label) button.textContent = label;
  if (button.title !== label) button.title = label;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
}

function augmentRoomVoiceSettings(): void {
  const modal = document.querySelector<HTMLDivElement>('#networkModal .modal');
  if (!modal || modal.querySelector('[data-room-voice-settings]')) return;
  const section = document.createElement('section');
  section.className = 'private-settings-card room-audio-settings-card';
  section.dataset.roomVoiceSettings = 'true';
  section.innerHTML = `
    <div>
      <strong>${escapeHtml(copy.settingsTitle)}</strong>
      <small>${escapeHtml(copy.allowHelp)}</small>
    </div>
    <label class="private-setting-toggle">
      <input type="checkbox" data-room-audio-enabled ${roomVoiceEnabled() ? 'checked' : ''} />
      <span>${escapeHtml(copy.allow)}</span>
    </label>
    <small class="room-audio-settings-status" data-room-voice-settings-status>${policySynced ? '' : ''}</small>`;
  modal.appendChild(section);

  section.querySelector<HTMLInputElement>('[data-room-audio-enabled]')?.addEventListener('change', event => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    setStoredBoolean(ROOM_VOICE_ENABLED_KEY, enabled);
    applyPreferences();
    if (!enabled) {
      void controller.leaveRoom().finally(resetRoomVoiceUi);
    }
    void syncVoicePolicy(true);
    augmentJoinButton();
  });
}

function queuePeerSync(): void {
  if (peerSyncQueued || !controller.activeSession()) return;
  peerSyncQueued = true;
  queueMicrotask(() => {
    peerSyncQueued = false;
    if (!controller.activeSession()) return;
    void controller.syncPeers(collectPeers()).catch(error => {
      currentError = error instanceof Error ? error.message : String(error);
      renderRoomVoicePanel();
    });
  });
}

function augmentUi(): void {
  augmentJoinButton();
  augmentRoomVoiceSettings();
}

applyPreferences();

void listen<DirectVoiceSignal>('voice-signal', event => {
  if (event.payload.scope.kind !== 'room') return;
  void controller.handleSignal(event.payload).catch(error => {
    currentError = mediaErrorText(error);
    renderRoomVoicePanel();
  });
});

void listen<{ phase?: string }>('network-status', event => {
  if (event.payload?.phase === 'offline') {
    policySynced = false;
    resetRoomVoiceUi();
    return;
  }
  void syncVoicePolicy();
});

void listen('peer-online', queuePeerSync);
void listen('peer-offline', queuePeerSync);

void listen<{ room_id: string }>('room-closed', event => {
  if (event.payload.room_id !== activeRoomId) return;
  void controller.leaveRoom().finally(resetRoomVoiceUi);
});

void listen('network-error', () => {
  policySynced = false;
  resetRoomVoiceUi();
});

new MutationObserver(augmentUi).observe(document.body, { childList: true, subtree: true });
augmentUi();
