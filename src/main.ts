import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
  nat: 'unknown', listen_addresses: [], detail: 'Rozłączono'
};

const state = {
  nick: '',
  peerId: '',
  version: '0.4.1',
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
      catch (e) { console.error('Nie udało się otworzyć GitHuba:', e); }
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
          <p>Wchodzisz. Rozmawiasz. Wychodzisz — znikasz z sieci.</p>
          <div class="feature-row">
            <span>◆ bez konta</span><span>◆ bez historii na serwerze</span><span>◆ transfer plików P2P</span>
          </div>
        </div>
      </section>

      <section class="login-card glass">
        <div class="online-pill"><i></i> P2P ENGINE 0.4</div>
        <h2>Wejdź do #WORLD</h2>
        <p class="muted">Wybierz nick. Jest rezerwowany tylko wtedy, gdy jesteś online.</p>
        <label for="nick">Twój nick</label>
        <input id="nick" maxlength="24" autocomplete="off" spellcheck="false" placeholder="np. SWIR" />
        <div id="loginError" class="error"></div>
        <button id="connectBtn" class="primary">Połącz z siecią</button>
        <button id="loginNetwork" class="link-btn">Zaawansowane ustawienia sieci</button>
        <div class="privacy-note">🔒 Połączenia są szyfrowane przez libp2p. Nick nie jest kontem.</div>
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
    error.textContent = 'Nick musi mieć co najmniej 3 znaki.';
    return;
  }
  if (!/^[\p{L}\p{N}_\-.]+$/u.test(nick)) {
    error.textContent = 'Użyj liter, cyfr, _, - lub kropki.';
    return;
  }

  const btn = document.querySelector<HTMLButtonElement>('#connectBtn')!;
  btn.disabled = true;
  btn.textContent = 'Uruchamianie sieci P2P…';

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
    addSystem('world', `Połączono jako ${state.nick}. Szukam innych peerów…`);
  } catch (e) {
    error.textContent = String(e);
    btn.disabled = false;
    btn.textContent = 'Połącz z siecią';
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
        <div class="section-title">POKOJE TYMCZASOWE</div>
        <div id="rooms">${[...state.rooms.values()].filter(r => r.id !== 'world').map(roomButton).join('')}</div>
        <button id="newRoom" class="ghost wide">＋ Utwórz pokój</button>

        <div class="network-card" id="networkCard">
          <div class="network-top"><span class="net-dot ${networkClass}"></span><strong>${networkLabel()}</strong><button id="refreshNetwork" title="Odśwież discovery">↻</button></div>
          <small>${esc(networkSubtitle())}</small>
        </div>

        <div class="sidebar-bottom">
          <div class="me-dot"></div>
          <div class="me-info"><strong>${esc(state.nick)}</strong><span>${shortPeer(state.peerId)}</span></div>
          <button id="networkSettings" class="icon-btn" title="Sieć P2P">⚙</button>
          <button id="disconnect" class="icon-btn danger" title="Rozłącz">⏻</button>
        </div>
      </aside>

      <section class="chat-main glass">
        <header class="chat-header">
          <div>
            <h2>${esc(currentRoom.title)}</h2>
            <span>${state.room === 'world' ? 'Wspólny globalny kanał P2P' : 'Pokój istnieje tylko, gdy jego host jest online'}</span>
          </div>
          <div class="header-actions">
            <span class="live"><i></i>${onlineCount} online</span>
            <button id="sendFile" class="ghost" ${state.peers.size ? '' : 'disabled'}>📎 Wyślij plik</button>
          </div>
        </header>

        <div id="messages" class="messages">
          ${messages.length ? messages.map(messageHtml).join('') : `<div class="empty"><div>🌐</div><strong>Witaj w ${esc(currentRoom.title)}</strong><span>Napisz pierwszą wiadomość.</span></div>`}
        </div>

        <footer class="composer">
          <input id="msg" maxlength="4000" autocomplete="off" placeholder="Napisz wiadomość do ${esc(currentRoom.title)}…" />
          <button id="send" class="send" title="Wyślij">➤</button>
        </footer>
      </section>

      <aside class="users glass">
        <div class="users-head"><strong>ONLINE</strong><span>${onlineCount}</span></div>
        <div class="user self"><div class="avatar">${esc(state.nick[0]?.toUpperCase() ?? 'S')}</div><div><strong>${esc(state.nick)}</strong><span>Ty · nick zarezerwowany</span></div></div>
        <div id="peerList">${[...state.peers.values()].sort((a,b) => a.nick.localeCompare(b.nick)).map(peerHtml).join('')}</div>
        <div class="transfer-section">
          <div class="users-head"><strong>TRANSFERY</strong><span>${transfers.filter(t => activeTransfer(t.status)).length}</span></div>
          <div class="transfer-list">${transfers.length ? transfers.map(transferHtml).join('') : '<div class="transfer-empty">Brak transferów</div>'}</div>
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
    try { await invoke('refresh_discovery'); } catch (err) { addSystem(state.room, `Discovery: ${String(err)}`); }
  });
  const msg = document.querySelector<HTMLInputElement>('#msg')!;
  msg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendMessage(); });
  msg.focus();
  scrollBottom();
}

function networkLabel(): string {
  if (state.status.phase === 'online') return 'P2P ONLINE';
  if (state.status.phase === 'searching') return 'SZUKAM PEERÓW';
  return 'P2P OFFLINE';
}

function networkSubtitle(): string {
  const parts = [`${state.status.connected_peers} połączeń`, `DHT ${state.status.dht_peers}`];
  if (state.status.nat && state.status.nat !== 'unknown') parts.push(`NAT ${state.status.nat}`);
  return parts.join(' · ');
}

function roomButton(room: RoomInfo): string {
  const mine = room.owner === state.peerId;
  return `<button class="room ${state.room === room.id ? 'active' : ''}" data-room="${esc(room.id)}"><span>#</span> ${esc(room.title.replace(/^#\s*/, ''))}${mine ? '<em>HOST</em>' : ''}</button>`;
}

function peerHtml(peer: PeerInfo): string {
  const initial = peer.nick[0]?.toUpperCase() ?? '?';
  return `<div class="user"><div class="avatar">${esc(initial)}</div><div><strong>${esc(peer.nick)}</strong><span>${shortPeer(peer.peer_id)}</span></div><button class="mini-file" data-send-peer="${esc(peer.peer_id)}" title="Wyślij plik do ${esc(peer.nick)}">📎</button></div>`;
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
  return ({
    waiting: 'Czeka na akceptację', sending: 'Wysyłanie', receiving: 'Pobieranie', verifying: 'Weryfikacja SHA‑256',
    completed: 'Gotowe', rejected: 'Odrzucono', failed: 'Błąd', cancelled: 'Anulowano'
  } as Record<string,string>)[status] || status;
}

function transferHtml(t: FileTransfer): string {
  const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
  const icon = t.direction === 'outgoing' ? '↗' : '↙';
  const cancel = activeTransfer(t.status) ? `<button data-cancel-transfer="${esc(t.transfer_id)}" title="Anuluj">×</button>` : '';
  const detail = t.error ? `<small class="transfer-error">${esc(t.error)}</small>` : t.path ? `<small title="${esc(t.path)}">${esc(t.path)}</small>` : `<small>${formatBytes(t.transferred)} / ${formatBytes(t.size)}</small>`;
  return `<div class="transfer-card ${esc(t.status)}">
    <div class="transfer-title"><span>${icon}</span><strong title="${esc(t.file_name)}">${esc(t.file_name)}</strong>${cancel}</div>
    <div class="transfer-meta"><span>${esc(t.nick)}</span><b>${esc(transferStatus(t.status))}</b></div>
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
    addSystem(state.room, `Błąd wysyłania: ${String(e)}`);
  }
}

async function createRoom() {
  const raw = prompt('Nazwa nowego pokoju (3–32 znaki):');
  if (!raw) return;
  const title = raw.trim().replace(/^#/, '').trim();
  if (!/^[\p{L}\p{N}_\- ]{3,32}$/u.test(title)) {
    alert('Nieprawidłowa nazwa pokoju.');
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
    alert('Nie ma teraz żadnego innego użytkownika online.');
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
    <div class="modal-head"><div><span class="eyebrow">P2P FILE TRANSFER</span><h3>Wyślij plik</h3></div><button data-close>×</button></div>
    <p class="modal-lead">Wybierz użytkownika. Potem otworzy się systemowe okno wyboru pliku.</p>
    <div class="recipient-list">${peers.map(p => `<button data-recipient="${esc(p.peer_id)}"><span class="avatar">${esc(p.nick[0]?.toUpperCase() ?? '?')}</span><span><strong>${esc(p.nick)}</strong><small>${esc(shortPeer(p.peer_id))}</small></span><b>Wyślij →</b></button>`).join('')}</div>
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
    alert('Ten użytkownik nie jest już online.');
    return;
  }
  try {
    const transfer = await invoke<FileTransfer | null>('offer_file', { peerId });
    if (transfer) {
      state.transfers.set(transfer.transfer_id, transfer);
      addSystem(state.room, `📎 Wysłano ofertę pliku „${transfer.file_name}” do ${peer.nick}.`);
      renderChat();
    }
  } catch (e) {
    alert(`Nie udało się rozpocząć transferu: ${String(e)}`);
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
    <span class="eyebrow">PRZYCHODZĄCY PLIK P2P</span>
    <h3>${esc(offer.nick)} chce wysłać plik</h3>
    <div class="offer-file"><strong>${esc(offer.file_name)}</strong><span>${formatBytes(offer.size)}</span></div>
    ${dangerous ? '<div class="danger-note">⚠ To plik wykonywalny lub skrypt. Akceptuj tylko, jeśli ufasz nadawcy. Konofix Chat nigdy nie uruchamia pobranych plików automatycznie.</div>' : '<div class="safe-note">Plik zostanie zapisany do Pobrane\\Konofix Chat dopiero po poprawnej weryfikacji SHA‑256.</div>'}
    <div class="offer-actions"><button id="rejectOffer" class="ghost">Odrzuć</button><button id="acceptOffer" class="primary compact">Akceptuj</button></div>
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
    btn.textContent = 'Przygotowuję…';
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

async function disconnect() {
  try { await invoke('disconnect_network'); } catch {}
  document.querySelectorAll('.modal-wrap').forEach(el => el.remove());
  state.connected = false;
  state.peers.clear();
  state.rooms = new Map([['world', { id: 'world', title: '# WORLD' }]]);
  state.messages = new Map([['world', []]]);
  state.transfers.clear();
  state.status = { ...EMPTY_STATUS };
  state.room = 'world';
  renderLogin();
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
      <div class="modal-head"><div><span class="eyebrow">P2P NETWORK</span><h3>Stan sieci</h3></div><button id="closeModal">×</button></div>
      <div class="stats-grid">
        <div><span>Połączenia</span><strong>${state.status.connected_peers}</strong></div>
        <div><span>Peerzy DHT</span><strong>${state.status.dht_peers}</strong></div>
        <div><span>Bootstrapy</span><strong>${state.status.bootstrap_count || bootstraps.length}</strong></div>
        <div><span>Relay</span><strong>${state.status.listen_addresses.filter(a => a.includes('/p2p-circuit')).length ? 'AKTYWNY' : 'AUTO'}</strong></div>
        <div><span>NAT</span><strong>${esc(state.status.nat)}</strong></div>
      </div>
      <label>Adres bootstrap peera</label>
      <div class="inline-form"><input id="bootstrapInput" placeholder="/ip4/.../tcp/.../p2p/12D3KooW..."/><button id="addBootstrap" class="primary compact">Dodaj</button></div>
      <div class="bootstrap-list">${bootstraps.length ? bootstraps.map(b => `<div><code>${esc(b)}</code><button data-remove-bootstrap="${esc(b)}">×</button></div>`).join('') : '<p>Brak własnych bootstrapów. LAN działa przez mDNS, a aplikacja próbuje też użyć zapamiętanych peerów.</p>'}</div>
      <div class="listen-block"><span>Moje adresy nasłuchu</span>${state.status.listen_addresses.length ? state.status.listen_addresses.map(a => `<code>${esc(a)}</code>`).join('') : '<small>Pojawią się po uruchomieniu sieci.</small>'}</div>
      <p class="modal-note">Bootstrap pomaga tylko znaleźć sieć. Nie jest serwerem wiadomości ani magazynem plików.</p>
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
      addSystem('world', 'Pokój został zamknięty, ponieważ host opuścił sieć.');
    } else if (state.connected) renderChat();
  });
  await listen<NetworkStatus>('network-status', event => {
    state.status = event.payload;
    if (state.connected) renderChat();
  });
  await listen<string>('network-warning', event => {
    if (state.connected) addSystem('world', `⚠ ${event.payload}`);
  });
  await listen<string>('network-error', event => {
    if (state.connected) addSystem('world', `Błąd sieci: ${event.payload}`);
  });
  await listen<{ nick: string }>('nick-conflict', event => {
    alert(`Nick „${event.payload.nick}” jest już aktywny w sieci. Wybierz inny.`);
    disconnect();
  });
  await listen<FileOffer>('file-offer', event => showFileOfferModal(event.payload));
  await listen<FileTransfer>('file-transfer', event => {
    state.transfers.set(event.payload.transfer_id, event.payload);
    if (event.payload.status === 'completed') {
      const dir = event.payload.direction === 'incoming' ? ` Zapisano: ${event.payload.path || 'Pobrane\\Konofix Chat'}` : '';
      addSystem(state.room, `✅ Transfer „${event.payload.file_name}” zakończony.${dir}`);
    } else if (['failed', 'rejected'].includes(event.payload.status)) {
      addSystem(state.room, `⚠ Transfer „${event.payload.file_name}”: ${event.payload.error || transferStatus(event.payload.status)}.`);
    } else if (state.connected) {
      renderChat();
    }
  });
}

wireEvents();
renderLogin();
