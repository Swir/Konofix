import fs from 'node:fs';

const rustPath = process.argv[2] ?? 'src-tauri/src/lib.rs';
const rust = fs.readFileSync(rustPath, 'utf8').replaceAll('\r\n', '\n');
const errors = [];
const requireText = (needle, message) => {
  if (!rust.includes(needle)) errors.push(message);
};

requireText(
  'secure_control: request_response::cbor::Behaviour<ControlRequest, ControlResponse>',
  'Secure-control request/response behaviour is not wired into the desktop swarm.',
);
requireText(
  'let secure_control = control_behaviour();',
  'Secure-control behaviour is not constructed with the desktop swarm.',
);
requireText(
  'SwarmEvent::Behaviour(BehaviourEvent::SecureControl(event)) => {',
  'Secure-control swarm events are not handled by the desktop runtime.',
);
if (!/\.secure_control\s*\.send_request\(&owner, request\)/m.test(rust)) {
  errors.push('Protected-room authorization is not routed directly to the authenticated owner peer.');
}
if (!/\.secure_control\s*\.send_request\(&target, request\)/m.test(rust)) {
  errors.push('Private chat is not routed directly to the authenticated target peer.');
}
requireText(
  'handle_inbound_control_request(',
  'Inbound secure-control requests do not pass through the authenticated runtime validator.',
);
requireText(
  'Protected room authorization is required.',
  'Protected-room admission/send gate is missing from the desktop runtime.',
);
requireText(
  'secure_runtime.room_authorized(',
  'Protected-room owner-side authorization check is missing.',
);
for (const command of [
  'create_secure_room,',
  'update_room_password,',
  'authorize_room_entry,',
  'send_private_message,',
]) {
  requireText(command, `Tauri secure feature command is not registered: ${command}`);
}

const wireStart = rust.indexOf('enum WireEvent {');
const wireEnd = wireStart < 0 ? -1 : rust.indexOf('\n}', wireStart);
const wire = wireStart < 0 || wireEnd < 0 ? '' : rust.slice(wireStart, wireEnd);
if (!wire) errors.push('WireEvent enum is missing.');
if (/Private(?:Message|Chat)|PrivateDirectMessage/.test(wire)) {
  errors.push('Private messages must never be represented as public GossipSub WireEvent data.');
}

if (errors.length) {
  for (const error of errors) console.error(`SECURE RUNTIME WIRING ERROR: ${error}`);
  process.exit(1);
}
console.log('Secure rooms/private-chat production wiring policy verified.');
