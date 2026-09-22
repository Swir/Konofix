import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const ui = read('src/secure-ui.ts');
const css = read('src/secure-ui.css');
const index = read('index.html');

function requireText(text, message) {
  if (!ui.includes(text)) throw new Error(message);
}

requireText("event.stopImmediatePropagation();", 'secure UI must capture protected-room/create actions before legacy handlers');
requireText("invoke<SecureRoomInfo>('create_secure_room'", 'password-protected room creation must use a dedicated secure command');
requireText("invoke('authorize_room_entry'", 'locked-room admission must explicitly authorize before legacy room entry');
requireText("invoke<SecureRoomInfo>('update_room_password'", 'room owners must be able to change/remove protection');
requireText("invoke<PrivateChatMessage>('send_private_message'", 'private messages must use the dedicated P2P command');
requireText("listen<PrivateChatMessage>('private-message'", 'private incoming messages must use a dedicated event');
requireText('renderChatText(message.text)', 'private messages must reuse safe chat rendering');
requireText("authorizedRoomRevision.get(roomId) === revision", 'room authorization must be tied to the advertised auth revision');
requireText("authorizedRoomRevision.delete(room.id)", 'password revision changes must invalidate cached local admission');
requireText("conversations.unreadCount(peerId)", 'private UI must expose unread state per peer');
requireText("const unreadText = String(Math.min(99, unread));", 'existing private-chat buttons must derive the current unread badge value');
requireText("if (badge.textContent !== unreadText) badge.textContent = unreadText;", 'existing private-chat buttons must refresh unread badges idempotently');
requireText("badge?.remove();", 'opening a private conversation must be able to clear a stale unread badge');
requireText("offlinePeers.has(activePrivatePeerId)", 'private UI must reflect peer disconnect state');
requireText("let augmentQueued = false;", 'secure UI must coalesce DOM augmentation work');
requireText("existingManage.textContent !== manageIcon", 'room password manager updates must be idempotent to avoid MutationObserver loops');
requireText("badge.textContent !== unreadText", 'unread badge updates must be idempotent to avoid MutationObserver loops');
requireText("secureRoomCreateModal", 'room creation must use one in-app modal instead of chained browser prompts');

if (!css.includes(':focus-visible')) {
  throw new Error('secure-room and private-chat controls must expose a visible keyboard focus state');
}
if (!css.includes('max-height: calc(100dvh - 32px)')) {
  throw new Error('secure-room creation modal must remain bounded inside short application windows');
}
if (!css.includes('@media (max-height: 560px) and (min-width: 721px)')) {
  throw new Error('private chat must adapt to short desktop windows instead of clipping controls');
}
if (!css.includes('@media (pointer: coarse)') || !css.includes('min-width: 44px') || !css.includes('min-height: 44px')) {
  throw new Error('touch-oriented secure/private controls must keep accessible coarse-pointer hit targets');
}
if (!css.includes('env(safe-area-inset-top)') || !css.includes('env(safe-area-inset-bottom)')) {
  throw new Error('mobile private chat must respect display safe-area insets');
}

if (ui.includes("if (!fileButton || row.querySelector('[data-private-peer]')) return;")) {
  throw new Error('existing private-chat buttons must not skip unread-state refresh');
}
if (ui.includes("invoke('send_message'") || ui.includes('gossipsub')) {
  throw new Error('private/secure UI must not fall back to public chat or GossipSub');
}
if (/innerHTML\s*=.*message\.text/.test(ui)) {
  throw new Error('private message text must never be inserted as raw HTML');
}
if (!index.includes('/src/secure-ui.ts')) {
  throw new Error('secure UI module must be loaded by the application shell');
}

console.log('secure room/private-chat UI contract: OK');

if (/else if \(existingManage\)\s*\{\s*existingManage\.textContent\s*=/.test(ui)) {
  throw new Error('unconditional room-manager text writes can reintroduce an infinite MutationObserver loop');
}
