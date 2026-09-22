import fs from 'node:fs';

const readText = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = readText('src/main.ts');
const core = readText('src-tauri/src/lib.rs');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}

requireText(main, "roomId: state.room === 'world' ? null : state.room", 'targeted room file send must retain the current non-WORLD room context');
requireText(main, 'id="shareRoomFile"', 'non-WORLD room header must expose a room-scoped file share action');
requireText(main, "sharePublic('file', state.room)", 'room header file sharing must publish to the active room instead of opening the global recipient picker');
requireText(main, "const messageRoom = offer.room_id ?? 'world';", 'room-scoped offers must render into their advertised room');
requireText(core, 'mime: Option<String>,\n    #[serde(default)]\n    room_id: Option<String>', 'room-scoped offer metadata must be backward-compatible for older WORLD-only offers');
requireText(core, 'room_id: offer.view.room_id.clone()', 'on-demand P2P download must preserve the room authorization context');
requireText(core, 'Dropped room-scoped file offer from unauthorized or unknown context', 'protected room offer metadata must fail closed when local authoritative state rejects it');
requireText(main, 'offer.room_id', 'incoming file UI must expose room context');
requireText(core, '#[serde(default)]\n        room_id: Option<String>', 'file protocol room context must remain backward-compatible');
requireText(core, 'secure_runtime.room_authorized(room_id, &target_peer, now_ms())', 'protected owner send must verify recipient room authorization');
requireText(core, 'secure_client.room_authorized(room_id, &local_peer)', 'protected non-owner send/receive must require local authorization');
requireText(core, 'Protected-room transfer authorization failed.', 'receiver must fail closed on protected-room authorization failure');

if (/FileRequest::Offer\s*\{[\s\S]{0,260}public_offer_id:\s*None,[\s\S]{0,80}\}/.test(core) &&
    !/FileRequest::Offer\s*\{[\s\S]{0,300}public_offer_id:\s*None,[\s\S]{0,100}room_id/.test(core)) {
  throw new Error('direct file Offer lost its room context field');
}

if (main.includes("document.querySelector('#sendFile')?.addEventListener('click', offerFile);")) {
  throw new Error('room header must not route file sharing through the global peer recipient picker');
}
console.log('Protected-room and room-scoped file sharing contract: OK');
