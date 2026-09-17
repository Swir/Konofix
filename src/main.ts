import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n';
import './style.css';

type ChatMessage = { id: string; kind: string; peer_id?: string; nick: string; room: string; text: string; timestamp: number };
type PeerInfo = { peer_id: string; nick: string };
type RoomInfo = { id: string; title: string; owner?: string; users?: number };
type NetworkStatus = {
  phase: string;
  connected_peers: number;
  dht_peers: number;
  bootstrap_count: number;
  nat: string;
  listen_addresses: string[];
  detail: string;
};
type FileOffer = { transfer_id: string; peer_id: string; nick: string; file_name: string; size: number };
type FileOfferExpired = { transfer_id: string; peer_id: string };
type FileTransfer = {
  transfer_id: string;
  direction: 'incoming' | 'outgoing';
  peer_id: string;
  nick: string;
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
  peerId: '',
  version: '0.4.2',
  room: 'world',
  connected: false,
  peers: new Map<string, PeerInfo>(),
  rooms: new Map<string, RoomInfo>([['world', { id: 'world', title: '# WORLD' }]]),
  messages: new Map<string, ChatMessage[]>([['world', []]]),
  transfers: new Map<string, FileTransfer>(),
  status: { ...EMPTY_STATUS } as NetworkStatus,
};

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
  document.querySelector('#connectBtn')?.addEventListener('click', connect);
  document.querySelector('#loginNetwork')?.addEventListener('click', showNetworkModal);
}

async function connect() {
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

  const btn = document.querySelector<HTMLButtonElement>('#connectBtn')!;
  btn.disabled = true;
  btn.textContent = t('login.starting');

  try {
    const result = await invoke<{ peer_id: string; nick: string; version: string }>('start_network', {
      nick,
      bootstraps: loadBootstraps(),
    });
    state.nick = result.nick;
    state.peerId = result.peer_id;
    state.version = result.version;
    state.connected = true;
    renderChat();
    addSystem('world', t('login.connectedAs', { nick: state.nick }));
  } catch (e) {
    error.textContent = String(e);
    btn.disabled = false;
    btn.textContent = t('login.connect');
  }
}

function renderChat() {
  const currentRoom = state.rooms.get(state.room) ?? { id: state.room, title: `# ${state.room.toUpperCase()}` };
  const messages = state.messages.get(state.room) ?? [];
  const onlineCount = Math.max(1, state.peers.size + 1);
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
          <div class="me-info"><strong>${esc(state.nick)}</strong><span>${shortPeer(state.peerId)}</span></div>
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
            <span class="live"><i></i>${onlineCount} ${esc(t('common.online').toLowerCase())}</span>
            <button id="sendFile" class="ghost" ${state.peers.size ? '' : 'disabled'}>${esc(t('transfer.sendFile'))}</button>
          </div>
        </header>

        <div id="messages" class="messages">
          ${messages.length ? messages.map(messageHtml).join('') : `<div class="empty"><div>🌐</div><strong>${esc(t('rooms.welcome', { room: currentRoom.title }))}</strong><span>${esc(t('rooms.firstMessage'))}</span></div>`}
        </div>

        <footer class="composer">
          <input id="msg" maxlength="4000" autocomplete="off" placeholder="${esc(t('chat.messageTo', { room: currentRoom.title }))}" />
          <button id="send" class="send" title="${esc(t('common.send'))}">➤</button>
        </footer>
      </section>

      <aside class="users glass">
        <div class="users-head"><strong>${esc(t('common.online'))}</strong><span>${onlineCount}</span></div>
        <div class="user self"><div class="avatar">${esc(state.nick[0]?.toUpperCase() ?? 'S')}</div><div><strong>${esc(state.nick)}</strong><span>${esc(t('user.selfReserved'))}</span></div></div>
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
  document.querySelector('#sendFile')?.addEventListener('click', offerFile);
  document.querySelector('#disconnect')?.addEventListener('click', disconnect);
  document.querySelector('#networkSettings')?.addEventListener('click', showNetworkModal);
  document.querySelector('#networkCard')?.addEventListener('click', showNetworkModal);
  document.querySelector('#refreshNetwork')?.addEventListener('click', async e => {
    e.stopPropagation();
    try { await invoke('refresh_discovery'); } catch (err) { addSystem(state.room, t('network.discoveryError', { error: String(err) })); }
  });
  const msg = document.querySelector<HTMLInputElement>('#msg')!;
  msg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendMessage(); });
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
  return `<button class="room ${state.room === room.id ? 'active' : ''}" data-room="${esc(room.id)}"><span>#</span> ${esc(room.title.replace(/^#\s*/, ''))}${mine ? `<em>${esc(t('common.host'))}</em>` : ''}</button>`;
}

function peerHtml(peer: PeerInfo): string {
  const initial = peer.nick[0]?.toUpperCase() ?? '?';
  return `<div class="user"><div class="avatar">${esc(initial)}</div><div><strong>${esc(peer.nick)}</strong><span>${shortPeer(peer.peer_id)}</span></div><button class="mini-file" data-send-peer="${esc(peer.peer_id)}" title="${esc(t('transfer.sendFileTo', { nick: peer.nick }))}">📎</button></div>`;
}

function shortPeer(v: string): string { return v ? `${v.slice(0, 6)}…${v.slice(-4)}` : 'local'; }

function messageHtml(m: ChatMessage): string {
  if (m.kind === 'system') return `<div class="system-msg">${esc(m.text)}</div>`;
  const mine = m.peer_id === state.peerId || m.nick === state.nick;
  const time = new Date(Number(m.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<article class="message ${mine ? 'mine' : ''}">
    <div class="avatar">${esc(m.nick[0]?.toUpperCase() ?? '?')}</div>
    <div class="bubble"><div class="meta"><strong>${esc(m.nick)}</strong><time>${time}</time></div><p>${esc(m.text)}</p></div>
  </article>`;
}

function activeTransfer(status: string): boolean {
  return ['waiting', 'sending', 'receiving', 'verifying'].includes(status);
}

function transferStatus(status: string): string {
  const keys = {
    waiting: 'transfer.waiting', sending: 'transfer.sending', receiving: 'transfer.receiving', verifying: 'transfer.verifying',
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
  const raw = prompt(t('rooms.newPrompt'));
  if (!raw) return;
  const title = raw.trim().replace(/^#/, '').trim();
  if (!/^[\p{L}\p{N}_\- ]{3,32}$/u.test(title)) {
    alert(t('rooms.invalidName'));
    return;
  }
  try {
    const room = await invoke<RoomInfo>('create_room', { title });
    state.rooms.set(room.id, room);
    if (!state.messages.has(room.id)) state.messages.set(room.id, []);
    state.room = room.id;
    renderChat();
  } catch (e) {
    alert(String(e));
  }
}

function switchRoom(room: string) {
  state.room = room;
  if (!state.messages.has(room)) state.messages.set(room, []);
  renderChat();
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
  modal.innerHTML = `<div class="modal glass compact-modal">
    <div class="modal-head"><div><span class="eyebrow">P2P FILE TRANSFER</span><h3>${esc(t('transfer.sendFilePlain'))}</h3></div><button data-close>×</button></div>
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
    const transfer = await invoke<FileTransfer | null>('offer_file', { peerId });
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
  modal.innerHTML = `<div class="modal glass file-offer-modal">
    <div class="offer-icon">📦</div>
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
  document.querySelectorAll('.modal-wrap').forEach(el => el.remove());
  state.connected = false;
  state.nick = '';
  state.peerId = '';
  state.peers.clear();
  state.rooms = new Map([['world', { id: 'world', title: '# WORLD' }]]);
  state.messages = new Map([['world', []]]);
  state.transfers.clear();
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
      <label>${esc(t('network.bootstrapAddress'))}</label>
      <div class="inline-form"><input id="bootstrapInput" placeholder="/ip4/.../tcp/.../p2p/12D3KooW..."/><button id="addBootstrap" class="primary compact">${esc(t('common.add'))}</button></div>
      <div class="bootstrap-list">${bootstraps.length ? bootstraps.map(b => `<div><code>${esc(b)}</code><button data-remove-bootstrap="${esc(b)}">×</button></div>`).join('') : `<p>${esc(t('network.noBootstraps'))}</p>`}</div>
      <div class="listen-block"><span>${esc(t('network.listenAddresses'))}</span>${state.status.listen_addresses.length ? state.status.listen_addresses.map(a => `<code>${esc(a)}</code>`).join('') : `<small>${esc(t('network.listenPending'))}</small>`}</div>
      <p class="modal-note">${esc(t('network.bootstrapNote'))}</p>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#closeModal')?.addEventListener('click', close);
  modal.querySelector('#addBootstrap')?.addEventListener('click', async () => {
    const input = modal.querySelector<HTMLInputElement>('#bootstrapInput')!;
    const address = input.value.trim();
    if (!address) return;
    const next = [...loadBootstraps(), address];
    saveBootstraps(next);
    if (state.connected) {
      try { await invoke('add_bootstrap', { address }); }
      catch (e) { alert(String(e)); return; }
    }
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
  await listen<NetworkStatus>('network-status', event => {
    state.status = event.payload;
    if (state.connected) renderChat();
  });
  await listen<string>('network-warning', event => {
    if (state.connected) addSystem('world', `⚠ ${event.payload}`);
  });
  await listen<string>('network-error', async event => {
    if (!state.connected) return;
    const message = t('network.error', { error: event.payload });
    try { await invoke('disconnect_network'); } catch {}
    resetSessionView(message);
  });
  await listen<{ nick: string }>('nick-conflict', event => {
    alert(t('nick.conflict', { nick: event.payload.nick }));
    disconnect();
  });
  await listen<FileOffer>('file-offer', event => showFileOfferModal(event.payload));
  await listen<FileOfferExpired>('file-offer-expired', event => {
    const modal = document.querySelector(`#file-offer-${CSS.escape(event.payload.transfer_id)}`);
    if (!modal) return;
    modal.remove();
    if (state.connected) addSystem(state.room, t('transfer.offerExpired'));
  });
  await listen<FileTransfer>('file-transfer', event => {
    state.transfers.set(event.payload.transfer_id, event.payload);
    if (event.payload.status === 'completed') {
      const saved = event.payload.direction === 'incoming' ? t('transfer.saved', { path: event.payload.path || 'Downloads\\Konofix Chat' }) : '';
      addSystem(state.room, t('transfer.finished', { file: event.payload.file_name, saved }));
    } else if (['failed', 'rejected'].includes(event.payload.status)) {
      addSystem(state.room, t('transfer.problem', { file: event.payload.file_name, error: event.payload.error || transferStatus(event.payload.status) }));
    } else if (state.connected) {
      renderChat();
    }
  });
}

wireEvents();
renderLogin();
