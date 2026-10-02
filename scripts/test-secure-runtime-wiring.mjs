import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-secure-runtime-wiring.mjs');
const canonical = fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-secure-wiring-'));

const run = source => {
  const file = path.join(dir, 'lib.rs');
  fs.writeFileSync(file, source);
  return spawnSync(process.execPath, [checker, file], { encoding: 'utf8' });
};
const mutateOnce = (source, from, to) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Mutation target must exist exactly once: ${from}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const mutateWithin = (source, startMarker, endMarker, from, to) => {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Mutation block not found: ${startMarker} -> ${endMarker}`);
  }
  const blockEnd = end + endMarker.length;
  const block = source.slice(start, blockEnd);
  const mutated = mutateOnce(block, from, to);
  return source.slice(0, start) + mutated + source.slice(blockEnd);
};
const expectRejected = (name, source, expected) => {
  const result = run(source);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(`Mutation '${name}' was not rejected as expected. Output:\n${output}`);
  }
};

if (run(canonical).status !== 0) {
  const failed = run(canonical);
  throw new Error(`Canonical secure-runtime wiring policy failed:\n${failed.stdout}\n${failed.stderr}`);
}

expectRejected(
  'secure behaviour removed',
  mutateOnce(
    canonical,
    'secure_control: request_response::cbor::Behaviour<ControlRequest, ControlResponse>,',
    'removed_control: request_response::cbor::Behaviour<ControlRequest, ControlResponse>,',
  ),
  'request/response behaviour is not wired',
);
expectRejected(
  'private route redirected',
  mutateWithin(
    canonical,
    'NetworkCommand::SendPrivateMessage { peer_id: target_raw',
    'pending_private_messages.insert(correlation, reply);',
    '.send_request(&target, request);',
    '.send_request(&owner, request);',
  ),
  'Private chat is not routed directly',
);
expectRejected(
  'voice route redirected',
  mutateWithin(
    canonical,
    'NetworkCommand::SendVoiceSignal {\n                        peer_id: target_raw,',
    'pending_voice_signals.insert(correlation, reply);',
    '.send_request(&target, request);',
    '.send_request(&owner, request);',
  ),
  'Voice signaling is not routed directly',
);
expectRejected(
  'private message exposed to public wire',
  mutateOnce(
    canonical,
    'Chat(ChatMessage),',
    'Chat(ChatMessage),\n    PrivateMessage(PrivateDirectMessage),',
  ),
  'must never be represented as public GossipSub WireEvent data',
);
expectRejected(
  'protected room guard removed',
  canonical.replaceAll(
    'Protected room authorization is required.',
    'authorization check disabled',
  ),
  'Protected-room admission/send gate is missing',
);
expectRejected(
  'private Tauri command unregistered',
  mutateOnce(canonical, '            send_private_message,', ''),
  'Tauri secure feature command is not registered',
);
expectRejected(
  'voice Tauri command unregistered',
  mutateOnce(canonical, '            send_voice_signal,', ''),
  'Tauri secure feature command is not registered',
);

fs.rmSync(dir, { recursive: true, force: true });
console.log('Secure runtime wiring adversarial tests passed (7 mutations rejected).');
