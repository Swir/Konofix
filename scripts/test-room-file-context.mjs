import fs from 'node:fs';

const readText = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = readText('src/main.ts');
const core = readText('src-tauri/src/lib.rs');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}

requireText(main, "roomId: state.room === 'world' ? null : state.room", 'room file send must bind the current non-WORLD room context');
requireText(main, 'offer.room_id', 'incoming file UI must expose room context');
requireText(core, '#[serde(default)]\n        room_id: Option<String>', 'file protocol room context must remain backward-compatible');
requireText(core, 'secure_runtime.room_authorized(room_id, &target_peer, now_ms())', 'protected owner send must verify recipient room authorization');
requireText(core, 'secure_client.room_authorized(room_id, &local_peer)', 'protected non-owner send/receive must require local authorization');
requireText(core, 'Protected-room transfer authorization failed.', 'receiver must fail closed on protected-room authorization failure');

if (/FileRequest::Offer\s*\{[\s\S]{0,260}public_offer_id:\s*None,[\s\S]{0,80}\}/.test(core) &&
    !/FileRequest::Offer\s*\{[\s\S]{0,300}public_offer_id:\s*None,[\s\S]{0,100}room_id/.test(core)) {
  throw new Error('direct file Offer lost its room context field');
}

console.log('Protected-room file context and authorization source contract: OK');
