import fs from 'node:fs';

const rustPath = process.argv[2] ?? 'src-tauri/src/lib.rs';
const frontendPath = process.argv[3] ?? 'src/main.ts';
const i18nPath = process.argv[4] ?? 'src/i18n.ts';
const read = (path) => fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const rust = read(rustPath);
const frontend = read(frontendPath);
const i18n = read(i18nPath);

const fail = (message) => {
  console.error(`FILE CANCEL CONVERGENCE ERROR: ${message}`);
  process.exitCode = 1;
};

const sliceBetween = (text, startMarker, endMarker, label) => {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    fail(`${label}: start marker is missing.`);
    return '';
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    fail(`${label}: end marker is missing.`);
    return text.slice(start);
  }
  return text.slice(start, end);
};

const requireOrdered = (text, markers, label) => {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    if (next < 0 || next <= cursor) {
      fail(`${label}: missing/out-of-order marker: ${marker}`);
      return;
    }
    cursor = next;
  }
};

const localCancel = sliceBetween(
  rust,
  'NetworkCommand::CancelFile { transfer_id, reply } => {',
  'NetworkCommand::Stop => {',
  'local cancel',
);
requireOrdered(localCancel, [
  'if let Some(transfer) = outgoing.remove(&transfer_id) {',
  'outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);',
  'FileRequest::Cancel { transfer_id: transfer_id.clone() }',
  'outbound_requests.insert(request_id, OutboundMeta { transfer_id: transfer_id.clone(), kind: OutboundKind::Cancel });',
], 'local cancel must prune stale same-transfer request metadata before tracking the cancel handshake');
if (localCancel.includes('outbound_requests.clear()')) {
  fail('local cancel must preserve unrelated outbound request metadata.');
}

const remoteCancel = sliceBetween(
  rust,
  'FileRequest::Cancel { transfer_id } => {',
  'request_response::Message::Response',
  'remote cancel',
);
requireOrdered(remoteCancel, [
  'let pending_matches = pending_incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);',
  'let incoming_matches = incoming.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);',
  'let outgoing_matches = outgoing.get(&transfer_id).map(|transfer| transfer.peer == peer).unwrap_or(false);',
  'if pending_matches {',
  'pending_incoming.remove(&transfer_id);',
  '"file-offer-cancelled",',
], 'authenticated pending-offer cancellation event must remain peer-owned and ordered after state removal');
requireOrdered(remoteCancel, [
  'if outgoing_matches {',
  'outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);',
  'if let Some(transfer) = outgoing.remove(&transfer_id) {',
], 'remote outgoing cancel must prune only authenticated same-transfer request metadata');
if (remoteCancel.includes('outbound_requests.clear()')) {
  fail('remote cancel must preserve unrelated outbound request metadata.');
}
if (!remoteCancel.includes('FileResponse::Error { message: "Transfer not found for requesting peer.".into() }')) {
  fail('wrong-peer or unknown remote cancellation must continue to fail closed.');
}

if (!frontend.includes("type FileOfferCancelled = { transfer_id: string; peer_id: string };")) {
  fail('frontend cancellation payload type is missing.');
}
const cancelledListener = sliceBetween(
  frontend,
  "await listen<FileOfferCancelled>('file-offer-cancelled', event => {",
  "await listen<FileTransfer>('file-transfer', event => {",
  'frontend cancelled-offer listener',
);
requireOrdered(cancelledListener, [
  'document.querySelector(`#file-offer-${CSS.escape(event.payload.transfer_id)}`)',
  'if (!modal) return;',
  'modal.remove();',
  "t('transfer.offerCancelled')",
], 'sender cancellation must close only its transfer-specific modal and show the dedicated localized message');
if (!frontend.includes("await listen<FileOfferExpired>('file-offer-expired', event => {")) {
  fail('offer TTL expiry listener must remain independent from sender cancellation.');
}

const dictionaryBlock = (name) => {
  const start = i18n.indexOf(`const ${name}`);
  if (start < 0) return '';
  const end = i18n.indexOf('\n};', start);
  return end < 0 ? '' : i18n.slice(start, end);
};
const locales = ['EN', 'PL', 'NO', 'DE', 'FR', 'ES', 'UK'];
for (const locale of locales) {
  if (!dictionaryBlock(locale).includes("'transfer.offerCancelled':")) {
    fail(`locale ${locale} is missing transfer.offerCancelled.`);
  }
}
const keyCount = [...i18n.matchAll(/'transfer\.offerCancelled':/g)].length;
if (keyCount !== locales.length) {
  fail(`transfer.offerCancelled must be explicitly present in all ${locales.length} supported dictionaries; found ${keyCount}.`);
}

if (!process.exitCode) {
  console.log('File cancellation convergence policy: local/remote request metadata pruning, authenticated pending-offer UI invalidation, independent TTL expiry, and seven-locale messaging are enforced.');
}
