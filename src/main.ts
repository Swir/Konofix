import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n';
import { DEFAULT_NICK_COLOR, KONOFIX_EMOJI, NICK_COLORS, normalizeNickColor, renderChatText } from './chat-expression';
import './style.css';

type PublicShareOffer = {
  offer_id: string;
  peer_id: string;
  nick: string;
  nick_color?: string;
  file_name: string;
  size: number;
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
  dht_peers: number;
  bootstrap_count: number;
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
  phase: 'offline', connected_peers: 0, dht_peers: 0, bootstrap_count: 0,
  nat: 'unknown', listen_addresses: [], detail: 'Disconnected'
};

const state = {
  nick: '',
  nickColor: normalizeNickColor(localStorage.getItem('konofix.nickColor')),
  peerId: '',
  version: '0.4.3',
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

function renderLogin() {
  app.innerHTML = `
    <main class="login-shell" aria-label="Konofix core ready">
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
  document.querySelector('#connectBtn')?.addEventListener('click', connect);
  document.querySelector('#loginNetwork')?.addEventListener('click', showNetworkModal);
  document.documentElement.dataset.konofixCoreReady = 'true';
  window.dispatchEvent(new Event('konofix-core-ready'));
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
    });
    if (revision !== sessionRevision) return;
    connectPending = false;
    state.nick = result.nick;
    state.nickColor = normalizeNickColor(result.nick_color);
    localStorage.setItem('konofix.nickColor', state.nickColor);
    state.peerId = result.peer_id;
    state.version = result.version;
    state.connected = true;
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
  const networkClass = state.status.phase === 'online' ? 'good' : state.status.phase === 'searching' ? 'searching' : 'off';
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

        <div class="network-card" id="networkCard">
          <div class="network-top"><span class="net-dot ${networkClass}"></span><strong>${esc(networkLabel())}</strong><button id="refreshNetwork" title="${esc(t('network.refresh'))}">↻</button></div>
          <small>${esc(networkSubtitle())}</small>
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
              <button id="shareWorldImage" class="ghost image-share">${esc(t('publicShare.image'))}</button>
            ` : `<button id="shareRoomFile" class="ghost">${esc(t('transfer.sendFile'))}</button>`}
          </div>
        </header>

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
  document.querySelectorAll<HTMLElement>('[data-room]').forEach(el => el.addEventListener('click', () => switchRoom(el.dataset.room!)));
  document.querySelectorAll<HTMLElement>('[data-send-peer]').forEach(el => el.addEventListener('click', () => sendFileToPeer(el.dataset.sendPeer!)));
  document.querySelectorAll<HTMLElement>('[data-cancel-transfer]').forEach(el => el.addEventListener('click', () => cancelTransfer(el.dataset.cancelTransfer!)));
  document.querySelector('#newRoom')?.addEventListener('click', createRoom);
  document.querySelector('#send')?.addEventListener('click', sendMessage);
  document.querySelector('#shareRoomFile')?.addEventListener('click', () => sharePublic('file', state.room));
  document.querySelector('#shareWorldFile')?.addEventListener('click', () => sharePublic('file'));
  document.querySelector('#shareWorldImage')?.addEventListener('click', () => sharePublic('image'));
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
  msg.focus();
  scrollBottom();
}

function networkLabel(): string {
  if (state.status.phase === 'online') return t('network.online');
  if (state.status.phase === 'searching') return t('network.searching');
  return t('network.offline');
}

function networkSubtitle(): string {
  const parts = [t('network.connectionsCount', { count: state.status.connected_peers }), `DHT ${state.status.dht_peers}`];
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
  return `<div class="user"><div class="avatar" style="--nick-color:${color}">${esc(initial)}</div><div><strong style="color:${color}">${esc(peer.nick)}</strong><span>${shortPeer(peer.peer_id)}</span></div><button class="mini-file" data-send-peer="${esc(peer.peer_id)}" title="${esc(t('transfer.sendFileTo', { nick: peer.nick }))}">📎</button></div>`;
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

async function sharePublic(kind: 'file' | 'image', roomId: string | null = null) {
  if (!state.connected) return;
  if (roomId === null && state.room !== 'world') return;
  if (roomId !== null && (state.room === 'world' || state.room !== roomId)) return;
  try {
    const offer = await invoke<PublicShareOffer | null>('publish_public_file', { kind, roomId });
    if (!offer) return;
    offer.nick_color = normalizeNickColor(offer.nick_color);
    state.publicOffers.set(offer.offer_id, offer);
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
  } catch (error) {
    alert(t(roomId ? 'roomShare.error' : 'publicShare.error', { error: String(error) }));
  }
}

async function claimPublicOffer(offerId: string, intent: 'download' | 'preview') {
  const offer = state.publicOffers.get(offerId);
  if (!offer || offer.expired || offer.peer_id === state.peerId) return;
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
    await invoke('claim_public_file', { offerId, previewOnly: intent === 'preview' });
  } catch (error) {
    state.publicIntents.delete(offerId);
    state.transfers.delete(placeholderId);
    if (state.connected) renderChat();
    alert(t('publicShare.error', { error: String(error) }));
  }
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
    await invoke('enter_room', { roomId: room });
    if (revision !== sessionRevision || !state.connected || !state.rooms.has(room)) return;
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
  if (!state.peers.size) {
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

async function sendFileToPeer(peerId: string) {
  const peer = state.peers.get(peerId);
  if (!peer) {
    alert(t('transfer.peerOffline'));
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

function resetSessionView(errorMessage?: string) {
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
  state.publicOffers.clear();
  state.publicIntents.clear();
  state.status = { ...EMPTY_STATUS };
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

function addSystem(room: string, text: string) {
  pushMessage({ id: crypto.randomUUID(), kind: 'system', nick: 'SYSTEM', room, text, timestamp: Date.now() });
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
        <div><span>Relay</span><strong>${state.status.listen_addresses.filter(a => a.includes('/p2p-circuit')).length ? esc(t('common.active')) : esc(t('common.auto'))}</strong></div>
        <div><span>NAT</span><strong>${esc(state.status.nat)}</strong></div>
      </div>
      <p class="modal-note">${esc(t('network.participantNode'))}</p>
      <label>${esc(t('network.bootstrapAddress'))}</label>
      <div class="inline-form"><input id="bootstrapInput" placeholder="/ip4/.../tcp/.../p2p/12D3KooW..."/><button id="addBootstrap" class="primary compact">${esc(t('common.add'))}</button></div>
      <div class="bootstrap-list">${bootstraps.length ? bootstraps.map(b => `<div><code>${esc(b)}</code><button data-remove-bootstrap="${esc(b)}">×</button></div>`).join('') : `<p>${esc(t('network.noBootstraps'))}</p>`}</div>
      <div class="listen-block"><span>${esc(t('network.listenAddresses'))}</span>${state.status.listen_addresses.length ? state.status.listen_addresses.map(a => `<div><code>${esc(a)}</code><button class="ghost" data-copy-address="${esc(a)}">${esc(t('network.copyAddress'))}</button></div>`).join('') : `<small>${esc(t('network.listenPending'))}</small>`}</div>
      <p class="modal-note">${esc(t('network.bootstrapNote'))}</p>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#closeModal')?.addEventListener('click', close);
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
  await listen<ChatMessage>('chat-message', event => pushMessage(event.payload));
  await listen<PeerInfo>('peer-online', event => {
    state.peers.set(event.payload.peer_id, event.payload);
    if (state.connected) renderChat();
  });
  await listen<{ peer_id: string }>('peer-offline', event => {
    state.peers.delete(event.payload.peer_id);
    if (state.connected) renderChat();
  });
  await listen<RoomInfo>('room-created', event => {
    state.rooms.set(event.payload.id, event.payload);
    if (!state.messages.has(event.payload.id)) state.messages.set(event.payload.id, []);
    if (state.connected) renderChat();
  });
  await listen<{ room_id: string }>('room-closed', event => {
    if (event.payload.room_id === 'world') return;
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
    const offer = event.payload;
    if (state.publicOffers.has(offer.offer_id)) {
      const existing = state.publicOffers.get(offer.offer_id)!;
      existing.expires_at = offer.expires_at;
      return;
    }
    offer.nick_color = normalizeNickColor(offer.nick_color);
    state.publicOffers.set(offer.offer_id, offer);
    pushMessage({
      id: `public:${offer.offer_id}`,
      kind: 'public_offer',
      peer_id: offer.peer_id,
      nick: offer.nick,
      nick_color: offer.nick_color,
      room: offer.room_id ?? 'world',
      text: '',
      timestamp: Number(offer.timestamp),
      public_offer: offer,
    });
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
