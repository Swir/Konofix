let checks = 0;
const check = (condition, message) => { checks++; if (!condition) throw new Error(message); };
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const storage = new Map();
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const listeners = new Map(), requests = [], alerts = [];
const listen = async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); };
const invoke = (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject }));
const request = command => { const index = requests.findIndex(item => item.command === command); check(index >= 0, `Expected IPC ${command}`); return requests.splice(index, 1)[0]; };
const emit = async (name, payload) => { check(listeners.has(name), `Listener ${name} ready`); await listeners.get(name)({ payload }); await tick(); };
const t = (key, params = {}) => `${key} ${Object.values(params).join(' ')}`.trim();
const DEFAULT_NICK_COLOR = '#62e5ff', NICK_COLORS = [], KONOFIX_EMOJI = [];
const normalizeNickColor = () => DEFAULT_NICK_COLOR;
const renderChatText = value => String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
const alert = message => alerts.push(message), prompt = () => 'new room';
let ids = 0;
const crypto = { randomUUID: () => `fixture-message-${++ids}` }; // Only local system-message IDs.
document.body.innerHTML = '<div id="app"></div>';
// Same lexical environment as the actual modules, with only module imports replaced.
const run = new Function('currentLocale', 'localStorage', 'listen', 'invoke', 't', 'DEFAULT_NICK_COLOR', 'NICK_COLORS', 'KONOFIX_EMOJI', 'normalizeNickColor', 'renderChatText', 'alert', 'prompt', 'crypto', `${HELPER_SOURCE}\n${CORE_SOURCE}\nreturn { state, renderChat, resetSessionView, switchRoom, createRoom, transferHtml, mergeTransferSnapshot, transferPercent, sendFileToPeer };`);
const core = run(currentLocale, localStorage, listen, invoke, t, DEFAULT_NICK_COLOR, NICK_COLORS, KONOFIX_EMOJI, normalizeNickColor, renderChatText, alert, prompt, crypto);
await tick();
const state = core.state;
function setup() {
  state.connected = true; state.peerId = 'self-peer'; state.nick = 'Self'; state.room = 'alpha';
  state.peers.set('peer-b', { peer_id: 'peer-b', nick: 'LongNicknameForTesting' });
  for (const id of ['world', 'alpha', 'beta']) state.rooms.set(id, { id, title: `# ${id}`, users: 2 });
  core.renderChat();
}
setup();
const base = { transfer_id: 'png-small', peer_id: 'peer-b', nick: 'Other', direction: 'incoming', file_name: 'small.png', size: 400, transferred: 0, progress: 0, status: 'receiving' };
// Reproduce the observed small-PNG race with the actual Accept button handler.
await emit('file-offer', { ...base });
document.querySelector('#acceptOffer').click();
const accept = request('accept_file');
await emit('file-transfer', { ...base, status: 'completed', transferred: 400, progress: 100, path: 'Downloads/small.png' });
accept.resolve({ ...base }); await tick();
check(state.transfers.get(base.transfer_id)?.status === 'completed', 'A late accept_file reply reset completed PNG to receiving/0%');
check(document.querySelector('.transfer-card.completed [role="progressbar"]')?.getAttribute('aria-valuenow') === '100.0', 'Completed PNG must visibly show 100%');
const completedMessages = [...state.messages.values()].flat().filter(item => item.text.startsWith('transfer.finished')).length;
await emit('file-transfer', { ...base, status: 'completed', transferred: 400, progress: 100 });
check([...state.messages.values()].flat().filter(item => item.text.startsWith('transfer.finished')).length === completedMessages, 'Repeated terminal events must not duplicate completion notices');
await emit('file-transfer', { ...base, transferred: 10, progress: 2.5 });
check(state.transfers.get(base.transfer_id).status === 'completed', 'A stale progress event must not undo completion');
// Large PNG/EXE progress and late snapshots share the same code, no extension special case.
for (const extension of ['png', 'exe']) {
  const file = { ...base, transfer_id: `large-${extension}`, file_name: `large.${extension}`, size: 4000000 };
  await emit('file-offer', file);
  document.querySelector('#acceptOffer').click();
  const pendingAccept = request('accept_file');
  await emit('file-transfer', { ...file, transferred: 2000000, progress: 50 });
  pendingAccept.resolve(file); await tick();
  check(state.transfers.get(file.transfer_id).progress === 50, `${extension}: IPC snapshot rolled progress backwards`);
  const composer = document.querySelector('#msg'), exit = document.querySelector('#leaveRoom');
  composer.value = 'Unsent draft'; composer.focus(); composer.setSelectionRange(3, 7);
  await emit('file-transfer', { ...file, transferred: 3000000, progress: 75 });
  check(document.querySelector('#msg') === composer && composer.value === 'Unsent draft', 'Progress must not replace the chat composer or discard its draft');
  check(document.activeElement === composer && composer.selectionStart === 3 && composer.selectionEnd === 7, 'Progress must preserve keyboard focus and selection');
  check(document.querySelector('#leaveRoom') === exit && Boolean(exit), 'Room exit must survive progress updates without replacing the clickable target');
  const modal = document.createElement('input'); document.body.appendChild(modal); modal.focus();
  await emit('file-transfer', { ...file, status: 'completed', transferred: file.size, progress: 100 });
  check(document.activeElement === modal, 'Completion must not steal focus from a dialog');
  check(document.querySelector('#msg').value === 'Unsent draft', 'Completion must preserve the same-room draft'); modal.remove();
}
const outgoing = core.sendFileToPeer('peer-b');
const offer = request('offer_file');
const sent = { ...base, direction: 'outgoing', transfer_id: 'sent-png' };
await emit('file-transfer', { ...sent, status: 'completed', progress: 100, transferred: sent.size });
offer.resolve(sent); await outgoing;
check(state.transfers.get(sent.transfer_id).status === 'completed', 'Late offer_file reply must not rewind sender progress');
// Terminal failure/cancellation is never cosmetically converted to success.
for (const status of ['failed', 'cancelled', 'rejected']) {
  check(core.transferPercent({ progress: 37, status }) === 37, `${status} must not imply 100%`);
}
check(core.transferPercent({ progress: NaN, status: 'receiving' }) === 0, 'NaN progress must be bounded');
// Public image placeholder must be replaced by the actual transfer as before.
const image = { ...base, transfer_id: 'image-public', public_offer_id: 'image-offer', preview_only: true };
state.transfers.set('claim:image-offer', { ...image, transfer_id: 'claim:image-offer', status: 'requesting' });
await emit('file-transfer', { ...image, progress: 25, transferred: 100 });
check(!state.transfers.has('claim:image-offer') && state.transfers.get('image-public').progress === 25, 'Preview placeholder must be reconciled');
// Explicit exit is acknowledged by backend, including clicks during pending entry.
state.room = 'alpha'; core.renderChat();
check(document.querySelector('#leaveRoom').textContent.includes(currentLocale === 'pl' ? 'Opuść pokój' : 'Leave room'), 'Room exit must be localized');
const enter = core.switchRoom('beta'), entering = request('enter_room');
document.querySelector('#leaveRoom').click(); await tick();
check(requests.every(item => item.command !== 'enter_room'), 'Queued exit must not overtake pending backend entry');
entering.resolve(); await enter; await tick();
const exitRequest = request('enter_room');
check(exitRequest.args.roomId === 'world' && state.room === 'beta', 'Queued exit must target WORLD and wait for acknowledgement');
exitRequest.resolve(); await tick();
check(state.room === 'world' && !document.querySelector('#leaveRoom'), 'Acknowledged exit must return to WORLD');
check(document.querySelector('#msg').value === '', 'A private-room draft must not leak into WORLD');
// A failed exit retains the current room and can be retried.
state.room = 'alpha'; core.renderChat();
document.querySelector('#leaveRoom').click(); request('enter_room').reject(new Error('temporary')); await tick();
check(state.room === 'alpha', 'Rejected exit must not pretend to have left');
document.querySelector('#leaveRoom').click(); request('enter_room').resolve(); await tick();
check(state.room === 'world', 'Exit must remain retryable');
// Leaving while create acknowledgement is pending must also be queued.
const create = core.createRoom(), creating = request('create_room');
await core.switchRoom('world'); creating.resolve({ id: 'new-room', title: '# New' }); await create; await tick();
const createdExit = request('enter_room'); check(createdExit.args.roomId === 'world', 'Exit during room creation must not be lost'); createdExit.resolve(); await tick();
// A previous session's delayed acceptance response cannot repopulate the new one.
setup(); await emit('file-offer', { ...base, transfer_id: 'old-session' });
document.querySelector('#acceptOffer').click(); const stale = request('accept_file');
core.resetSessionView(); stale.resolve({ ...base, transfer_id: 'old-session' }); await tick();
check(state.transfers.size === 0 && !state.connected, 'Stale accept reply must not restore old-session transfers');
// Actual room UI with a deliberately stalled remote end delivery.
setup();
const voiceWaits = [];
class RoomAudioCallController {
  constructor(signaler, { events }) { this.events = events; this.sessions = { setPreferences() {} }; this.session = null; this.leaves = 0; this.resets = 0; this.stallJoin = false; }
  activeSession() { return this.session; }
  async joinRoom(roomId) {
    this.session = { id: `voice-${roomId}`, scope: { kind: 'room', roomId }, phase: 'joining', roomIntent: 'listen', participants: new Map(), localMuted: true, deafened: false };
    this.events.onSession(this.session);
    const snapshot = this.session;
    if (this.stallJoin) await new Promise(resolve => voiceWaits.push(resolve));
    else { snapshot.phase = 'connected'; this.events.onSession(snapshot); }
    return snapshot;
  }
  leaveRoom() { this.leaves++; this.session = null; return new Promise(resolve => voiceWaits.push(resolve)); }
  reset() { this.resets++; this.session = null; }
  syncPeers() { return Promise.resolve(); }
}
const soundListen = async () => () => {};
const runRoom = new Function('currentLocale', 'localStorage', 'listen', 'invoke', 'RoomAudioCallController', 'AudioMediaError', 'normalizeAudioMediaError', 'alert', `${ROOM_SOURCE}\nreturn { controller, joinCurrentRoom, leaveRoomVoice, resetRoomVoiceUi };`);
const voice = runRoom(currentLocale, localStorage, soundListen, invoke, RoomAudioCallController, Error, error => error, alert);
await voice.joinCurrentRoom(); await tick();
check(Boolean(document.querySelector('#roomAudioPanel')), 'Room voice panel should open');
document.querySelector('[data-room-audio-leave]').click(); await tick();
check(!document.querySelector('#roomAudioPanel') && !voice.controller.activeSession(), 'Local voice exit must finish before remote end acknowledgements');
await voice.joinCurrentRoom(); await tick();
voiceWaits.shift()(); await tick();
check(Boolean(document.querySelector('#roomAudioPanel')) && Boolean(voice.controller.activeSession()), 'Late previous end delivery must not close a new call');
state.room = 'world'; core.renderChat(); await tick();
check(!document.querySelector('#roomAudioPanel') && !voice.controller.activeSession(), 'Leaving the text room must stop its voice');
while (voiceWaits.length) voiceWaits.shift()();
state.room = 'alpha'; core.renderChat(); await tick();
voice.controller.stallJoin = true;
const joiningVoice = voice.joinCurrentRoom(); await tick();
document.querySelector('[data-room-audio-leave]').click(); await tick();
while (voiceWaits.length) voiceWaits.shift()();
await joiningVoice; await tick();
check(!document.querySelector('#roomAudioPanel') && !voice.controller.activeSession(), 'A late join result must not resurrect a cancelled call');
return { pass: true, checks, scope: 'real DOM + actual core handlers; controlled IPC ordering, not real transfer/network evidence' };
