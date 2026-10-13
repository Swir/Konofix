import { WorldRelayBridge } from '../../src/world-relay.ts';

const $ = id => document.getElementById(id);
const node = (tag, text, cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const action = (text, fn, cls = '') => { const b = node('button', text, cls); b.type = 'button'; b.onclick = fn; return b; };
const peers = new Map(), rooms = new Map(), ownedRooms = new Map(), messages = new Map(), names = new Map(), unread = new Map();
let bridge, self = '', joined = false, running = false, connected = 0, nick = '', color = '#65cfff', thread = 'world', view = 'chat', toastTimer;
let blocked = new Set();
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function error(e) { toast(e instanceof Error ? e.message : String(e)); }
function title(id) { return id === 'world' ? 'WORLD' : id.startsWith('nostr:') ? (names.get(id) || peers.get(id)?.nick || 'Rozmowa prywatna') : (rooms.get(id)?.title || ownedRooms.get(id)?.title || 'Pokój niedostępny'); }
function navigate(next) { view = next; for (const id of ['chat', 'people', 'rooms', 'profile']) { $('view-' + id).hidden = id !== next; document.querySelector('[data-view="' + id + '"]').classList.toggle('selected', id === next); } render(); }
function openThread(id) { thread = id; unread.set(id, 0); navigate('chat'); }
function addMessage(m) {
  if (blocked.has(m.peer_id)) return;
  if (!messages.has(m.room) && messages.size >= 24) { toast('Limit rozmów w pamięci. Rozłącz aplikację, aby zacząć nową sesję.'); return; }
  const list = messages.get(m.room) || [];
  if (list.some(x => x.id === m.id && x.peer_id === m.peer_id)) return;
  list.push(m); if (list.length > 100) list.shift(); messages.set(m.room, list);
  if (!m.mine && (view !== 'chat' || thread !== m.room)) unread.set(m.room, (unread.get(m.room) || 0) + 1);
  if (!m.mine && m.room.startsWith('nostr:') && (view !== 'chat' || thread !== m.room)) toast('Nowa prywatna wiadomość: ' + m.nick);
  render();
}
function render() {
  $('network').textContent = connected ? connected + '/4 połączone' : running ? 'Łączenie…' : 'Offline';
  $('network').classList.toggle('online', connected > 0);
  $('people-count').textContent = String(peers.size);
  if (view === 'chat') {
    $('thread-title').textContent = title(thread);
    $('thread-detail').textContent = thread.startsWith('nostr:') ? 'Prywatny tekst NIP-44 · obie osoby online' : 'Publiczna rozmowa · treść nie jest prywatna';
    const chips = $('threads'); chips.replaceChildren();
    for (const id of new Set(['world', ...messages.keys(), thread])) { const n = unread.get(id) || 0; chips.append(action(title(id) + (n ? ' · ' + n : ''), () => openThread(id), 'chip' + (id === thread ? ' active' : ''))); }
    const timeline = $('timeline'), nearEnd = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
    timeline.replaceChildren(); const list = messages.get(thread) || [];
    if (!list.length) { const empty = node('div', '', 'empty'); empty.append(node('div', '✦', 'spark'), node('h2', 'Rozmowa zaczyna się tutaj'), node('p', 'Połącz Konofix na telefonie i Windows z WORLD. Użyj różnych nicków, aby łatwo rozpoznać oba urządzenia.')); timeline.append(empty); }
    for (const m of list) {
      const row = node('article', '', m.mine ? 'bubble mine' : 'bubble');
      const name = node('strong', m.nick); if (/^#[0-9a-f]{6}$/i.test(m.nick_color || '')) name.style.color = m.nick_color;
      row.append(name, node('p', m.text), node('small', new Date(m.timestamp).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) + (m.mine ? ' · przekazano do transportu' : ''))); timeline.append(row);
    }
    if (nearEnd || !list.length || list.at(-1)?.mine) timeline.scrollTop = timeline.scrollHeight;
    $('send').disabled = !running || !connected;
    $('offline').hidden = connected > 0;
  }
  if (view === 'people') {
    const box = $('people-list'); box.replaceChildren();
    const ids = new Set([...peers.keys(), ...[...messages.keys()].filter(x => x.startsWith('nostr:'))]);
    for (const id of ids) {
      const row = node('div', '', 'person'); const label = names.get(id) || peers.get(id)?.nick || 'Osoba offline';
      row.append(action(label + (peers.has(id) ? ' · online' : ' · offline'), () => { if (!blocked.has(id)) openThread(id); }, 'person-name'));
      row.append(action(blocked.has(id) ? 'Odblokuj' : 'Ignoruj', () => { if (blocked.has(id)) blocked.delete(id); else if (blocked.size < 256) blocked.add(id); try { localStorage.setItem('konofix.android.blocked', JSON.stringify([...blocked])); } catch { toast('Nie udało się zapisać ustawienia.'); } render(); }, 'quiet'));
      box.append(row);
    }
    if (!ids.size) box.append(node('p', 'Osoby pojawią się po połączeniu obu aplikacji z publicznymi przekaźnikami WORLD.', 'muted'));
  }
  if (view === 'rooms') {
    const box = $('room-list'); box.replaceChildren();
    for (const room of new Map([...rooms, ...ownedRooms]).values()) box.append(action(room.title, () => openThread(room.id), 'room-card'));
    if (!box.children.length) box.append(node('p', 'Nie znaleziono jeszcze publicznych pokoi.', 'muted'));
  }
  if (view === 'profile') { $('my-nick').textContent = nick; $('my-id').textContent = self; $('session-state').textContent = running ? 'Sesja aktywna na pierwszym planie' : 'Sesja wstrzymana'; }
}
const callbacks = {
  onPresence(peer) { if (peers.size >= 256 && !peers.has(peer.peer_id)) return; peers.set(peer.peer_id, peer); names.set(peer.peer_id, peer.nick); render(); },
  onOffline(id) { peers.delete(id); render(); },
  onChat(m) { addMessage(m); },
  onPrivate(m) { names.set(m.peer_id, m.nick); addMessage({ ...m, room: m.peer_id }); },
  onRoom(room) { if (rooms.size < 128 || rooms.has(room.id)) rooms.set(room.id, room); render(); },
  onRoomClosed(id) { rooms.delete(id); render(); },
  onState(state) { connected = state.connected; render(); },
  onFileOffer(offer) { bridge.rejectFile(offer.transfer_id, 'Android text alpha does not support file transfers yet.'); },
  onRtcSignal(peerId, signal) { if (signal.action === 'call_request') { try { bridge.publishRtcSignal(peerId, { connection_id: signal.connection_id, action: 'call_reject', reason: 'Audio is not available in this Android alpha.' }); } catch {} } },
};
function start() { if (running || !joined) return; bridge.start(self, nick, color, callbacks); running = true; for (const room of ownedRooms.values()) bridge.publishRoom(room); render(); }
function pause() { if (!running) return; running = false; bridge.stop(); connected = 0; render(); }
function resume() { if (joined && !document.hidden) { try { start(); } catch (e) { error(e); } } }
function logout() { joined = false; pause(); messages.clear(); peers.clear(); rooms.clear(); ownedRooms.clear(); names.clear(); unread.clear(); thread = 'world'; $('app').hidden = true; $('welcome').hidden = false; }
$('join-form').onsubmit = e => {
  e.preventDefault(); $('join-error').textContent = '';
  try {
    if (!bridge) throw new Error('Interfejs nie ukończył inicjalizacji.');
    nick = $('nickname').value.trim(); color = $('nick-color').value;
    if (nick.length < 3 || nick.length > 24 || /[\x00-\x1f\x7f]/.test(nick)) throw new Error('Nick musi mieć od 3 do 24 znaków.');
    if (!$('consent').checked) throw new Error('Zaznacz zgodę na połączenie z publicznymi przekaźnikami.');
    localStorage.setItem('konofix.android.nickname', nick); joined = true; start(); $('welcome').hidden = true; $('app').hidden = false; navigate('chat');
  } catch (err) { joined = false; pause(); $('join-error').textContent = err.message; }
};
$('composer').onsubmit = e => {
  e.preventDefault();
  try {
    const text = $('message').value.trim();
    if (!running || !connected) throw new Error('Brak połączenia. Treść pozostaje w polu wiadomości.');
    if (!text || text.length > 4000) throw new Error('Wpisz od 1 do 4000 znaków.');
    if (thread.startsWith('nostr:')) { if (blocked.has(thread)) throw new Error('Ta osoba jest ignorowana.'); addMessage({ ...bridge.publishPrivate(thread, text), room: thread, mine: true }); }
    else { if (thread !== 'world' && !rooms.has(thread) && !ownedRooms.has(thread)) throw new Error('Pokój jest już niedostępny.'); const m = { id: crypto.randomUUID(), kind: 'chat', peer_id: self, nick, nick_color: color, room: thread, text, timestamp: Date.now() }; if (thread === 'world') bridge.publishChat(m); else bridge.publishRoomChat(m); addMessage({ ...m, mine: true }); }
    $('message').value = '';
  } catch (err) { error(err); }
};
$('emoji').onclick = () => { if ($('message').value.length <= 3997) $('message').value += ' 😀'; $('message').focus(); };
$('reconnect').onclick = () => { pause(); resume(); };
$('logout').onclick = logout;
$('new-room').onclick = () => { $('room-sheet').hidden = false; $('room-name').focus(); };
$('cancel-room').onclick = () => { $('room-sheet').hidden = true; };
$('room-form').onsubmit = e => { e.preventDefault(); try { const label = $('room-name').value.trim(); if (label.length < 3 || label.length > 32 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Nazwa pokoju: 3–32 znaki.'); if (!running || !connected) throw new Error('Najpierw połącz się z WORLD.'); if (ownedRooms.size >= 8) throw new Error('Limit 8 własnych pokoi.'); const room = { id: crypto.randomUUID(), title: '# ' + label }; bridge.publishRoom(room); ownedRooms.set(room.id, room); $('room-sheet').hidden = true; $('room-name').value = ''; openThread(room.id); } catch (err) { error(err); } };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => navigate(button.dataset.view);
document.addEventListener('visibilitychange', () => document.hidden ? pause() : resume());
window.KonoMobile = { pause, resume, back() { if (!$('room-sheet').hidden) $('room-sheet').hidden = true; else if (view !== 'chat' || thread !== 'world') openThread('world'); else toast('Przycisk systemowy Home pozostawia aplikację w tle.'); } };
try {
  if (!window.isSecureContext || !crypto?.getRandomValues || !crypto?.randomUUID || typeof BigInt !== 'function') throw new Error('Zaktualizuj Android System WebView. Wymagany jest bezpieczny kontekst i aktualne funkcje przeglądarki.');
  const probe = 'konofix.android.storage-test'; localStorage.setItem(probe, 'ok'); if (localStorage.getItem(probe) !== 'ok') throw new Error('Pamięć aplikacji jest niedostępna.'); localStorage.removeItem(probe);
  const stored = JSON.parse(localStorage.getItem('konofix.android.blocked') || '[]'); if (Array.isArray(stored)) blocked = new Set(stored.filter(x => typeof x === 'string' && /^nostr:[a-f0-9]{64}$/.test(x)).slice(0, 256));
  bridge = new WorldRelayBridge(); self = bridge.virtualPeerId();
  if (!/^[a-f0-9]{64}$/.test(localStorage.getItem('konofix.worldRelaySecret.v1') || '')) throw new Error('Nie udało się trwale zapisać tożsamości.');
  $('nickname').value = localStorage.getItem('konofix.android.nickname') || '';
  $('join').disabled = false; $('boot-status').textContent = 'Gotowy do połączenia';
  console.info('KONOFIX_UI_READY');
} catch (err) { $('join-error').textContent = err.message; $('boot-status').textContent = 'Błąd uruchomienia'; console.error('KONOFIX_UI_FAILED'); }
