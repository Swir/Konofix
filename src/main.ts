import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n';
import { DEFAULT_NICK_COLOR, KONOFIX_EMOJI, NICK_COLORS, normalizeNickColor, renderChatText } from './chat-expression';
import './style.css';
import { openKnpChatUi, closeKnpChatUi } from './knp-chat-ui';
import {
  WorldRelayBridge,
  type RelayFileOffer,
  type RelayFileProgress,
  type RelayFileReady,
  type RelayFileSelection,
  type RelayPeer,
  type RelayPrivateMessage,
  type RelayPublicFileOffer,
  type RelayRoomInfo,
  type RelayState,
  type RtcSignal,
  type VoiceSignal,
  type WorldVoiceState,
} from './world-relay';
import {
  PeerTransport,
  type DirectFileOffer,
  type DirectFileProgress,
  type RtcFileDescriptor,
} from './peer-transport';
import { GroupVoice, type GroupVoiceSnapshot } from './group-voice';
import { testMicrophone, testSpeakers } from './audio-diagnostics';
import { checkForStableUpdate } from './updater';

type PublicShareOffer = {
  offer_id: string;
  peer_id: string;
  nick: string;
  nick_color?: string;
  file_name: string;
  size: number;
  sha256: string;
  kind: 'file' | 'image';
  mime?: string;
  room_id?: string;
  timestamp: number;
  expires_at: number;
  preview_data?: string;
  expired?: boolean;
};
type ChatMessage = {
  id: string;
  kind: string;
  peer_id?: string;
  nick: string;
  nick_color?: string;
  room: string;
  text: string;
  timestamp: number;
  public_offer?: PublicShareOffer;
};
type PeerInfo = { peer_id: string; nick: string; nick_color?: string };
type RoomInfo = { id: string; title: string; owner?: string; users?: number; password_protected?: boolean; auth_revision?: number };
type RoomUserCountUpdate = { room_id: string; users: number };
type NetworkStatus = {
  phase: string;
  connected_peers: number;
  routes: { peer_id: string; connection_id: string; path: 'direct' | 'relay'; transport: string; remote_address: string }[];
  dht_peers: number;
  bootstrap_count: number;
  bootstrap_connected: number;
  nat: string;
  listen_addresses: string[];
  detail: string;
};
type FileOffer = { transfer_id: string; peer_id: string; nick: string; file_name: string; size: number; room_id?: string };
type FileOfferExpired = { transfer_id: string; peer_id: string };
type FileOfferCancelled = { transfer_id: string; peer_id: string };
type FileTransfer = {
  transfer_id: string;
  direction: 'incoming' | 'outgoing';
  peer_id: string;
  nick: string;
  public_offer_id?: string;
  preview_only?: boolean;
  file_name: string;
  size: number;
  transferred: number;
  progress: number;
  status: string;
  path?: string;
  error?: string;
};

const EMPTY_STATUS: NetworkStatus = {
  phase: 'offline', connected_peers: 0, dht_peers: 0, bootstrap_count: 0, bootstrap_connected: 0,
  nat: 'unknown', listen_addresses: [], routes: [], detail: 'Disconnected'
};

const state = {
  nick: '',
  nickColor: normalizeNickColor(localStorage.getItem('konofix.nickColor')),
  peerId: '',
  version: '0.6.0-5',
  room: 'world',
  connected: false,
  peers: new Map<string, PeerInfo>(),
  rooms: new Map<string, RoomInfo>([['world', { id: 'world', title: '# WORLD' }]]),
  messages: new Map<string, ChatMessage[]>([['world', []]]),
  transfers: new Map<string, FileTransfer>(),
  publicOffers: new Map<string, PublicShareOffer>(),
  publicIntents: new Map<string, 'download' | 'preview'>(),
  status: { ...EMPTY_STATUS } as NetworkStatus,
};

let sessionRevision = 0;
let connectPending = false;
let roomChangePending = false;
export const worldRelay = new WorldRelayBridge();
export const peerTransport = new PeerTransport();
export const groupVoice = new GroupVoice();
const worldRelayPeers = new Map<string, RelayPeer>();
const relayOnlyRoomIds = new Set<string>();
const directTransferIds = new Set<string>();
const publicTransferTokens = new Map<string, { offerId: string; intent: 'download' | 'preview' }>();
const publicClaimTimers = new Map<string, number>();
const PUBLIC_CLAIM_TIMEOUT_MS = 45_000;
let worldRelayState: RelayState = { connected: 0, total: 0 };
let groupVoiceSnapshot: GroupVoiceSnapshot = {
  world: [], canStartWorld: false, secondsLeft: 0, roomActive: false, roomPeers: 0,
};
const groupAudio = new Map<string, HTMLAudioElement>();
const blockedGroupAudio = new Set<string>();
const WORLD_AUDIO_MUTED_KEY = 'konofix.worldAudioMuted';
let worldAudioMuted = localStorage.getItem(WORLD_AUDIO_MUTED_KEY) === 'true';
let groupAudioWarningShown = false;
let updateCheckPending = false;

const app = document.querySelector<HTMLDivElement>('#app')!;

function esc(s: string): string {
  return s.replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[ch]!));
}

function normalizeNick(v: string): string {
  return v.trim().replace(/\s+/g, '_').slice(0, 24);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return value === 0 ? '0 B' : '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / Math.pow(1024, i)).toFixed(i === 0 ? 0 : i >= 3 ? 2 : 1)} ${units[i]}`;
}

function dangerousFile(name: string): boolean {
  return /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|reg|lnk|hta|jar)$/i.test(name);
}

function voicePanelHtml(): string {
  if (worldRelayState.total === 0) {
    return `<section id="voicePanel" class="voice-panel"><div class="voice-main"><div><span class="eyebrow">${esc(t('voice.worldTitle'))}</span><div class="voice-idle">${esc(t('voice.unavailable'))}</div></div></div></section>`;
  }
  if (state.room === 'world') {
    const snapshot = groupVoiceSnapshot;
    const speaker = snapshot.speaker;
    const waiting = snapshot.world.filter(item => item.peer_id !== speaker?.peer_id);
    const mine = snapshot.localWorld;
    const action = mine?.status === 'speaking'
      ? t('voice.finish')
      : mine?.status === 'queued'
        ? (snapshot.canStartWorld ? t('voice.startTurn') : t('voice.leaveQueue'))
        : t('voice.wantToSpeak');
    const status = speaker
      ? `<div class="voice-speaker"><span>🎙</span><strong style="color:${normalizeNickColor(speaker.nick_color)}">${esc(speaker.nick)}</strong><b>${snapshot.secondsLeft}s</b></div>`
      : `<div class="voice-idle">${esc(t('voice.worldIdle'))}</div>`;
    const queue = waiting.length
      ? `<div class="voice-queue"><span>${esc(t('voice.queue'))}</span>${waiting.slice(0, 8).map((item, index) => `<b>${index + 1}. ${esc(item.nick)}</b>`).join('')}</div>`
      : `<div class="voice-queue empty">${esc(t('voice.queueEmpty'))}</div>`;
    return `<section id="voicePanel" class="voice-panel world-voice">
      <div class="voice-main"><div><span class="eyebrow">${esc(t('voice.worldTitle'))}</span>${status}</div><button id="worldVoiceAction" class="${snapshot.canStartWorld ? 'primary compact' : 'ghost'}">${esc(action)}</button></div>
      ${queue}${snapshot.error ? `<div class="voice-error">${esc(snapshot.error)}</div>` : ''}
    </section>`;
  }
  if (state.rooms.get(state.room)?.password_protected) {
    return `<section id="voicePanel" class="voice-panel room-voice">
      <div class="voice-main"><div><span class="eyebrow">${esc(t('voice.roomTitle'))}</span><div class="voice-idle">${esc(t('voice.protectedUnavailable'))}</div></div></div>
    </section>`;
  }
  const activeHere = groupVoiceSnapshot.roomActive && groupVoiceSnapshot.roomScope === state.room;
  return `<section id="voicePanel" class="voice-panel room-voice">
    <div class="voice-main"><div><span class="eyebrow">${esc(t('voice.roomTitle'))}</span><div class="voice-idle">${esc(activeHere ? t('voice.roomActive', { count: groupVoiceSnapshot.roomPeers + 1 }) : t('voice.roomHelp'))}</div></div>
    <button id="roomVoiceAction" class="${activeHere ? 'ghost' : 'primary compact'}">${esc(activeHere ? t('voice.leaveRoom') : t('voice.joinRoom'))}</button></div>
    ${groupVoiceSnapshot.error ? `<div class="voice-error">${esc(groupVoiceSnapshot.error)}</div>` : ''}
  </section>`;
}

function wireVoicePanel(): void {
  document.querySelector('#worldVoiceAction')?.addEventListener('click', async () => {
    const local = groupVoice.snapshot().localWorld;
    if (local?.status === 'speaking') groupVoice.leaveWorld();
    else if (local?.status === 'queued' && groupVoice.snapshot().canStartWorld) await groupVoice.startWorldTurn();
    else if (local?.status === 'queued') groupVoice.leaveWorld();
    else await groupVoice.requestWorldTurn();
  });
  document.querySelector('#roomVoiceAction')?.addEventListener('click', async () => {
    const snapshot = groupVoice.snapshot();
    if (snapshot.roomActive && snapshot.roomScope === state.room) groupVoice.leaveRoom();
    else await groupVoice.joinRoom(state.room);
  });
}

function updateVoicePanel(): void {
  if (!state.connected) return;
  const current = document.querySelector<HTMLElement>('#voicePanel');
  if (!current) return;
  current.outerHTML = voicePanelHtml();
  wireVoicePanel();
}

function playGroupAudio(scope: string, peerId: string, stream: MediaStream | null): void {
  const key = `${scope}\u0000${peerId}`;
  const existing = groupAudio.get(key);
  if (!stream) {
    if (existing) {
      existing.pause();
      existing.srcObject = null;
      existing.remove();
      groupAudio.delete(key);
      blockedGroupAudio.delete(key);
    }
    return;
  }
  const audio = existing ?? document.createElement('audio');
  audio.autoplay = true;
  audio.volume = 1;
  audio.muted = scope === 'world' && worldAudioMuted;
  audio.setAttribute('playsinline', '');
  audio.hidden = true;
  audio.srcObject = stream;
  if (!existing) {
    document.body.appendChild(audio);
    groupAudio.set(key, audio);
  }
  void audio.play().then(() => {
    blockedGroupAudio.delete(key);
  }).catch(() => {
    blockedGroupAudio.add(key);
    if (!audio.muted && !groupAudioWarningShown) {
      groupAudioWarningShown = true;
      addSystem(state.room, t('audio.outputBlocked'));
      if (state.connected) renderChat();
    }
  });
}

function resumeGroupAudio(): void {
  if (blockedGroupAudio.size === 0) return;
  groupAudioWarningShown = false;
  for (const key of [...blockedGroupAudio]) {
    const audio = groupAudio.get(key);
    if (!audio || audio.muted) {
      blockedGroupAudio.delete(key);
      continue;
    }
    void audio.play().then(() => blockedGroupAudio.delete(key)).catch(() => blockedGroupAudio.add(key));
  }
}

window.addEventListener('pointerdown', resumeGroupAudio, { passive: true });
window.addEventListener('keydown', resumeGroupAudio);

function clearGroupAudio(): void {
  for (const audio of groupAudio.values()) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  groupAudio.clear();
  blockedGroupAudio.clear();
  groupAudioWarningShown = false;
}

async function runStableUpdateCheck(manual = false): Promise<void> {
  if (updateCheckPending) return;
  updateCheckPending = true;
  const status = (message: string) => {
    const element = document.querySelector<HTMLElement>('#updateStatus');
    if (element) element.textContent = message;
  };
  try {
    const result = await checkForStableUpdate({
      ask: update => Promise.resolve(window.confirm(t('update.available', { version: update.version }))),
      onStatus: (phase, percent) => {
        if (phase === 'checking') status(t('update.checking'));
        else if (phase === 'downloading') status(t('update.downloading', { percent: percent ?? '…' }));
        else status(t('update.installing'));
      },
    });
    if (result === 'current') {
      status(t('update.current'));
      if (manual) window.alert(t('update.current'));
    } else if (result === 'declined') {
      status(t('update.declined'));
    } else if (result === 'unsupported') {
      status(t('update.desktopOnly'));
      if (manual) window.alert(t('update.desktopOnly'));
    }
  } catch (error) {
    const message = t('update.failed', { error: String(error) });
    status(message);
    if (manual) window.alert(message);
    else console.error(message);
  } finally {
    updateCheckPending = false;
  }
}

function loadBootstraps(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem('konofix.bootstraps') || '[]');
    return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()) : [];
  } catch { return []; }
}

function saveBootstraps(items: string[]) {
  localStorage.setItem('konofix.bootstraps', JSON.stringify([...new Set(items.map(v => v.trim()).filter(Boolean))]));
}

function creditHtml(): string {
  return `<div class="app-credit">by <strong>Swir</strong><span>•</span><button type="button" data-github-link>GitHub</button></div>`;
}

function wireCredit() {
  document.querySelectorAll<HTMLButtonElement>('[data-github-link]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await invoke('open_github'); }
      catch (e) { console.error(t('credit.openGithubError'), e); }
    });
  });
}

let publicDiscoveryOptIn = true;
let relayConsent = true;
let discoveryStatus = { phase: 'off', relay_enabled: false, public_reachability: false };
function discoveryLabel(): string {
  const labels: Record<string, string> = {
    off: t('network.coldOff'), searching: t('network.coldSearching'),
    'network-changed': t('network.coldRecovering'), 'entry-unreachable': t('network.coldUnavailable'),
    'no-verified-participant': t('network.coldNoPeer'), 'verified-participant': t('network.coldVerified')
  };
  return labels[discoveryStatus.phase] || t('network.coldUnavailable');
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="brand-panel">
        <div class="brand-mark">K</div>
        <div>
          <div class="eyebrow">GLOBAL PEER-TO-PEER CHAT</div>
          <h1>Konofix Chat <span>P2P</span></h1>
          <p>${esc(t('app.tagline'))}</p>
          <div class="feature-row">
            <span>${esc(t('app.noAccount'))}</span><span>${esc(t('app.noServerHistory'))}</span><span>${esc(t('app.p2pFiles'))}</span>
          </div>
        </div>
      </section>

      <section class="login-card glass">
        <div class="online-pill"><i></i> P2P ENGINE 0.4</div>
        <h2>${esc(t('login.joinWorld'))}</h2>
        <p class="muted">${esc(t('login.nickHelp'))}</p>
        <label for="nick">${esc(t('login.nickLabel'))}</label>
        <input id="nick" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${esc(t('login.nickPlaceholder'))}" />
        <label>${esc(t('login.nickColor'))}</label>
        <div class="nick-color-picker" role="radiogroup" aria-label="${esc(t('login.nickColor'))}">
          ${NICK_COLORS.map(item => `<button type="button" class="nick-color-swatch ${item.value === state.nickColor ? 'selected' : ''}" data-nick-color="${item.value}" role="radio" aria-checked="${item.value === state.nickColor}" title="${esc(item.label)}" style="--nick-color:${item.value}"></button>`).join('')}
        </div>
        <div class="nick-color-preview"><span style="color:${state.nickColor}">●</span> <strong style="color:${state.nickColor}">${esc(t('login.nickColorPreview'))}</strong></div>
        <details class="network-options"><summary>${esc(t('network.experimentalOptions'))}</summary>
        <label><input id="publicDiscoveryOptIn" type="checkbox" ${publicDiscoveryOptIn ? 'checked' : ''} /> ${esc(t('network.coldOptIn'))}</label>
        <p class="muted">${esc(t('network.coldPrivacy'))}</p>
        <label><input id="relayConsent" type="checkbox" ${relayConsent ? 'checked' : ''} /> ${esc(t('network.relayConsent'))}</label>
        <p class="muted">${esc(t('network.relayBudget'))}</p>
        </details>
        <div id="loginError" class="error"></div>
        <button id="connectBtn" class="primary">${esc(t('login.connect'))}</button>
        <button id="loginNetwork" class="link-btn">${esc(t('login.advancedNetwork'))}</button>
        <div class="privacy-note">${esc(t('login.privacy'))}</div>
      </section>
    </main>
    ${creditHtml()}`;

  wireCredit();
  const input = document.querySelector<HTMLInputElement>('#nick')!;
  input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  document.querySelectorAll<HTMLButtonElement>('[data-nick-color]').forEach(button => button.addEventListener('click', () => {
    state.nickColor = normalizeNickColor(button.dataset.nickColor);
    localStorage.setItem('konofix.nickColor', state.nickColor);
    renderLogin();
    document.querySelector<HTMLInputElement>('#nick')!.value = input.value;
    document.querySelector<HTMLInputElement>('#nick')!.focus();
  }));
  document.querySelector<HTMLInputElement>('#publicDiscoveryOptIn')?.addEventListener('change', e => { publicDiscoveryOptIn = (e.target as HTMLInputElement).checked; });
  document.querySelector<HTMLInputElement>('#relayConsent')?.addEventListener('change', e => { relayConsent = (e.target as HTMLInputElement).checked; });
  document.querySelector('#connectBtn')?.addEventListener('click', connect);
  document.querySelector('#loginNetwork')?.addEventListener('click', showNetworkModal);
}

async function connect() {
  if (connectPending) return;
  const input = document.querySelector<HTMLInputElement>('#nick')!;
  const error = document.querySelector<HTMLDivElement>('#loginError')!;
  const nick = normalizeNick(input.value);
  error.textContent = '';

  if (nick.length < 3) {
    error.textContent = t('login.nickTooShort');
    return;
  }
  if (!/^[\p{L}\p{N}_\-.]+$/u.test(nick)) {
    error.textContent = t('login.nickInvalid');
    return;
  }

  connectPending = true;
  const revision = ++sessionRevision;
  const btn = document.querySelector<HTMLButtonElement>('#connectBtn')!;
  btn.disabled = true;
  btn.textContent = t('login.starting');

  try {
    const result = await invoke<{ peer_id: string; nick: string; nick_color: string; version: string }>('start_network', {
      nick,
      nickColor: state.nickColor,
      bootstraps: loadBootstraps(),
      enableKnpTransport: false,
      enablePublicDiscovery: publicDiscoveryOptIn,
      consentRelay: relayConsent,
    });
    if (revision !== sessionRevision) return;
    connectPending = false;
    state.nick = result.nick;
    state.nickColor = normalizeNickColor(result.nick_color);
    localStorage.setItem('konofix.nickColor', state.nickColor);
    state.peerId = result.peer_id;
    state.version = result.version;
    state.connected = true;
    if (publicDiscoveryOptIn) startWorldRelay();
    renderChat();
    addSystem('world', t('login.connectedAs', { nick: state.nick }));
  } catch (e) {
    if (revision !== sessionRevision) return;
    connectPending = false;
    error.textContent = String(e);
    btn.disabled = false;
    btn.textContent = t('login.connect');
  }
}

function renderChat() {
  const currentRoom = state.rooms.get(state.room) ?? { id: state.room, title: `# ${state.room.toUpperCase()}`, users: 0 };
  const messages = state.messages.get(state.room) ?? [];
  const onlineCount = Math.max(1, state.peers.size + 1);
  const activeRoomCount = state.room === 'world' ? onlineCount : Math.max(0, Number(currentRoom.users) || 0);
  const networkClass = state.status.phase === 'online' || worldRelayState.connected > 0 ? 'good' : state.status.phase === 'searching' ? 'searching' : 'off';
  const transfers = [...state.transfers.values()].slice(-5).reverse();

  app.innerHTML = `
    <main class="chat-shell">
      <aside class="sidebar glass">
        <div class="logo-row">
          <div class="brand-mark small">K</div>
          <div><strong>Konofix Chat</strong><span>P2P v${esc(state.version)}</span></div>
        </div>

        <button class="room ${state.room === 'world' ? 'active' : ''}" data-room="world"><span>#</span> WORLD <b>${onlineCount}</b></button>
        <div class="section-title">${esc(t('rooms.temporary'))}</div>
        <div id="rooms">${[...state.rooms.values()].filter(r => r.id !== 'world').map(roomButton).join('')}</div>
        <button id="newRoom" class="ghost wide">${esc(t('rooms.create'))}</button>

        <button id="optionalKnp" class="ghost wide">${esc(t('knp.openOptional'))}</button>
        <div class="network-card" id="networkCard">
          <div class="network-top"><span class="net-dot ${networkClass}"></span><strong>${esc(networkLabel())}</strong><button id="refreshNetwork" title="${esc(t('network.refresh'))}">↻</button></div>
          <small>${esc(networkSubtitle())}</small>
          <small id="internetEntryStatus">${esc(internetEntryLabel())}</small>
        </div>

        <div class="sidebar-bottom">
          <div class="me-dot"></div>
          <div class="me-info"><strong style="color:${state.nickColor}">${esc(state.nick)}</strong><span>${shortPeer(state.peerId)}</span></div>
          <button id="networkSettings" class="icon-btn" title="${esc(t('network.settings'))}">⚙</button>
          <button id="disconnect" class="icon-btn danger" title="${esc(t('network.disconnect'))}">⏻</button>
        </div>
      </aside>

      <section class="chat-main glass">
        <header class="chat-header">
          <div>
            <h2>${esc(currentRoom.title)}</h2>
            <span>${esc(state.room === 'world' ? t('rooms.globalChannel') : t('rooms.hostOnly'))}</span>
          </div>
          <div class="header-actions">
            <span class="live"><i></i>${activeRoomCount} ${esc(t('common.online').toLowerCase())}</span>
            ${state.room === 'world' ? `
              <button id="shareWorldFile" class="ghost">${esc(t('publicShare.file'))}</button>
            ` : `<button id="shareRoomFile" class="ghost">${esc(t('transfer.sendFile'))}</button>`}
          </div>
        </header>

        ${voicePanelHtml()}

        <div id="messages" class="messages">
          ${messages.length ? messages.map(messageHtml).join('') : `<div class="empty"><div>🌐</div><strong>${esc(t('rooms.welcome', { room: currentRoom.title }))}</strong><span>${esc(t('rooms.firstMessage'))}</span></div>`}
        </div>

        <footer class="composer">
          <div class="emoji-wrap">
            <button id="emojiToggle" class="emoji-toggle" type="button" title="${esc(t('chat.emoji'))}" aria-label="${esc(t('chat.emoji'))}">☺</button>
            <div id="emojiPanel" class="emoji-panel" hidden>
              ${KONOFIX_EMOJI.filter((item, index, items) => items.findIndex(other => other.glyph === item.glyph) === index).map(item => `<button type="button" data-emoji-code="${esc(item.code)}" title="${esc(item.code)} · ${esc(item.label)}">${item.glyph}</button>`).join('')}
            </div>
          </div>
          <input id="msg" maxlength="4000" autocomplete="off" placeholder="${esc(t('chat.messageTo', { room: currentRoom.title }))}" />
          <button id="send" class="send" title="${esc(t('common.send'))}">➤</button>
        </footer>
      </section>

      <aside class="users glass">
        <div class="users-head"><strong>${esc(t('common.online'))}</strong><span>${onlineCount}</span></div>
        <div class="user self"><div class="avatar" style="--nick-color:${state.nickColor}">${esc(state.nick[0]?.toUpperCase() ?? 'S')}</div><div><strong style="color:${state.nickColor}">${esc(state.nick)}</strong><span>${esc(t('user.selfReserved'))}</span></div></div>
        <div id="peerList">${[...state.peers.values()].sort((a,b) => a.nick.localeCompare(b.nick)).map(peerHtml).join('')}</div>
        <div class="transfer-section">
          <div class="users-head"><strong>${esc(t('transfer.section'))}</strong><span>${transfers.filter(t => activeTransfer(t.status)).length}</span></div>
          <div class="transfer-list">${transfers.length ? transfers.map(transferHtml).join('') : `<div class="transfer-empty">${esc(t('transfer.none'))}</div>`}</div>
        </div>
      </aside>
    </main>
    ${creditHtml()}`;

  wireCredit();
  wireVoicePanel();
  document.querySelectorAll<HTMLElement>('[data-room]').forEach(el => el.addEventListener('click', () => switchRoom(el.dataset.room!)));
  document.querySelectorAll<HTMLElement>('[data-send-peer]').forEach(el => el.addEventListener('click', () => sendFileToPeer(el.dataset.sendPeer!)));
  document.querySelectorAll<HTMLElement>('[data-send-relay-peer]').forEach(el => el.addEventListener('click', () => sendFileToPeer(el.dataset.sendRelayPeer!)));
  document.querySelectorAll<HTMLElement>('[data-cancel-transfer]').forEach(el => el.addEventListener('click', () => cancelTransfer(el.dataset.cancelTransfer!)));
  document.querySelector('#newRoom')?.addEventListener('click', createRoom);
  document.querySelector('#send')?.addEventListener('click', sendMessage);
  document.querySelector('#shareRoomFile')?.addEventListener('click', () => sharePublic(state.room));
  document.querySelector('#shareWorldFile')?.addEventListener('click', () => sharePublic());
  document.querySelectorAll<HTMLButtonElement>('[data-public-download]').forEach(button => button.addEventListener('click', () => {
    claimPublicOffer(button.dataset.publicDownload!, 'download');
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-public-preview]').forEach(button => button.addEventListener('click', () => {
    const offer = state.publicOffers.get(button.dataset.publicPreview!);
    if (offer?.preview_data) showImagePreview(offer);
    else claimPublicOffer(button.dataset.publicPreview!, 'preview');
  }));
  document.querySelectorAll<HTMLImageElement>('[data-public-image]').forEach(image => image.addEventListener('click', () => {
    const offer = state.publicOffers.get(image.dataset.publicImage!);
    if (offer?.preview_data) showImagePreview(offer);
  }));
  document.querySelector('#disconnect')?.addEventListener('click', disconnect);
  document.querySelector('#optionalKnp')?.addEventListener('click', () => openKnpChatUi(state.nick));
  document.querySelector('#networkSettings')?.addEventListener('click', showNetworkModal);
  document.querySelector('#networkCard')?.addEventListener('click', showNetworkModal);
  document.querySelector('#refreshNetwork')?.addEventListener('click', async e => {
    e.stopPropagation();
    try { await invoke('refresh_discovery'); } catch (err) { addSystem(state.room, t('network.discoveryError', { error: String(err) })); }
  });
  const msg = document.querySelector<HTMLInputElement>('#msg')!;
  msg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendMessage(); });
  document.querySelector('#emojiToggle')?.addEventListener('click', () => {
    const panel = document.querySelector<HTMLDivElement>('#emojiPanel');
    if (panel) panel.hidden = !panel.hidden;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-emoji-code]').forEach(button => button.addEventListener('click', () => {
    const code = button.dataset.emojiCode ?? '';
    const start = msg.selectionStart ?? msg.value.length;
    const end = msg.selectionEnd ?? start;
    const before = msg.value.slice(0, start);
    const after = msg.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${code}${suffix}`;
    msg.value = `${before}${inserted}${after}`.slice(0, 4000);
    const caret = Math.min(before.length + inserted.length, msg.value.length);
    msg.focus();
    msg.setSelectionRange(caret, caret);
    const panel = document.querySelector<HTMLDivElement>('#emojiPanel');
    if (panel) panel.hidden = true;
  }));
  if (!document.querySelector('#knpChatOverlay:not([hidden])')) msg.focus();
  scrollBottom();
}

function networkLabel(): string {
  if (state.status.phase === 'online') return t('network.online');
  if (worldRelayState.connected > 0) return t('network.worldRelayOnline');
  if (state.status.phase === 'searching') return t('network.searching');
  return t('network.offline');
}

function internetEntryLabel(): string {
  if (publicDiscoveryOptIn && state.connected && worldRelayState.connected > 0) {
    return t('network.worldRelayConnected', { count: worldRelayState.connected });
  }
  if (publicDiscoveryOptIn && state.connected) return discoveryLabel();
  if (!state.status.bootstrap_count) return t('network.entryMissing');
  if (!state.status.bootstrap_connected) return t('network.entrySearching');
  return t('network.entryConnected', { count: state.status.bootstrap_connected });
}

function networkSubtitle(): string {
  const parts = [t('network.connectionsCount', { count: state.status.connected_peers }), `DHT ${state.status.dht_peers}`];
  parts.push(t('network.directCount', { count: state.status.routes.filter(r => r.path === 'direct').length }));
  parts.push(t('network.relayCount', { count: state.status.routes.filter(r => r.path === 'relay').length }));
  if (worldRelayState.total > 0) parts.push(t('network.worldRelayCount', { connected: worldRelayState.connected, total: worldRelayState.total }));
  if (state.status.nat && state.status.nat !== 'unknown') parts.push(`NAT ${state.status.nat}`);
  return parts.join(' · ');
}

function roomButton(room: RoomInfo): string {
  const mine = room.owner === state.peerId;
  const users = Math.max(0, Number(room.users) || 0);
  return `<button class="room ${state.room === room.id ? 'active' : ''}" data-room="${esc(room.id)}"><span>#</span> ${esc(room.title.replace(/^#\s*/, ''))}${mine ? `<em>${esc(t('common.host'))}</em>` : ''}<b>${users}</b></button>`;
}

function peerHtml(peer: PeerInfo): string {
  const initial = peer.nick[0]?.toUpperCase() ?? '?';
  const color = normalizeNickColor(peer.nick_color);
  const fileAction = peer.peer_id.startsWith('nostr:')
    ? `<button class="mini-file relay-file" data-send-relay-peer="${esc(peer.peer_id)}" title="${esc(t('transfer.sendEncryptedRelayFileTo', { nick: peer.nick }))}">📎</button>`
    : `<button class="mini-file" data-send-peer="${esc(peer.peer_id)}" title="${esc(t('transfer.sendFileTo', { nick: peer.nick }))}">📎</button>`;
  return `<div class="user" data-peer-id="${esc(peer.peer_id)}" data-peer-nick="${esc(peer.nick)}" data-peer-color="${esc(color)}"><div class="avatar" style="--nick-color:${color}">${esc(initial)}</div><div><strong style="color:${color}">${esc(peer.nick)}</strong><span>${shortPeer(peer.peer_id)}</span></div>${fileAction}</div>`;
}

function shortPeer(v: string): string { return v ? `${v.slice(0, 6)}…${v.slice(-4)}` : 'local'; }

function messageHtml(m: ChatMessage): string {
  if (m.kind === 'system') return `<div class="system-msg">${esc(m.text)}</div>`;
  if (m.kind === 'public_offer' && m.public_offer) return publicOfferHtml(m.public_offer);
  const mine = m.peer_id === state.peerId || m.nick === state.nick;
  const time = new Date(Number(m.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const color = mine ? state.nickColor : normalizeNickColor(m.nick_color);
  return `<article class="message ${mine ? 'mine' : ''}">
    <div class="avatar" style="--nick-color:${color}">${esc(m.nick[0]?.toUpperCase() ?? '?')}</div>
    <div class="bubble"><div class="meta"><strong style="color:${color}">${esc(m.nick)}</strong><time>${time}</time></div><p>${renderChatText(m.text)}</p></div>
  </article>`;
}

function publicOfferHtml(offer: PublicShareOffer): string {
  const mine = offer.peer_id === state.peerId;
  const color = mine ? state.nickColor : normalizeNickColor(offer.nick_color);
  const active = !offer.expired && Date.now() < Number(offer.expires_at);
  const dangerous = dangerousFile(offer.file_name);
  const image = offer.kind === 'image';
  const preview = image && offer.preview_data
    ? `<img class="public-image" data-public-image="${esc(offer.offer_id)}" src="${esc(offer.preview_data)}" alt="${esc(offer.file_name)}" />`
    : image
      ? `<div class="public-image-placeholder">🖼️<span>${esc(t('publicShare.previewHint'))}</span></div>`
      : '';
  const room = offer.room_id ? state.rooms.get(offer.room_id) : undefined;
  const scope = offer.room_id
    ? `<div class="public-scope">${room?.password_protected ? '🔒' : '#'} <strong>${esc(room?.title ?? offer.room_id)}</strong></div>`
    : '';
  const buttons = mine
    ? `<span class="public-own">${esc(offer.room_id ? t('roomShare.shared') : t('publicShare.shared'))}</span>`
    : active
      ? `<div class="public-actions">
          ${image ? `<button class="ghost" data-public-preview="${esc(offer.offer_id)}">${esc(t('publicShare.preview'))}</button>` : ''}
          <button class="primary compact" data-public-download="${esc(offer.offer_id)}">${esc(t('publicShare.download'))}</button>
        </div>`
      : `<span class="public-expired">${esc(t('publicShare.expired'))}</span>`;

  return `<article class="message public-message ${mine ? 'mine' : ''}">
    <div class="avatar" style="--nick-color:${color}">${esc(offer.nick[0]?.toUpperCase() ?? '?')}</div>
    <div class="bubble public-bubble">
      <div class="meta"><strong style="color:${color}">${esc(offer.nick)}</strong><time>${new Date(Number(offer.timestamp)).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</time></div>
      ${scope}
      ${preview}
      <div class="public-file-row">
        <span class="public-file-icon">${image ? '🖼️' : '📎'}</span>
        <div><strong>${esc(offer.file_name)}</strong><small>${formatBytes(offer.size)}${offer.mime ? ` · ${esc(offer.mime)}` : ''}</small></div>
      </div>
      ${dangerous ? `<div class="public-warning">${esc(t('publicShare.dangerous'))}</div>` : ''}
      ${buttons}
    </div>
  </article>`;
}

async function sharePublic(roomId: string | null = null) {
  if (!state.connected) return;
  if (roomId === null && state.room !== 'world') return;
  if (roomId !== null && (state.room === 'world' || state.room !== roomId)) return;
  try {
    const offer = await invoke<PublicShareOffer | null>('publish_public_file', { kind: 'file', roomId });
    if (!offer) return;
    offer.nick_color = normalizeNickColor(offer.nick_color);
    state.publicOffers.set(offer.offer_id, offer);
    let relayPublishError: unknown;
    if (publicDiscoveryOptIn
      && (offer.room_id === undefined || state.rooms.get(offer.room_id)?.password_protected !== true)) {
      try { worldRelay.publishPublicFile(offer); } catch (error) { relayPublishError = error; }
    }
    const messageRoom = offer.room_id ?? 'world';
    pushMessage({
      id: `public:${offer.offer_id}`,
      kind: 'public_offer',
      peer_id: offer.peer_id,
      nick: offer.nick,
      nick_color: offer.nick_color,
      room: messageRoom,
      text: '',
      timestamp: Number(offer.timestamp),
      public_offer: offer,
    });
    if (relayPublishError) {
      addSystem(messageRoom, t(roomId ? 'roomShare.error' : 'publicShare.error', { error: String(relayPublishError) }));
    }
  } catch (error) {
    alert(t(roomId ? 'roomShare.error' : 'publicShare.error', { error: String(error) }));
  }
}

async function claimPublicOffer(offerId: string, intent: 'download' | 'preview') {
  const offer = state.publicOffers.get(offerId);
  if (!offer || offer.expired || offer.expires_at <= Date.now() || offer.peer_id === state.peerId) return;
  if (state.publicIntents.has(offerId)) return;
  state.publicIntents.set(offerId, intent);

  const placeholderId = `claim:${offerId}`;
  state.transfers.set(placeholderId, {
    transfer_id: placeholderId,
    direction: 'incoming',
    peer_id: offer.peer_id,
    nick: offer.nick,
    public_offer_id: offerId,
    preview_only: intent === 'preview',
    file_name: offer.file_name,
    size: offer.size,
    transferred: 0,
    progress: 0,
    status: 'requesting',
  });
  if (state.connected) renderChat();

  try {
    if (offer.peer_id.startsWith('nostr:')) {
      const transferToken = crypto.randomUUID();
      publicTransferTokens.set(transferToken, { offerId, intent });
      worldRelay.publishRtcSignal(offer.peer_id, {
        connection_id: crypto.randomUUID(),
        action: 'public_file_request',
        offer_id: offerId,
        transfer_token: transferToken,
        preview_only: intent === 'preview',
      });
      const timer = window.setTimeout(() => {
        failPublicClaim(transferToken, t('publicShare.timeout'));
      }, PUBLIC_CLAIM_TIMEOUT_MS);
      publicClaimTimers.set(transferToken, timer);
    } else {
      await invoke('claim_public_file', { offerId, previewOnly: intent === 'preview' });
    }
  } catch (error) {
    for (const [token, pending] of publicTransferTokens) {
      if (pending.offerId === offerId) publicTransferTokens.delete(token);
    }
    state.publicIntents.delete(offerId);
    state.transfers.delete(placeholderId);
    if (state.connected) renderChat();
    alert(t('publicShare.error', { error: String(error) }));
  }
}

function clearPublicClaimTimer(transferToken: string): void {
  const timer = publicClaimTimers.get(transferToken);
  if (timer !== undefined) window.clearTimeout(timer);
  publicClaimTimers.delete(transferToken);
}

function failPublicClaim(transferToken: string, reason: string): void {
  clearPublicClaimTimer(transferToken);
  const pending = publicTransferTokens.get(transferToken);
  if (!pending) return;
  publicTransferTokens.delete(transferToken);
  state.publicIntents.delete(pending.offerId);
  state.transfers.delete(`claim:${pending.offerId}`);
  const offer = state.publicOffers.get(pending.offerId);
  addSystem('world', t('transfer.problem', {
    file: offer?.file_name ?? t('publicShare.file'),
    error: reason,
  }));
  if (state.connected) renderChat();
}

function showImagePreview(offer: PublicShareOffer) {
  if (!offer.preview_data) return;
  document.querySelector('#imagePreviewModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'imagePreviewModal';
  modal.className = 'modal-wrap image-preview-wrap';
  modal.innerHTML = `<div class="modal glass image-preview-modal">
    <div class="modal-head"><div><span class="eyebrow">#WORLD IMAGE</span><h3>${esc(offer.file_name)}</h3></div><button data-close>×</button></div>
    <img alt="${esc(offer.file_name)}" />
    <div class="image-preview-meta">${formatBytes(offer.size)} · ${esc(offer.nick)}</div>
  </div>`;
  const image = modal.querySelector<HTMLImageElement>('img')!;
  image.src = offer.preview_data;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.querySelector('[data-close]')?.addEventListener('click', close);
}

function activeTransfer(status: string): boolean {
  return ['requesting', 'waiting', 'sending', 'receiving', 'verifying'].includes(status);
}

function transferStatus(status: string): string {
  const keys = {
    requesting: 'transfer.requesting', waiting: 'transfer.waiting', sending: 'transfer.sending', receiving: 'transfer.receiving', verifying: 'transfer.verifying',
    completed: 'transfer.completed', rejected: 'transfer.rejected', failed: 'transfer.failed', cancelled: 'transfer.cancelled'
  } as const;
  const key = keys[status as keyof typeof keys];
  return key ? t(key) : status;
}

function transferHtml(tfr: FileTransfer): string {
  const pct = Math.max(0, Math.min(100, Number(tfr.progress) || 0));
  const icon = tfr.direction === 'outgoing' ? '↗' : '↙';
  const cancel = activeTransfer(tfr.status) ? `<button data-cancel-transfer="${esc(tfr.transfer_id)}" title="${esc(t('common.cancel'))}">×</button>` : '';
  const detail = tfr.error ? `<small class="transfer-error">${esc(tfr.error)}</small>` : tfr.path ? `<small title="${esc(tfr.path)}">${esc(tfr.path)}</small>` : `<small>${formatBytes(tfr.transferred)} / ${formatBytes(tfr.size)}</small>`;
  return `<div class="transfer-card ${esc(tfr.status)}">
    <div class="transfer-title"><span>${icon}</span><strong title="${esc(tfr.file_name)}">${esc(tfr.file_name)}</strong>${cancel}</div>
    <div class="transfer-meta"><span>${esc(tfr.nick)}</span><b>${esc(transferStatus(tfr.status))}</b></div>
    <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>${detail}
  </div>`;
}

async function sendMessage() {
  const input = document.querySelector<HTMLInputElement>('#msg');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    if (relayOnlyRoomIds.has(state.room)) {
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        kind: 'chat',
        peer_id: state.peerId,
        nick: state.nick,
        nick_color: state.nickColor,
        room: state.room,
        text,
        timestamp: Date.now(),
      };
      worldRelay.publishRoomChat(message);
      pushMessage(message);
      return;
    }
    await invoke('send_message', { room: state.room, text });
  } catch (e) {
    addSystem(state.room, t('chat.sendError', { error: String(e) }));
  }
}

async function createRoom() {
  if (!state.connected || roomChangePending) return;
  const raw = prompt(t('rooms.newPrompt'));
  if (!raw) return;
  const title = raw.trim().replace(/^#/, '').trim();
  if (!/^[\p{L}\p{N}_\- ]{3,32}$/u.test(title)) {
    alert(t('rooms.invalidName'));
    return;
  }
  const revision = sessionRevision;
  roomChangePending = true;
  try {
    const room = await invoke<RoomInfo>('create_room', { title });
    if (revision !== sessionRevision || !state.connected) return;
    state.rooms.set(room.id, { ...room, ...state.rooms.get(room.id) });
    if (!state.messages.has(room.id)) state.messages.set(room.id, []);
    groupVoice.leaveWorld();
    groupVoice.leaveRoom();
    state.room = room.id;
    renderChat();
  } catch (e) {
    if (revision === sessionRevision) alert(String(e));
  } finally {
    if (revision === sessionRevision) roomChangePending = false;
  }
}

async function switchRoom(room: string) {
  if (!state.connected || roomChangePending || !state.rooms.has(room)) return;
  const revision = sessionRevision;
  roomChangePending = true;
  try {
    if (!relayOnlyRoomIds.has(room)) await invoke('enter_room', { roomId: room });
    if (revision !== sessionRevision || !state.connected || !state.rooms.has(room)) return;
    if (state.room === 'world' && room !== 'world') groupVoice.leaveWorld();
    if (groupVoice.snapshot().roomActive && groupVoice.snapshot().roomScope !== room) groupVoice.leaveRoom();
    state.room = room;
    if (!state.messages.has(room)) state.messages.set(room, []);
    renderChat();
  } catch (error) {
    if (revision === sessionRevision) alert(String(error));
  } finally {
    if (revision === sessionRevision) roomChangePending = false;
  }
}

function offerFile() {
  if (state.peers.size === 0) {
    alert(t('transfer.noPeers'));
    return;
  }
  showRecipientModal();
}

function showRecipientModal() {
  document.querySelector('#recipientModal')?.remove();
  const peers = [...state.peers.values()].sort((a,b) => a.nick.localeCompare(b.nick));
  const modal = document.createElement('div');
  modal.id = 'recipientModal';
  modal.className = 'modal-wrap';
  const currentRoom = state.rooms.get(state.room);
  const roomContext = state.room !== 'world'
    ? `<div class="room-transfer-context">${currentRoom?.password_protected ? '🔒' : '#'} <strong>${esc(currentRoom?.title ?? state.room)}</strong></div>`
    : '';
  modal.innerHTML = `<div class="modal glass compact-modal">
    <div class="modal-head"><div><span class="eyebrow">P2P FILE TRANSFER</span><h3>${esc(t('transfer.sendFilePlain'))}</h3></div><button data-close>×</button></div>
    ${roomContext}
    <p class="modal-lead">${esc(t('transfer.recipientHelp'))}</p>
    <div class="recipient-list">${peers.map(p => `<button data-recipient="${esc(p.peer_id)}"><span class="avatar">${esc(p.nick[0]?.toUpperCase() ?? '?')}</span><span><strong>${esc(p.nick)}</strong><small>${esc(shortPeer(p.peer_id))}</small></span><b>${esc(t('transfer.sendArrow'))}</b></button>`).join('')}</div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('[data-close]')?.addEventListener('click', close);
  modal.querySelectorAll<HTMLElement>('[data-recipient]').forEach(el => el.addEventListener('click', async () => {
    const peer = el.dataset.recipient!;
    close();
    await sendFileToPeer(peer);
  }));
}

export async function sendFileToPeer(peerId: string) {
  const peer = state.peers.get(peerId);
  if (!peer) {
    alert(t('transfer.peerOffline'));
    return;
  }
  if (peerId.startsWith('nostr:')) {
    try {
      const offer = await peerTransport.sendFile(peerId);
      if (!offer) return;
      state.transfers.set(offer.token, {
        transfer_id: offer.token,
        direction: 'outgoing',
        peer_id: peerId,
        nick: peer.nick,
        file_name: offer.file_name,
        size: offer.size,
        transferred: 0,
        progress: 0,
        status: 'waiting',
      });
      addSystem(state.room, t('transfer.offerSent', { file: offer.file_name, nick: peer.nick }));
      renderChat();
    } catch (error) {
      alert(t('transfer.startError', { error: String(error) }));
    }
    return;
  }
  try {
    const transfer = await invoke<FileTransfer | null>('offer_file', {
      peerId,
      roomId: state.room === 'world' ? null : state.room,
    });
    if (transfer) {
      state.transfers.set(transfer.transfer_id, transfer);
      addSystem(state.room, t('transfer.offerSent', { file: transfer.file_name, nick: peer.nick }));
      renderChat();
    }
  } catch (e) {
    alert(t('transfer.startError', { error: String(e) }));
  }
}

async function cancelTransfer(transferId: string) {
  const transfer = state.transfers.get(transferId);
  if (directTransferIds.has(transferId)) {
    await peerTransport.cancelFile(transferId);
    return;
  }
  if (transfer?.peer_id.startsWith('nostr:')) {
    worldRelay.cancelFile(transferId);
    return;
  }
  try {
    await invoke('cancel_file', { transferId });
  } catch (e) {
    alert(String(e));
  }
}

function showFileOfferModal(offer: FileOffer) {
  const old = document.querySelector(`#file-offer-${CSS.escape(offer.transfer_id)}`);
  old?.remove();
  const modal = document.createElement('div');
  modal.id = `file-offer-${offer.transfer_id}`;
  modal.className = 'modal-wrap file-offer-wrap';
  const dangerous = dangerousFile(offer.file_name);
  const room = offer.room_id ? state.rooms.get(offer.room_id) : undefined;
  const roomContext = offer.room_id
    ? `<div class="offer-room-context">${room?.password_protected ? '🔒' : '#'} <strong>${esc(room?.title ?? offer.room_id)}</strong></div>`
    : '';
  modal.innerHTML = `<div class="modal glass file-offer-modal">
    <div class="offer-icon">📦</div>
    ${roomContext}
    <span class="eyebrow">${esc(t('transfer.incoming'))}</span>
    <h3>${esc(t('transfer.wantsToSend', { nick: offer.nick }))}</h3>
    <div class="offer-file"><strong>${esc(offer.file_name)}</strong><span>${formatBytes(offer.size)}</span></div>
    ${dangerous ? `<div class="danger-note">${esc(t('transfer.dangerous'))}</div>` : `<div class="safe-note">${esc(t('transfer.safe'))}</div>`}
    <div class="safe-note">${esc(t('transfer.offerExpiryNote'))}</div>
    <div class="offer-actions"><button id="rejectOffer" class="ghost">${esc(t('transfer.reject'))}</button><button id="acceptOffer" class="primary compact">${esc(t('transfer.accept'))}</button></div>
  </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#rejectOffer')?.addEventListener('click', async () => {
    try { await invoke('reject_file', { transferId: offer.transfer_id }); } catch {}
    close();
  });
  modal.querySelector('#acceptOffer')?.addEventListener('click', async () => {
    const btn = modal.querySelector<HTMLButtonElement>('#acceptOffer')!;
    btn.disabled = true;
    btn.textContent = t('transfer.preparing');
    try {
      const transfer = await invoke<FileTransfer>('accept_file', { transferId: offer.transfer_id });
      state.transfers.set(transfer.transfer_id, transfer);
      close();
      if (state.connected) renderChat();
    } catch (e) {
      alert(String(e));
      close();
    }
  });
}

function relayTransferView(progress: RelayFileProgress, path?: string): FileTransfer {
  const status = progress.status === 'transferring'
    ? (progress.direction === 'outgoing' ? 'sending' : 'receiving')
    : progress.status;
  return {
    transfer_id: progress.transfer_id,
    direction: progress.direction,
    peer_id: progress.peer_id,
    nick: progress.nick,
    file_name: progress.file_name,
    size: progress.size,
    transferred: progress.transferred,
    progress: progress.progress,
    status,
    path,
    error: progress.error,
  };
}

function updateRelayTransfer(progress: RelayFileProgress): void {
  const previous = state.transfers.get(progress.transfer_id);
  state.transfers.set(progress.transfer_id, relayTransferView(progress, previous?.path));
  if (progress.status === 'rejected' || progress.status === 'failed') {
    addSystem('world', t('transfer.problem', { file: progress.file_name, error: progress.error || transferStatus(progress.status) }));
  } else if (progress.status === 'completed') {
    addSystem('world', t('transfer.finished', { file: progress.file_name, saved: previous?.path ? t('transfer.saved', { path: previous.path }) : '' }));
  } else if (state.connected) {
    renderChat();
  }
}

function directTransferView(progress: DirectFileProgress): FileTransfer {
  const peer = state.peers.get(progress.peer_id);
  const publicTransfer = publicTransferTokens.get(progress.token);
  return {
    transfer_id: progress.token,
    direction: progress.direction,
    peer_id: progress.peer_id,
    nick: peer?.nick ?? progress.peer_id,
    public_offer_id: publicTransfer?.offerId,
    preview_only: publicTransfer?.intent === 'preview',
    file_name: progress.file_name,
    size: progress.size,
    transferred: progress.transferred,
    progress: progress.progress,
    status: progress.status === 'transferring'
      ? (progress.direction === 'outgoing' ? 'sending' : 'receiving')
      : progress.status,
    path: progress.path,
    error: progress.error,
  };
}

function updateDirectTransfer(progress: DirectFileProgress): void {
  directTransferIds.add(progress.token);
  const publicTransfer = publicTransferTokens.get(progress.token);
  if (publicTransfer) clearPublicClaimTimer(progress.token);
  if (publicTransfer) state.transfers.delete(`claim:${publicTransfer.offerId}`);
  state.transfers.set(progress.token, directTransferView(progress));
  if (progress.status === 'rejected' || progress.status === 'failed') {
    if (publicTransfer) {
      publicTransferTokens.delete(progress.token);
      state.publicIntents.delete(publicTransfer.offerId);
    }
    addSystem('world', t('transfer.problem', { file: progress.file_name, error: progress.error || transferStatus(progress.status) }));
  } else if (progress.status === 'completed') {
    const savedPath = progress.path && publicTransfer?.intent !== 'preview'
      ? t('transfer.saved', { path: progress.path })
      : '';
    addSystem('world', t('transfer.finished', { file: progress.file_name, saved: savedPath }));
    if (publicTransfer) void finishRelayPublicDownload(progress, publicTransfer);
  } else if (state.connected) renderChat();
}

async function finishRelayPublicDownload(
  progress: DirectFileProgress,
  pending: { offerId: string; intent: 'download' | 'preview' },
): Promise<void> {
  clearPublicClaimTimer(progress.token);
  publicTransferTokens.delete(progress.token);
  state.publicIntents.delete(pending.offerId);
  const offer = state.publicOffers.get(pending.offerId);
  if (offer?.kind === 'image' && progress.path) {
    try {
      offer.preview_data = await invoke<string>('load_image_preview', {
        path: progress.path,
        previewOnly: pending.intent === 'preview',
      });
      if (pending.intent === 'preview') showImagePreview(offer);
    } catch (error) {
      addSystem('world', t('publicShare.previewError', { error: String(error) }));
    }
  }
  if (state.connected) renderChat();
}

function showDirectFileOfferModal(offer: DirectFileOffer): void {
  document.querySelector(`#direct-file-offer-${CSS.escape(offer.token)}`)?.remove();
  const modal = document.createElement('div');
  modal.id = `direct-file-offer-${offer.token}`;
  modal.className = 'modal-wrap file-offer-wrap';
  const dangerous = dangerousFile(offer.file_name);
  const nick = state.peers.get(offer.peer_id)?.nick ?? offer.peer_id;
  modal.innerHTML = `<div class="modal glass file-offer-modal">
    <div class="offer-icon">⚡</div>
    <span class="eyebrow">DIRECT P2P · WEBRTC</span>
    <h3>${esc(t('transfer.wantsToSend', { nick }))}</h3>
    <div class="offer-file"><strong>${esc(offer.file_name)}</strong><span>${formatBytes(offer.size)}</span></div>
    ${dangerous ? `<div class="danger-note">${esc(t('transfer.dangerous'))}</div>` : `<div class="safe-note">${esc(t('transfer.safe'))}</div>`}
    <div class="safe-note">${esc(t('transfer.directHelp'))}</div>
    <div class="offer-actions"><button data-direct-reject class="ghost">${esc(t('transfer.reject'))}</button><button data-direct-accept class="primary compact">${esc(t('transfer.accept'))}</button></div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-direct-reject]')?.addEventListener('click', () => { void peerTransport.rejectFile(offer.token); close(); });
  modal.querySelector('[data-direct-accept]')?.addEventListener('click', () => {
    const button = modal.querySelector<HTMLButtonElement>('[data-direct-accept]');
    if (button) button.disabled = true;
    void peerTransport.acceptFile(offer.token).then(close).catch(error => { alert(String(error)); close(); });
  });
}

function showRelayFileOfferModal(offer: RelayFileOffer): void {
  document.querySelector(`#relay-file-offer-${CSS.escape(offer.transfer_id)}`)?.remove();
  const modal = document.createElement('div');
  modal.id = `relay-file-offer-${offer.transfer_id}`;
  modal.className = 'modal-wrap file-offer-wrap';
  const dangerous = dangerousFile(offer.file_name);
  modal.innerHTML = `<div class="modal glass file-offer-modal">
    <div class="offer-icon">🔐</div>
    <span class="eyebrow">${esc(t('transfer.encryptedRelay'))}</span>
    <h3>${esc(t('transfer.wantsToSend', { nick: offer.nick }))}</h3>
    <div class="offer-file"><strong>${esc(offer.file_name)}</strong><span>${formatBytes(offer.size)}</span></div>
    ${dangerous ? `<div class="danger-note">${esc(t('transfer.dangerous'))}</div>` : `<div class="safe-note">${esc(t('transfer.safe'))}</div>`}
    <div class="safe-note">${esc(t('transfer.encryptedRelayHelp'))}</div>
    <div class="offer-actions"><button data-relay-reject class="ghost">${esc(t('transfer.reject'))}</button><button data-relay-accept class="primary compact">${esc(t('transfer.accept'))}</button></div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-relay-reject]')?.addEventListener('click', () => {
    worldRelay.rejectFile(offer.transfer_id);
    close();
  });
  modal.querySelector('[data-relay-accept]')?.addEventListener('click', () => {
    try {
      worldRelay.acceptFile(offer.transfer_id);
      close();
    } catch (error) {
      alert(String(error));
      close();
    }
  });
}

async function saveRelayFile(file: RelayFileReady): Promise<void> {
  try {
    const path = await invoke<string>('save_relay_file', {
      fileName: file.file_name,
      size: file.size,
      sha256: file.sha256,
      dataBase64: file.data_base64,
    });
    const completed: RelayFileProgress = {
      ...file,
      direction: 'incoming',
      transferred: file.size,
      progress: 100,
      status: 'completed',
    };
    state.transfers.set(file.transfer_id, relayTransferView(completed, path));
    worldRelay.confirmFileSaved(file.transfer_id, file.peer_id);
    addSystem('world', t('transfer.finished', { file: file.file_name, saved: t('transfer.saved', { path }) }));
  } catch (error) {
    worldRelay.rejectFile(file.transfer_id, String(error));
    const failed: RelayFileProgress = {
      ...file,
      direction: 'incoming',
      transferred: 0,
      progress: 0,
      status: 'failed',
      error: String(error),
    };
    updateRelayTransfer(failed);
  }
}

function resetSessionView(errorMessage?: string) {
  groupVoice.stop();
  worldRelay.stop();
  peerTransport.stop();
  clearGroupAudio();
  worldRelayPeers.clear();
  relayOnlyRoomIds.clear();
  worldRelayState = { connected: 0, total: 0 };
  groupVoiceSnapshot = { world: [], canStartWorld: false, secondsLeft: 0, roomActive: false, roomPeers: 0 };
  closeKnpChatUi();
  sessionRevision += 1;
  connectPending = false;
  roomChangePending = false;
  document.querySelectorAll('.modal-wrap').forEach(el => el.remove());
  state.connected = false;
  state.nick = '';
  state.nickColor = normalizeNickColor(localStorage.getItem('konofix.nickColor'));
  state.peerId = '';
  state.peers.clear();
  state.rooms = new Map([['world', { id: 'world', title: '# WORLD' }]]);
  state.messages = new Map([['world', []]]);
  state.transfers.clear();
  directTransferIds.clear();
  state.publicOffers.clear();
  state.publicIntents.clear();
  publicTransferTokens.clear();
  for (const timer of publicClaimTimers.values()) window.clearTimeout(timer);
  publicClaimTimers.clear();
  state.status = { ...EMPTY_STATUS };
  discoveryStatus = { phase: 'off', relay_enabled: false, public_reachability: false };
  publicDiscoveryOptIn = true;
  relayConsent = true;
  state.room = 'world';
  renderLogin();
  if (errorMessage) {
    const error = document.querySelector<HTMLDivElement>('#loginError');
    if (error) error.textContent = errorMessage;
  }
}

async function disconnect() {
  try { await invoke('disconnect_network'); } catch {}
  resetSessionView();
}

function pushMessage(m: ChatMessage) {
  if (!state.messages.has(m.room)) state.messages.set(m.room, []);
  const list = state.messages.get(m.room)!;
  if (!list.some(x => x.id === m.id)) list.push(m);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  if (m.room === state.room && state.connected) renderChat();
}

function receivePublicOffer(offer: PublicShareOffer): void {
  const existing = state.publicOffers.get(offer.offer_id);
  let stored = offer;
  if (existing) {
    existing.expires_at = Math.max(existing.expires_at, offer.expires_at);
    existing.expired = false;
    stored = existing;
  } else {
    offer.nick_color = normalizeNickColor(offer.nick_color);
    state.publicOffers.set(offer.offer_id, offer);
  }
  pushMessage({
    id: `public:${stored.offer_id}`,
    kind: 'public_offer',
    peer_id: stored.peer_id,
    nick: stored.nick,
    nick_color: stored.nick_color,
    room: stored.room_id ?? 'world',
    text: '',
    timestamp: Number(stored.timestamp),
    public_offer: stored,
  });
}

function addSystem(room: string, text: string) {
  pushMessage({ id: crypto.randomUUID(), kind: 'system', nick: 'SYSTEM', room, text, timestamp: Date.now() });
}

function startWorldRelay() {
  peerTransport.start({
    sendSignal(peerId: string, signal: RtcSignal) {
      try { worldRelay.publishRtcSignal(peerId, signal); } catch {}
    },
    beforeMicrophoneCapture() {
      groupVoice.leaveWorld();
      groupVoice.leaveRoom();
    },
    onIncomingCall(peerId: string, connectionId: string) {
      window.dispatchEvent(new CustomEvent('konofix-incoming-audio-call', { detail: { peerId, connectionId } }));
    },
    onCallState(peerId, callState, error) {
      window.dispatchEvent(new CustomEvent('konofix-audio-call-state', { detail: { peerId, state: callState, error } }));
    },
    onRemoteAudio(peerId, stream) {
      window.dispatchEvent(new CustomEvent('konofix-remote-audio', { detail: { peerId, stream } }));
    },
    onFileOffer(offer) {
      const pending = publicTransferTokens.get(offer.token);
      if (!pending) {
        showDirectFileOfferModal(offer);
        return;
      }
      clearPublicClaimTimer(offer.token);
      const announced = state.publicOffers.get(pending.offerId);
      if (!announced
        || announced.peer_id !== offer.peer_id
        || announced.file_name !== offer.file_name
        || announced.size !== offer.size
        || announced.sha256.toLowerCase() !== offer.sha256.toLowerCase()) {
        void peerTransport.rejectFile(offer.token, 'Public file metadata did not match the signed announcement.');
        failPublicClaim(offer.token, t('publicShare.metadataMismatch'));
        return;
      }
      void peerTransport.acceptFile(offer.token, pending.intent === 'preview').catch(error => {
        failPublicClaim(offer.token, String(error));
      });
    },
    onFileProgress(progress) { updateDirectTransfer(progress); },
  });
  worldRelay.start(state.peerId, state.nick, state.nickColor, {
    onPresence(peer: RelayPeer) {
      worldRelayPeers.set(peer.peer_id, peer);
      // Relay media/signalling uses the virtual Nostr peer id even when the
      // same person is already visible through the native transport. Keep the
      // duplicate out of the people list, but never skip the relay-online
      // notification or active WORLD/room audio can miss this listener.
      window.dispatchEvent(new CustomEvent('konofix-relay-peer-online', { detail: { peer_id: peer.peer_id } }));
      groupVoice.peerOnline(peer.peer_id);
      if (state.peers.has(peer.claimed_peer_id)) {
        state.peers.delete(peer.peer_id);
        return;
      }
      state.peers.set(peer.peer_id, {
        peer_id: peer.peer_id,
        nick: peer.nick,
        nick_color: peer.nick_color,
      });
      if (state.connected) renderChat();
    },
    onOffline(peerId: string) {
      worldRelayPeers.delete(peerId);
      state.peers.delete(peerId);
      window.dispatchEvent(new CustomEvent('konofix-relay-peer-offline', { detail: { peer_id: peerId } }));
      groupVoice.peerOffline(peerId);
      if (state.connected) renderChat();
    },
    onChat(message: ChatMessage) {
      pushMessage(message);
    },
    onRoom(room: RelayRoomInfo) {
      if (state.rooms.has(room.id) && !relayOnlyRoomIds.has(room.id)) return;
      relayOnlyRoomIds.add(room.id);
      state.rooms.set(room.id, room);
      if (!state.messages.has(room.id)) state.messages.set(room.id, []);
      if (state.connected) renderChat();
    },
    onRoomClosed(roomId: string) {
      if (!relayOnlyRoomIds.delete(roomId)) return;
      state.rooms.delete(roomId);
      if (state.room === roomId) {
        state.room = 'world';
        addSystem('world', t('rooms.closed'));
      } else if (state.connected) renderChat();
    },
    onState(next: RelayState) {
      const changed = next.connected !== worldRelayState.connected || next.total !== worldRelayState.total;
      worldRelayState = next;
      if (changed && state.connected) renderChat();
    },
    onPrivate(message: RelayPrivateMessage) {
      window.dispatchEvent(new CustomEvent<RelayPrivateMessage>('konofix-relay-private-message', { detail: message }));
    },
    onFileOffer(offer: RelayFileOffer) {
      showRelayFileOfferModal(offer);
    },
    onFileProgress(progress: RelayFileProgress) {
      updateRelayTransfer(progress);
    },
    onFileReady(file: RelayFileReady) {
      void saveRelayFile(file);
    },
    onPublicFile(offer: RelayPublicFileOffer) {
      receivePublicOffer(offer);
    },
    onRtcSignal(peerId: string, signal: RtcSignal) {
      if (signal.action === 'public_file_request') {
        const announced = signal.offer_id ? state.publicOffers.get(signal.offer_id) : undefined;
        if (!announced
          || announced.peer_id !== state.peerId
          || announced.expires_at <= Date.now()
          || !signal.transfer_token) return;
        void invoke<RtcFileDescriptor>('prepare_public_rtc_file', {
          offerId: announced.offer_id,
          transferToken: signal.transfer_token,
        }).then(descriptor => peerTransport.sendPreparedFile(peerId, descriptor)).catch(error => {
          try {
            worldRelay.publishRtcSignal(peerId, {
              connection_id: crypto.randomUUID(),
              action: 'public_file_reject',
              offer_id: announced.offer_id,
              transfer_token: signal.transfer_token,
              reason: String(error).slice(0, 300) || 'The sender could not prepare the file.',
            });
          } catch {}
        });
        return;
      }
      if (signal.action === 'public_file_reject' && signal.transfer_token) {
        const pending = publicTransferTokens.get(signal.transfer_token);
        if (pending && pending.offerId === signal.offer_id) {
          failPublicClaim(signal.transfer_token, signal.reason || t('publicShare.senderUnavailable'));
        }
        return;
      }
      void peerTransport.handleSignal(peerId, signal).catch(error => {
        window.dispatchEvent(new CustomEvent('konofix-audio-call-state', { detail: { peerId, state: 'failed', error: String(error) } }));
      });
    },
    onWorldVoice(voiceState: WorldVoiceState) {
      groupVoice.updateWorldState(voiceState);
    },
    onVoiceSignal(peerId: string, signal: VoiceSignal) {
      void groupVoice.handleSignal(peerId, signal).catch(error => groupVoice.reportSignalError(error));
    },
  });
  groupVoice.start(worldRelay.virtualPeerId(), state.nick, state.nickColor, {
    sendSignal(peerId, signal) { worldRelay.publishVoiceSignal(peerId, signal); },
    publishWorld(voiceState) { worldRelay.publishWorldVoice(voiceState); },
    peers() { return [...worldRelayPeers.keys()]; },
    beforeMicrophoneCapture() { peerTransport.hangupAllCalls(); },
    onRemoteStream(scope, peerId, stream) { playGroupAudio(scope, peerId, stream); },
    onState(snapshot) {
      groupVoiceSnapshot = snapshot;
      updateVoicePanel();
    },
  });
}

function restoreRelayPresenceFor(nativePeerId: string) {
  for (const peer of worldRelayPeers.values()) {
    if (peer.claimed_peer_id !== nativePeerId) continue;
    state.peers.set(peer.peer_id, {
      peer_id: peer.peer_id,
      nick: peer.nick,
      nick_color: peer.nick_color,
    });
  }
}

function scrollBottom() {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLDivElement>('#messages');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function showNetworkModal() {
  document.querySelector('#networkModal')?.remove();
  const bootstraps = loadBootstraps();
  const modal = document.createElement('div');
  modal.id = 'networkModal';
  modal.className = 'modal-wrap';
  modal.innerHTML = `
    <div class="modal glass">
      <div class="modal-head"><div><span class="eyebrow">P2P NETWORK</span><h3>${esc(t('network.status'))}</h3></div><button id="closeModal">×</button></div>
      <div class="stats-grid">
        <div><span>${esc(t('network.connections'))}</span><strong>${state.status.connected_peers}</strong></div>
        <div><span>${esc(t('network.dhtPeers'))}</span><strong>${state.status.dht_peers}</strong></div>
        <div><span>${esc(t('network.bootstraps'))}</span><strong>${state.status.bootstrap_count || bootstraps.length}</strong></div>
        <div><span>${esc(t('network.directRoutes'))}</span><strong>${state.status.routes.filter(r => r.path === 'direct').length}</strong></div>
        <div><span>${esc(t('network.relayRoutes'))}</span><strong>${state.status.routes.filter(r => r.path === 'relay').length}</strong></div>
        <div><span>${esc(t('network.relayReservations'))}</span><strong>${state.status.listen_addresses.filter(a => a.includes('/p2p-circuit')).length}</strong></div>
        <div><span>${esc(t('network.worldRelays'))}</span><strong>${worldRelayState.connected}/${worldRelayState.total}</strong></div>
        <div><span>NAT</span><strong>${esc(state.status.nat)}</strong></div>
      </div>
      <div class="listen-block" id="observedRoutes"><span>${esc(t('network.observedRoutes'))}</span>${state.status.routes.map(r => `<div data-route-peer="${esc(r.peer_id)}" data-route-path="${r.path}"><code>${esc(r.peer_id)} · ${esc(r.path)} / ${esc(r.transport)} · ${esc(r.remote_address)}</code></div>`).join('')}</div>
      <p class="modal-note">${esc(t('network.routeHelp'))}</p>
      <p class="modal-note" id="internetEntryDetail"><strong>${esc(internetEntryLabel())}</strong><br/>${esc(t('network.entryHelp'))}</p>
      <p class="modal-note" id="publicDiscoveryStatus"><strong>${esc(discoveryLabel())}</strong><br/>${esc(discoveryStatus.relay_enabled ? t('network.relayActive') : t('network.relayInactive'))}</p>
      <p class="modal-note">${esc(t('network.coldProofLimit'))}</p>
      <p class="modal-note">${esc(t('network.participantNode'))}</p>
      <section class="audio-settings-card">
        <strong>${esc(t('audio.settingsTitle'))}</strong>
        <label><input id="muteWorldAudio" type="checkbox" ${worldAudioMuted ? 'checked' : ''}/> ${esc(t('audio.muteWorld'))}</label>
        <small>${esc(t('audio.muteWorldHelp'))}</small>
        <div class="audio-test-actions">
          <button id="testSpeakers" class="ghost">${esc(t('audio.testSpeakers'))}</button>
          <button id="testMicrophone" class="ghost">${esc(t('audio.testMicrophone'))}</button>
        </div>
        <div class="audio-test-meter" aria-hidden="true"><i id="microphoneLevel"></i></div>
        <p id="audioTestStatus" class="modal-note">${esc(t('audio.testReady'))}</p>
      </section>
      <section class="audio-settings-card">
        <strong>${esc(t('update.title'))}</strong>
        <small>${esc(t('update.help'))}</small>
        <div class="audio-test-actions"><button id="checkUpdates" class="ghost">${esc(t('update.checkNow'))}</button></div>
        <p id="updateStatus" class="modal-note">${esc(t('update.ready'))}</p>
      </section>
      <label>${esc(t('network.bootstrapAddress'))}</label>
      <div class="inline-form"><input id="bootstrapInput" placeholder="/ip4/.../tcp/.../p2p/12D3KooW..."/><button id="addBootstrap" class="primary compact">${esc(t('common.add'))}</button></div>
      <div class="bootstrap-list">${bootstraps.length ? bootstraps.map(b => `<div><code>${esc(b)}</code><button data-remove-bootstrap="${esc(b)}">×</button></div>`).join('') : `<p>${esc(t('network.noBootstraps'))}</p>`}</div>
      <div class="listen-block"><span>${esc(t('network.listenAddresses'))}</span>${state.status.listen_addresses.length ? state.status.listen_addresses.map(a => `<div><code>${esc(a)}</code><button class="ghost" data-copy-address="${esc(a)}">${esc(t('network.copyAddress'))}</button></div>`).join('') : `<small>${esc(t('network.listenPending'))}</small>`}</div>
      <p class="modal-note">${esc(t('network.bootstrapNote'))}</p>
    </div>`;
  document.body.appendChild(modal);

  const audioTestAbort = new AbortController();
  const close = () => {
    audioTestAbort.abort();
    modal.remove();
  };
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#closeModal')?.addEventListener('click', close);
  modal.querySelector<HTMLInputElement>('#muteWorldAudio')?.addEventListener('change', event => {
    worldAudioMuted = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem(WORLD_AUDIO_MUTED_KEY, String(worldAudioMuted));
    for (const [key, audio] of groupAudio) {
      if (key.startsWith('world\u0000')) audio.muted = worldAudioMuted;
      if (worldAudioMuted && key.startsWith('world\u0000')) blockedGroupAudio.delete(key);
    }
    if (!worldAudioMuted) {
      for (const key of groupAudio.keys()) {
        if (key.startsWith('world\u0000')) blockedGroupAudio.add(key);
      }
      resumeGroupAudio();
    }
  });
  const audioStatus = modal.querySelector<HTMLElement>('#audioTestStatus')!;
  const microphoneLevel = modal.querySelector<HTMLElement>('#microphoneLevel')!;
  modal.querySelector<HTMLButtonElement>('#testSpeakers')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    audioStatus.textContent = t('audio.testingSpeakers');
    try {
      await testSpeakers(audioTestAbort.signal);
      audioStatus.textContent = t('audio.speakersOk');
    } catch (error) {
      if (!audioTestAbort.signal.aborted) audioStatus.textContent = t('audio.testFailed', { error: String(error) });
    } finally {
      button.disabled = false;
    }
  });
  modal.querySelector<HTMLButtonElement>('#testMicrophone')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    audioStatus.textContent = t('audio.testingMicrophone');
    try {
      const peak = await testMicrophone(level => {
        microphoneLevel.style.width = `${Math.round(level * 100)}%`;
      }, audioTestAbort.signal);
      audioStatus.textContent = peak >= 0.025 ? t('audio.microphoneOk') : t('audio.microphoneSilent');
    } catch (error) {
      if (!audioTestAbort.signal.aborted) audioStatus.textContent = t('audio.testFailed', { error: String(error) });
    } finally {
      button.disabled = false;
    }
  });
  modal.querySelector('#checkUpdates')?.addEventListener('click', () => void runStableUpdateCheck(true));
  modal.querySelectorAll<HTMLButtonElement>('[data-copy-address]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copyAddress!);
      btn.textContent = t('network.addressCopied');
    } catch {
      alert(t('network.copyAddressHelp'));
    }
  }));
  modal.querySelector('#addBootstrap')?.addEventListener('click', async () => {
    const input = modal.querySelector<HTMLInputElement>('#bootstrapInput')!;
    const address = input.value.trim();
    if (!address) return;
    const next = [...loadBootstraps(), address];
    if (state.connected) {
      try { await invoke('add_bootstrap', { address }); }
      catch (e) { alert(String(e)); return; }
    }
    saveBootstraps(next);
    close();
    showNetworkModal();
  });
  modal.querySelectorAll<HTMLButtonElement>('[data-remove-bootstrap]').forEach(btn => btn.addEventListener('click', () => {
    saveBootstraps(loadBootstraps().filter(v => v !== btn.dataset.removeBootstrap));
    close();
    showNetworkModal();
  }));
}

async function wireEvents() {
  await listen<ChatMessage>('chat-message', event => {
    pushMessage(event.payload);
    if (event.payload.peer_id === state.peerId && event.payload.kind === 'chat') {
      if (event.payload.room === 'world') worldRelay.publishChat(event.payload);
      else if (state.rooms.get(event.payload.room)?.password_protected !== true) {
        worldRelay.publishRoomChat(event.payload);
      }
    }
  });
  await listen<PeerInfo>('peer-online', event => {
    for (const peer of worldRelayPeers.values()) {
      if (peer.claimed_peer_id === event.payload.peer_id) state.peers.delete(peer.peer_id);
    }
    state.peers.set(event.payload.peer_id, event.payload);
    if (state.connected) renderChat();
  });
  await listen<{ peer_id: string }>('peer-offline', event => {
    state.peers.delete(event.payload.peer_id);
    restoreRelayPresenceFor(event.payload.peer_id);
    if (state.connected) renderChat();
  });
  await listen<RoomInfo>('room-created', event => {
    relayOnlyRoomIds.delete(event.payload.id);
    state.rooms.set(event.payload.id, event.payload);
    if (!state.messages.has(event.payload.id)) state.messages.set(event.payload.id, []);
    if (event.payload.owner === state.peerId && event.payload.password_protected !== true) {
      try { worldRelay.publishRoom(event.payload); } catch {}
    }
    if (state.connected) renderChat();
  });
  await listen<RoomInfo>('room-security-updated', event => {
    relayOnlyRoomIds.delete(event.payload.id);
    state.rooms.set(event.payload.id, event.payload);
    if (event.payload.owner === state.peerId) {
      if (event.payload.password_protected) worldRelay.closeRoom(event.payload.id);
      else {
        try { worldRelay.publishRoom(event.payload); } catch {}
      }
    }
    if (state.connected) renderChat();
  });
  await listen<{ room_id: string }>('room-closed', event => {
    if (event.payload.room_id === 'world') return;
    relayOnlyRoomIds.delete(event.payload.room_id);
    worldRelay.closeRoom(event.payload.room_id);
    state.rooms.delete(event.payload.room_id);
    if (state.room === event.payload.room_id) {
      state.room = 'world';
      addSystem('world', t('rooms.closed'));
    } else if (state.connected) renderChat();
  });
  await listen<RoomUserCountUpdate>('room-user-count', event => {
    if (event.payload.room_id === 'world') return;
    const room = state.rooms.get(event.payload.room_id);
    if (!room) return;
    const users = Math.max(0, Number(event.payload.users) || 0);
    state.rooms.set(event.payload.room_id, { ...room, users });
    if (state.connected) renderChat();
  });
  await listen<typeof discoveryStatus & { peer_id: string }>('network-discovery', event => {
    if (state.connected && event.payload.peer_id === state.peerId) {
      discoveryStatus = event.payload;
      renderChat();
    }
  });
  await listen<NetworkStatus>('network-status', event => {
    state.status = event.payload;
    if (state.connected) renderChat();
  });
  await listen<string>('network-warning', event => {
    if (state.connected) addSystem('world', `⚠ ${event.payload}`);
  });
  await listen<string>('network-error', async event => {
    if (!state.connected && !connectPending) return;
    const message = t('network.error', { error: event.payload });
    try { await invoke('disconnect_network'); } catch {}
    resetSessionView(message);
  });
  await listen<{ nick: string }>('nick-conflict', async event => {
    const message = t('nick.conflict', { nick: event.payload.nick });
    try { await invoke('disconnect_network'); } catch {}
    resetSessionView(message);
  });
  await listen<PublicShareOffer>('public-file-offer', event => {
    receivePublicOffer(event.payload);
  });
  await listen<{ offer_id: string }>('public-offer-expired', event => {
    const offer = state.publicOffers.get(event.payload.offer_id);
    if (!offer) return;
    offer.expired = true;
    state.publicIntents.delete(event.payload.offer_id);
    state.transfers.delete(`claim:${event.payload.offer_id}`);
    if (state.connected && state.room === (offer.room_id ?? 'world')) renderChat();
  });
  await listen<{ offer_id: string; error: string }>('public-offer-error', event => {
    state.publicIntents.delete(event.payload.offer_id);
    state.transfers.delete(`claim:${event.payload.offer_id}`);
    if (state.connected) {
      renderChat();
      addSystem('world', t('publicShare.error', { error: event.payload.error }));
    }
  });
  await listen<FileOffer>('file-offer', event => showFileOfferModal(event.payload));
  await listen<FileOfferExpired>('file-offer-expired', event => {
    const modal = document.querySelector(`#file-offer-${CSS.escape(event.payload.transfer_id)}`);
    if (!modal) return;
    modal.remove();
    if (state.connected) addSystem(state.room, t('transfer.offerExpired'));
  });
  await listen<FileOfferCancelled>('file-offer-cancelled', event => {
    const modal = document.querySelector(`#file-offer-${CSS.escape(event.payload.transfer_id)}`);
    if (!modal) return;
    modal.remove();
    if (state.connected) addSystem(state.room, t('transfer.offerCancelled'));
  });
  await listen<FileTransfer>('file-transfer', async event => {
    if (event.payload.public_offer_id) state.transfers.delete(`claim:${event.payload.public_offer_id}`);
    state.transfers.set(event.payload.transfer_id, event.payload);
    if (event.payload.status === 'completed') {
      const saved = event.payload.direction === 'incoming' && !event.payload.preview_only
        ? t('transfer.saved', { path: event.payload.path || 'Downloads\\Konofix Chat' })
        : '';
      addSystem(state.room, t('transfer.finished', { file: event.payload.file_name, saved }));
      const offerId = event.payload.public_offer_id;
      if (offerId && event.payload.direction === 'incoming') {
        const offer = state.publicOffers.get(offerId);
        const intent = state.publicIntents.get(offerId);
        state.publicIntents.delete(offerId);
        if (offer?.kind === 'image' && event.payload.path) {
          try {
            offer.preview_data = await invoke<string>('load_image_preview', {
              path: event.payload.path,
              previewOnly: Boolean(event.payload.preview_only),
            });
            if (state.connected && state.room === (offer.room_id ?? 'world')) renderChat();
            if (intent === 'preview') showImagePreview(offer);
          } catch (error) {
            addSystem('world', t('publicShare.previewError', { error: String(error) }));
          }
        }
      }
    } else if (['failed', 'rejected'].includes(event.payload.status)) {
      if (event.payload.public_offer_id) state.publicIntents.delete(event.payload.public_offer_id);
      addSystem(state.room, t('transfer.problem', { file: event.payload.file_name, error: event.payload.error || transferStatus(event.payload.status) }));
    } else if (event.payload.status === 'cancelled' && event.payload.public_offer_id) {
      state.publicIntents.delete(event.payload.public_offer_id);
      if (state.connected) renderChat();
    } else if (state.connected) {
      renderChat();
    }
  });
}

wireEvents();
renderLogin();
window.setTimeout(() => void runStableUpdateCheck(false), 2_500);
