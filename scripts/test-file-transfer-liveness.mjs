import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-file-transfer-liveness.mjs');
const sourcePath = path.resolve('src-tauri/src/lib.rs');
const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-file-liveness-'));

const run = (content) => {
  const candidate = path.join(tempDir, 'lib.rs');
  fs.writeFileSync(candidate, content, 'utf8');
  return spawnSync(process.execPath, [checker, candidate], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
};

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Test fixture source is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const baseline = run(source);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical file-transfer implementation must pass its liveness policy checker before adversarial mutations run.');
}

// A separate request_response behaviour may intentionally use a shorter timeout.
// The file liveness checker must stay scoped to the `rr_cfg` file-transfer config.
if (source.includes('let direct_chat_cfg =')) {
  const shortDirect = mutateOnce(
    source,
    'let direct_chat_cfg =\n                request_response::Config::default().with_request_timeout(Duration::from_secs(20));',
    'let direct_chat_cfg =\n                request_response::Config::default().with_request_timeout(Duration::from_secs(5));',
  );
  const directResult = run(shortDirect);
  if (directResult.status !== 0) {
    throw new Error(`A direct-chat timeout mutation incorrectly tripped file-transfer liveness policy:\n${directResult.stdout}\n${directResult.stderr}`);
  }
}

const cases = [
  {
    name: 'idle TTL made too aggressive for WAN use',
    source: 'const INCOMING_TRANSFER_IDLE_TTL_SECS: u64 = 120;',
    replacement: 'const INCOMING_TRANSFER_IDLE_TTL_SECS: u64 = 20;',
    expected: 'WAN-safe bound',
  },
  {
    name: 'file request timeout shorter than receive lease',
    source: 'let rr_cfg =\n                request_response::Config::default().with_request_timeout(Duration::from_secs(300));',
    replacement: 'let rr_cfg =\n                request_response::Config::default().with_request_timeout(Duration::from_secs(60));',
    expected: 'must not be shorter',
  },
  {
    name: 'pending offer retains original response channel',
    source: 'created_at: Instant,\n}',
    replacement: 'created_at: Instant,\n    channel: request_response::ResponseChannel<FileResponse>,\n}',
    expected: 'must not retain a libp2p ResponseChannel',
  },
  {
    name: 'immediate pending acknowledgement removed',
    source: '.send_response(channel, FileResponse::Pending)',
    replacement: '.send_response(channel, FileResponse::Accepted)',
    expected: 'close the initial request stream immediately with Pending',
  },
  {
    name: 'separate accept control request removed',
    source: 'FileRequest::Accept { transfer_id: transfer_id.clone() }',
    replacement: 'FileRequest::Cancel { transfer_id: transfer_id.clone() }',
    expected: 'separate authenticated Accept control request',
  },
  {
    name: 'separate reject control request removed',
    source: 'FileRequest::Reject {',
    replacement: 'FileRequest::Cancel { /* Reject accidentally removed */',
    expected: 'separate authenticated Reject control request',
  },
  {
    name: 'zero-byte chunk rejection removed',
    source: 'if data.is_empty() {',
    replacement: 'if data.len() == usize::MAX {',
    expected: 'chunk liveness ordering',
  },
  {
    name: 'successful chunk no longer refreshes lease',
    source: 'transfer.last_activity = Instant::now();',
    replacement: '/* liveness refresh accidentally removed */',
    expected: 'chunk liveness ordering',
  },
  {
    name: 'invalid peer traffic refreshes lease',
    source: 'if transfer.peer != peer {',
    replacement: 'if transfer.peer != peer {\n                                                    transfer.last_activity = Instant::now();',
    expected: 'exactly once',
  },
  {
    name: 'late Complete no longer fails closed',
    source: 'FileResponse::Error { message: "Transfer nie istnieje.".into() }',
    replacement: 'FileResponse::Complete { verified: true, path: None }',
    expected: 'completion must authenticate ownership and fail closed',
  },
  {
    name: 'completion sender-identity gate removed',
    source: 'let response = if sender_mismatch {',
    replacement: 'let response = if false && sender_mismatch {',
    expected: 'completion must authenticate ownership and fail closed',
  },
  {
    name: 'late Cancel no longer fails closed',
    source: 'FileResponse::Error { message: "Transfer not found for requesting peer.".into() }',
    replacement: 'FileResponse::Ack { received: 0 }',
    expected: 'late or unrelated Cancel must fail closed',
  },
  {
    name: 'cancel accepted-state peer ownership inverted',
    source: 'let incoming_matches = incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);',
    replacement: 'let incoming_matches = incoming.get(&transfer_id).map(|transfer| transfer.peer != peer).unwrap_or(false);',
    expected: 'cancel must authenticate accepted-transfer ownership',
  },
  {
    name: 'disconnect cleanup no longer waits for final connection',
    source: 'if num_established == 0 {',
    replacement: 'if true {',
    expected: 'final connection closes',
  },
  {
    name: 'pending cleanup crosses peer ownership boundary',
    source: '.filter(|(_, offer)| offer.peer == remote)',
    replacement: '.filter(|(_, offer)| offer.peer != remote)',
    expected: 'only pending offers owned',
  },
  {
    name: 'accepted cleanup crosses peer ownership boundary',
    source: '.filter(|(_, transfer)| transfer.peer == remote)',
    replacement: '.filter(|(_, transfer)| transfer.peer != remote)',
    expected: 'only accepted transfers owned',
  },
  {
    name: 'outgoing cleanup crosses peer ownership boundary',
    source: '.filter(|(_, candidate)| candidate.peer == remote)',
    replacement: '.filter(|(_, candidate)| candidate.peer != remote)',
    expected: 'only outgoing transfers owned',
  },
  {
    name: 'outgoing request metadata pruning removed',
    source: 'outbound_requests.retain(|_, meta| !outgoing_from_peer.contains(&meta.transfer_id));',
    replacement: '/* outgoing request metadata pruning accidentally removed */',
    expected: 'prune only request metadata',
  },
  {
    name: 'outgoing request metadata pruning predicate inverted',
    source: 'outbound_requests.retain(|_, meta| !outgoing_from_peer.contains(&meta.transfer_id));',
    replacement: 'outbound_requests.retain(|_, meta| outgoing_from_peer.contains(&meta.transfer_id));',
    expected: 'prune only request metadata',
  },
  {
    name: 'disconnect cleanup globally clears request metadata',
    source: 'outbound_requests.retain(|_, meta| !outgoing_from_peer.contains(&meta.transfer_id));',
    replacement: 'outbound_requests.clear();',
    expected: 'prune only request metadata',
  },
  {
    name: 'outgoing disconnect terminal failure becomes ambiguous',
    source: '"Peer disconnected before the outgoing file transfer completed."',
    replacement: '"Peer disconnected."',
    expected: 'deterministic failed outgoing-transfer state',
  },
  {
    name: 'periodic accepted-transfer expiry disabled',
    source: 'incoming_transfer_is_expired(transfer.last_activity, now)',
    replacement: 'false /* expiry accidentally disabled */',
    expected: 'periodic cleanup',
  },
];

for (const testCase of cases) {
  const mutated = mutateOnce(source, testCase.source, testCase.replacement);
  const result = run(mutated);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the file-transfer liveness checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected output containing '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`File-transfer liveness adversarial policy tests passed (${cases.length} mutations rejected plus scoped direct-chat timeout control).`);
