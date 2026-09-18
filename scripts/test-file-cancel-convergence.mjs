import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-file-cancel-convergence.mjs');
const canonical = {
  rust: fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n'),
  frontend: fs.readFileSync('src/main.ts', 'utf8').replaceAll('\r\n', '\n'),
  i18n: fs.readFileSync('src/i18n.ts', 'utf8').replaceAll('\r\n', '\n'),
};
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-file-cancel-'));

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`Test fixture source is not unique: ${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const run = (inputs) => {
  const rustPath = path.join(tempDir, 'lib.rs');
  const frontendPath = path.join(tempDir, 'main.ts');
  const i18nPath = path.join(tempDir, 'i18n.ts');
  fs.writeFileSync(rustPath, inputs.rust, 'utf8');
  fs.writeFileSync(frontendPath, inputs.frontend, 'utf8');
  fs.writeFileSync(i18nPath, inputs.i18n, 'utf8');
  return spawnSync(process.execPath, [checker, rustPath, frontendPath, i18nPath], { encoding: 'utf8' });
};

const baseline = run(canonical);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical cancellation implementation must pass before adversarial mutations run.');
}

const cases = [
  {
    name: 'local cancellation forgets stale request metadata',
    file: 'rust',
    from: 'if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(',
    to: 'if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(',
    expected: 'local cancel must prune stale',
  },
  {
    name: 'local cancellation clears unrelated metadata',
    file: 'rust',
    from: 'if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(',
    to: 'if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            outbound_requests.clear();\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(',
    expected: 'preserve unrelated',
  },
  {
    name: 'wrong peer can claim a pending offer',
    file: 'rust',
    from: 'let pending_matches = pending_incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);',
    to: 'let pending_matches = pending_incoming.get(&transfer_id).map(|transfer| transfer.peer != peer).unwrap_or(false);',
    expected: 'peer-owned',
  },
  {
    name: 'remote outgoing cancellation forgets stale metadata',
    file: 'rust',
    from: 'if outgoing_matches {\n                                                outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);\n                                                if let Some(transfer) = outgoing.remove(&transfer_id) {',
    to: 'if outgoing_matches {\n                                                if let Some(transfer) = outgoing.remove(&transfer_id) {',
    expected: 'remote outgoing cancel',
  },
  {
    name: 'backend pending cancellation event disappears',
    file: 'rust',
    from: '"file-offer-cancelled",',
    to: '"file-offer-cancelled-broken",',
    expected: 'pending-offer cancellation event',
  },
  {
    name: 'frontend stops listening for sender cancellation',
    file: 'frontend',
    from: "await listen<FileOfferCancelled>('file-offer-cancelled', event => {",
    to: "await listen<FileOfferCancelled>('file-offer-cancelled-broken', event => {",
    expected: 'frontend cancelled-offer listener',
  },
  {
    name: 'TTL expiry path is accidentally removed',
    file: 'frontend',
    from: "await listen<FileOfferExpired>('file-offer-expired', event => {",
    to: "await listen<FileOfferExpired>('file-offer-expired-broken', event => {",
    expected: 'TTL expiry listener',
  },
  {
    name: 'English sender-cancelled message is removed',
    file: 'i18n',
    from: "  'transfer.offerCancelled': '🚫 Incoming file offer was cancelled by the sender.',\n",
    to: '',
    expected: 'explicitly present in all 7 supported dictionaries',
  },
];

for (const testCase of cases) {
  const inputs = { ...canonical };
  inputs[testCase.file] = mutateOnce(inputs[testCase.file], testCase.from, testCase.to);
  const result = run(inputs);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) throw new Error(`Mutation '${testCase.name}' unexpectedly passed.`);
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`File cancellation convergence adversarial tests passed (${cases.length} mutations rejected).`);
