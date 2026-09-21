import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const ui = read('src/secure-ui.ts');
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
requireText("offlinePeers.has(activePrivatePeerId)", 'private UI must reflect peer disconnect state');

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
