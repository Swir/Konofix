import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const write = (path, text) => fs.writeFileSync(path, text.replaceAll('\r\n', '\n'), 'utf8');
const fail = message => { throw new Error(message); };

function replaceOnce(path, before, after, label) {
  const text = read(path);
  const count = text.split(before).length - 1;
  if (count !== 1) fail(`${label}: expected exactly one source anchor in ${path}, found ${count}.`);
  write(path, text.replace(before, after));
}

function insertAfterMatchingLine(path, needle, newLine, dedupeNeedle, label) {
  const text = read(path);
  if (text.includes(dedupeNeedle)) return;
  const lines = text.split('\n');
  const matches = lines.map((line, index) => line.includes(needle) ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) fail(`${label}: expected exactly one matching line in ${path}, found ${matches.length}.`);
  lines.splice(matches[0] + 1, 0, newLine);
  write(path, lines.join('\n'));
}

function insertAfterHeading(path, heading, line, dedupeNeedle, label) {
  const text = read(path);
  if (text.includes(dedupeNeedle)) return;
  const anchor = `${heading}\n\n`;
  const count = text.split(anchor).length - 1;
  if (count !== 1) fail(`${label}: expected exactly one heading anchor in ${path}, found ${count}.`);
  write(path, text.replace(anchor, `${anchor}${line}\n`));
}

// Backend: explicit cancellation must prune only stale metadata owned by this transfer.
replaceOnce(
  'src-tauri/src/lib.rs',
  `                    NetworkCommand::CancelFile { transfer_id, reply } => {\n                        let result = if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(`,
  `                    NetworkCommand::CancelFile { transfer_id, reply } => {\n                        let result = if let Some(transfer) = outgoing.remove(&transfer_id) {\n                            outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);\n                            let request_id = swarm.behaviour_mut().file_transfer.send_request(`,
  'local outgoing cancellation metadata pruning',
);

replaceOnce(
  'src-tauri/src/lib.rs',
  `                                            if pending_matches { pending_incoming.remove(&transfer_id); }`,
  `                                            if pending_matches {\n                                                pending_incoming.remove(&transfer_id);\n                                                let _ = app.emit(\n                                                    "file-offer-cancelled",\n                                                    serde_json::json!({\n                                                        "transfer_id": transfer_id.clone(),\n                                                        "peer_id": peer.to_string(),\n                                                    }),\n                                                );\n                                            }`,
  'authenticated pending-offer cancellation event',
);

replaceOnce(
  'src-tauri/src/lib.rs',
  `                                            if outgoing_matches {\n                                                if let Some(transfer) = outgoing.remove(&transfer_id) {`,
  `                                            if outgoing_matches {\n                                                outbound_requests.retain(|_, meta| meta.transfer_id != transfer_id);\n                                                if let Some(transfer) = outgoing.remove(&transfer_id) {`,
  'remote outgoing cancellation metadata pruning',
);

// Frontend: invalidate only the exact stale pending-offer modal.
replaceOnce(
  'src/main.ts',
  `type FileOfferExpired = { transfer_id: string; peer_id: string };\ntype FileTransfer = {`,
  `type FileOfferExpired = { transfer_id: string; peer_id: string };\ntype FileOfferCancelled = { transfer_id: string; peer_id: string };\ntype FileTransfer = {`,
  'frontend cancelled-offer payload type',
);

replaceOnce(
  'src/main.ts',
  `  await listen<FileOfferExpired>('file-offer-expired', event => {\n    const modal = document.querySelector(\`#file-offer-\${CSS.escape(event.payload.transfer_id)}\`);\n    if (!modal) return;\n    modal.remove();\n    if (state.connected) addSystem(state.room, t('transfer.offerExpired'));\n  });\n  await listen<FileTransfer>('file-transfer', event => {`,
  `  await listen<FileOfferExpired>('file-offer-expired', event => {\n    const modal = document.querySelector(\`#file-offer-\${CSS.escape(event.payload.transfer_id)}\`);\n    if (!modal) return;\n    modal.remove();\n    if (state.connected) addSystem(state.room, t('transfer.offerExpired'));\n  });\n  await listen<FileOfferCancelled>('file-offer-cancelled', event => {\n    const modal = document.querySelector(\`#file-offer-\${CSS.escape(event.payload.transfer_id)}\`);\n    if (!modal) return;\n    modal.remove();\n    if (state.connected) addSystem(state.room, t('transfer.offerCancelled'));\n  });\n  await listen<FileTransfer>('file-transfer', event => {`,
  'frontend cancelled-offer listener',
);

// Localization: explicit wording in every currently supported dictionary.
const localeInsertions = [
  ["'transfer.offerExpired': '⌛ Incoming file offer expired before it was accepted.',", "  'transfer.offerCancelled': '🚫 Incoming file offer was cancelled by the sender.',", 'EN'],
  ["'transfer.offerExpired': '⌛ Oferta przychodzącego pliku wygasła przed akceptacją.',", "  'transfer.offerCancelled': '🚫 Nadawca anulował ofertę przychodzącego pliku.',", 'PL'],
  ["'transfer.reject': 'Avvis', 'transfer.accept': 'Godta',", "  'transfer.offerCancelled': '🚫 Avsenderen avbrøt det innkommende filtilbudet.',", 'NO'],
  ["'transfer.failed': 'Fehler', 'transfer.completed': 'Fertig', 'common.cancel': 'Abbrechen',", "  'transfer.offerCancelled': '🚫 Der Absender hat das eingehende Dateiangebot abgebrochen.',", 'DE'],
  ["'transfer.failed': 'Erreur', 'transfer.completed': 'Terminé', 'common.cancel': 'Annuler',", "  'transfer.offerCancelled': '🚫 L’expéditeur a annulé l’offre de fichier entrante.',", 'FR'],
  ["'transfer.failed': 'Error', 'transfer.completed': 'Completado', 'common.cancel': 'Cancelar',", "  'transfer.offerCancelled': '🚫 El remitente canceló la oferta de archivo entrante.',", 'ES'],
  ["'transfer.failed': 'Помилка', 'transfer.completed': 'Готово', 'common.cancel': 'Скасувати',", "  'transfer.offerCancelled': '🚫 Відправник скасував пропозицію вхідного файлу.',", 'UK'],
];
let i18n = read('src/i18n.ts');
if (!i18n.includes("'transfer.offerCancelled':")) {
  for (const [anchor, line, locale] of localeInsertions) {
    const count = i18n.split(anchor).length - 1;
    if (count !== 1) fail(`localization ${locale}: expected one insertion anchor, found ${count}.`);
    i18n = i18n.replace(anchor, `${anchor}\n${line}`);
  }
  write('src/i18n.ts', i18n);
}

// Project audit: retain all current gates and add the new fail-closed cancellation gate.
let packageText = read('package.json');
if (!packageText.includes('test-file-cancel-convergence.mjs')) {
  const anchor = 'node scripts/test-file-transfer-liveness.mjs && node scripts/check-file-transfer-liveness.mjs &&';
  const replacement = `${anchor} node scripts/test-file-cancel-convergence.mjs && node scripts/check-file-cancel-convergence.mjs &&`;
  const count = packageText.split(anchor).length - 1;
  if (count !== 1) fail(`package audit anchor: expected one occurrence, found ${count}.`);
  packageText = packageText.replace(anchor, replacement);
  write('package.json', packageText);
}

const changelogBullet = '- converged explicit file-transfer cancellation across backend request bookkeeping and receiver UX: local outgoing cancel now prunes only stale same-transfer Offer/Chunk/Complete metadata before tracking the Cancel handshake, authenticated remote cancel applies the same scoped pruning, and sender-cancelled unanswered offers emit a transfer-specific UI event with dedicated messages in all seven supported locales; focused adversarial policy tests guard peer ownership, unrelated metadata, modal targeting and the independent TTL-expiry path without changing Real Internet Test credit,';
insertAfterHeading('CHANGELOG.md', '## 0.4.2', changelogBullet, 'converged explicit file-transfer cancellation across backend request bookkeeping', 'changelog cancellation entry');

const roadmapBullet = "- Explicit file-transfer cancellation now converges both backend bookkeeping and receiver UI: stale same-transfer outbound request metadata is pruned without touching unrelated transfers, the new Cancel handshake remains tracked, and an authenticated sender cancelling an unanswered offer closes only that transfer's modal with a dedicated localized message while the TTL-expiry path remains independent. Focused adversarial policy coverage guards these invariants; this resilience/UX hardening does not add Real Internet Test credit and the milestone remains 54/59.";
insertAfterMatchingLine('ROADMAP.md', 'Receive-side Windows filename hardening now neutralizes reserved device basenames', roadmapBullet, 'Explicit file-transfer cancellation now converges both backend bookkeeping', 'roadmap cancellation entry');

const securityBullet1 = '- Explicit sender cancellation now converges request bookkeeping immediately: cancelling an outgoing transfer drops only older Offer/Chunk/Complete metadata for that transfer before the new Cancel handshake is tracked, while an authenticated remote cancellation prunes only metadata belonging to its matching outgoing transfer. Late responses for pruned requests remain fail-closed and unrelated transfer metadata is preserved.';
const securityBullet2 = "- If an authenticated sender cancels an unanswered incoming offer, the backend removes only that peer-owned pending offer and emits a transfer-specific cancellation event. The desktop closes only that offer modal and shows a dedicated localized sender-cancelled message; the independent 45-second expiry path remains unchanged, and a wrong peer cannot dismiss another sender's offer.";
let security = read('docs/FILE_TRANSFER_SECURITY.md');
if (!security.includes('Explicit sender cancellation now converges request bookkeeping immediately')) {
  const lines = security.split('\n');
  const matches = lines.map((line, index) => line.includes('The same final-connection boundary now reclaims outgoing transfers') ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) fail(`security documentation insertion: expected one final-connection line, found ${matches.length}.`);
  lines.splice(matches[0] + 1, 0, securityBullet1, securityBullet2);
  security = lines.join('\n');
  const regressionAnchor = '\nSigned chat/presence/room events are separately bound to the authenticated GossipSub source identity.';
  const regressionText = '\nCancellation convergence is guarded by a fail-closed source-policy checker plus adversarial mutations covering local/remote same-transfer metadata pruning, authenticated peer ownership, transfer-specific pending-offer UI invalidation, independence of the existing TTL-expiry path, and explicit localization in every supported dictionary.\n';
  if (!security.includes(regressionAnchor)) fail('security regression anchor is missing.');
  security = security.replace(regressionAnchor, `${regressionText}${regressionAnchor}`);
  write('docs/FILE_TRANSFER_SECURITY.md', security);
}

console.log('Cancellation convergence patch applied cleanly on the current main-based tree.');
