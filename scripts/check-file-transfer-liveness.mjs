import fs from 'node:fs';

const sourcePath = process.argv[2] ?? 'src-tauri/src/lib.rs';
const text = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`FILE TRANSFER LIVENESS ERROR: ${message}`);
  process.exitCode = 1;
};

const requireText = (needle, message) => {
  if (!text.includes(needle)) fail(message);
};

const requireOrdered = (markers, message) => {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    if (next < 0 || next <= cursor) {
      fail(`${message} Missing/out-of-order marker: ${marker}`);
      return;
    }
    cursor = next;
  }
};

const ttlMatch = text.match(/const INCOMING_TRANSFER_IDLE_TTL_SECS: u64 = (\d+);/);
if (!ttlMatch) {
  fail('accepted-transfer idle TTL constant is missing.');
} else {
  const ttl = Number(ttlMatch[1]);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 300) {
    fail(`accepted-transfer idle TTL must stay within the reviewed 60..300 second WAN-safe bound; found ${ttl}.`);
  }

  const timeoutMatch = text.match(/with_request_timeout\(Duration::from_secs\((\d+)\)\)/);
  if (!timeoutMatch) {
    fail('libp2p request/response timeout must remain explicit.');
  } else {
    const requestTimeout = Number(timeoutMatch[1]);
    if (requestTimeout < ttl) {
      fail(`request/response timeout (${requestTimeout}s) must not be shorter than accepted-transfer idle TTL (${ttl}s).`);
    }
    if (requestTimeout > 300) {
      fail(`request/response timeout must remain bounded at 300 seconds or less; found ${requestTimeout}s.`);
    }
  }
}

requireText('const FILE_CHUNK_SIZE: usize = 256 * 1024;', 'file chunk budget must remain the reviewed 256 KiB.');
requireText('last_activity: Instant,', 'IncomingTransfer must store a monotonic last_activity timestamp.');
requireText('last_activity: Instant::now(),', 'accepted transfers must initialize their liveness lease at acceptance.');
requireText('fn incoming_transfer_is_expired(last_activity: Instant, now: Instant) -> bool {', 'accepted-transfer expiry helper is missing.');
requireText('now.saturating_duration_since(last_activity)', 'accepted-transfer expiry must use monotonic saturating duration arithmetic.');
requireText('>= Duration::from_secs(INCOMING_TRANSFER_IDLE_TTL_SECS)', 'accepted-transfer expiry must enforce the configured idle TTL boundary.');

const chunkStart = text.indexOf('FileRequest::Chunk { transfer_id, offset, data } => {');
if (chunkStart < 0) {
  fail('file chunk request handler is missing.');
} else {
  const chunkEnd = text.indexOf('FileRequest::Complete { transfer_id, sha256 } => {', chunkStart);
  const chunk = text.slice(chunkStart, chunkEnd > chunkStart ? chunkEnd : chunkStart + 9000);
  const markers = [
    'if data.is_empty() {',
    '} else if data.len() > FILE_CHUNK_SIZE {',
    'incoming.get_mut(&transfer_id)',
    'if transfer.peer != peer {',
    'transfer.file.write_all(&data).await',
    'Ok(()) => {',
    'transfer.hasher.update(&data);',
    'transfer.received += data.len() as u64;',
    'transfer.last_activity = Instant::now();',
  ];
  let cursor = -1;
  for (const marker of markers) {
    const next = chunk.indexOf(marker, cursor + 1);
    if (next < 0 || next <= cursor) {
      fail(`chunk liveness ordering is unsafe or incomplete. Missing/out-of-order marker: ${marker}`);
      break;
    }
    cursor = next;
  }

  const refreshes = [...chunk.matchAll(/transfer\.last_activity\s*=\s*Instant::now\(\);/g)].length;
  if (refreshes !== 1) {
    fail(`chunk handler must refresh last_activity exactly once, only after a successful write; found ${refreshes} refresh assignments.`);
  }
}

const completeStart = text.indexOf('FileRequest::Complete { transfer_id, sha256 } => {');
if (completeStart < 0) {
  fail('file completion request handler is missing.');
} else {
  const completeEnd = text.indexOf('FileRequest::Cancel { transfer_id } => {', completeStart);
  const complete = text.slice(completeStart, completeEnd > completeStart ? completeEnd : completeStart + 12000);
  const markers = [
    'let sender_mismatch = incoming',
    '.map(|transfer| transfer.peer != peer)',
    'let response = if sender_mismatch {',
    '} else if !hash_format_valid {',
    '} else if let Some(mut transfer) = incoming.remove(&transfer_id) {',
    'FileResponse::Error { message: "Transfer nie istnieje.".into() }',
  ];
  let cursor = -1;
  for (const marker of markers) {
    const next = complete.indexOf(marker, cursor + 1);
    if (next < 0 || next <= cursor) {
      fail(`completion must authenticate ownership and fail closed for expired/unknown transfer state. Missing/out-of-order marker: ${marker}`);
      break;
    }
    cursor = next;
  }
  if (complete.includes('incoming.insert(')) {
    fail('late Complete handling must never recreate incoming transfer state.');
  }
}

const cancelStart = text.indexOf('FileRequest::Cancel { transfer_id } => {');
if (cancelStart < 0) {
  fail('file cancellation request handler is missing.');
} else {
  const cancelEnd = text.indexOf('request_response::Message::Response', cancelStart);
  const cancel = text.slice(cancelStart, cancelEnd > cancelStart ? cancelEnd : cancelStart + 8000);
  for (const [needle, message] of [
    ['let pending_matches = pending_incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);', 'cancel must authenticate pending-offer ownership before removal.'],
    ['let incoming_matches = incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);', 'cancel must authenticate accepted-transfer ownership before removal.'],
    ['let outgoing_matches = outgoing.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);', 'cancel must authenticate outgoing-transfer ownership before removal.'],
    ['let matched = pending_matches || incoming_matches || outgoing_matches;', 'cancel must track whether any peer-owned state matched.'],
    ['FileResponse::Error { message: "Transfer not found for requesting peer.".into() }', 'late or unrelated Cancel must fail closed without deleting unrelated state.'],
  ]) {
    if (!cancel.includes(needle)) fail(message);
  }
}

requireOrdered([
  'let expired_incoming: Vec<String> = incoming',
  'incoming_transfer_is_expired(transfer.last_activity, now)',
  'for transfer_id in expired_incoming {',
  'if let Some(transfer) = incoming.remove(&transfer_id) {',
  'let temp_path = transfer.temp_path.clone();',
  'tokio::fs::remove_file(&temp_path).await',
], 'periodic cleanup must reclaim stalled incoming transfers and remove only their owned temp path.');

const connectionStart = text.indexOf('SwarmEvent::ConnectionClosed { peer_id: remote, num_established, .. } => {');
if (connectionStart < 0) {
  fail('ConnectionClosed handler is missing.');
} else {
  const nextEvent = text.indexOf('SwarmEvent::', connectionStart + 20);
  const connection = text.slice(connectionStart, nextEvent > connectionStart ? nextEvent : connectionStart + 12000);
  for (const [needle, message] of [
    ['if num_established == 0 {', 'peer-owned transfer state must only be reclaimed after the final connection closes.'],
    ['.filter(|(_, offer)| offer.peer == remote)', 'disconnect cleanup must select only pending offers owned by the disconnected peer.'],
    ['pending_incoming.remove(&transfer_id)', 'disconnect cleanup must release selected pending offers.'],
    ['let incoming_from_peer: Vec<String> = incoming', 'disconnect cleanup must collect accepted transfers separately.'],
    ['.filter(|(_, transfer)| transfer.peer == remote)', 'disconnect cleanup must select only accepted transfers owned by the disconnected peer.'],
    ['incoming.remove(&transfer_id)', 'disconnect cleanup must release selected accepted transfers.'],
    ['tokio::fs::remove_file(&temp_path).await', 'disconnect cleanup must remove the reclaimed transfer-owned temp file.'],
    ['"Peer disconnected before the file transfer completed."', 'disconnect cleanup must emit deterministic failed receive-transfer state.'],
    ['let outgoing_from_peer: Vec<String> = outgoing', 'disconnect cleanup must collect outgoing transfers owned by the disconnected peer.'],
    ['.filter(|(_, candidate)| candidate.peer == remote)', 'disconnect cleanup must select only outgoing transfers owned by the disconnected peer.'],
    ['outbound_requests.retain(|_, meta| !outgoing_from_peer.contains(&meta.transfer_id));', 'disconnect cleanup must prune only request metadata belonging to reclaimed outgoing transfers.'],
    ['for transfer_id in outgoing_from_peer {', 'disconnect cleanup must reclaim each selected outgoing transfer.'],
    ['if let Some(transfer) = outgoing.remove(&transfer_id) {', 'disconnect cleanup must release selected outgoing transfer slots immediately.'],
    ['"Peer disconnected before the outgoing file transfer completed."', 'disconnect cleanup must emit deterministic failed outgoing-transfer state.'],
  ]) {
    if (!connection.includes(needle)) fail(message);
  }

  if (connection.includes('outbound_requests.clear()')) {
    fail('disconnect cleanup must never clear unrelated outbound request metadata.');
  }
}

if (!process.exitCode) {
  console.log('File-transfer liveness policy: bounded WAN-safe TTL, successful-write-only lease refresh, zero-byte rejection, fail-closed late Complete/Cancel handling, periodic reclamation, and peer-scoped incoming/outgoing disconnect cleanup with request-metadata pruning are enforced.');
}
