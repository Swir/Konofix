import fs from 'node:fs';

const rust = fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n');
const frontend = fs.readFileSync('src/main.ts', 'utf8').replaceAll('\r\n', '\n');

const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`Public-sharing contract missing: ${label}`);
};

for (const [needle, label] of [
  ['struct PublicShareOffer {', 'bounded metadata offer type'],
  ['PublicFileOffer(PublicShareOffer)', 'authenticated GossipSub offer event'],
  ['ClaimPublic {', 'explicit on-demand claim request'],
  ['public_offer_id: Option<String>', 'claim binding on transfer state'],
  ['preview_only: bool', 'preview/download intent binding'],
  ['MAX_PUBLIC_IMAGE_SIZE: u64 = 8 * 1024 * 1024', 'bounded image preview size'],
  ['fn image_mime_from_header', 'image magic-byte validation'],
  ['detect_image_mime(&offer.path).await?', 'image type revalidation at claim time'],
  ['claim_matches', 'receiver claim ownership check'],
  ['announcement_matches', 'receiver metadata continuity check'],
  ['preview_directory()', 'separate temporary preview cache'],
  ['tokio::fs::remove_file(&candidate)', 'temporary preview cleanup after loading'],
]) requireText(rust, needle, label);

const offerStart = rust.indexOf('struct PublicShareOffer {');
const offerEnd = rust.indexOf('\n}', offerStart);
const offerBody = rust.slice(offerStart, offerEnd);
for (const forbidden of ['Vec<u8>', 'data:', 'bytes:', 'content:']) {
  if (offerBody.includes(forbidden)) {
    throw new Error(`PublicShareOffer must remain metadata-only; found ${forbidden}`);
  }
}

for (const [needle, label] of [
  ["invoke<PublicShareOffer | null>('publish_public_file'", 'explicit publish action'],
  ["await invoke('claim_public_file', { offerId, previewOnly: intent === 'preview' })", 'explicit download/preview claim'],
  ["await invoke<string>('load_image_preview'", 'post-transfer image preview'],
  ["previewOnly: Boolean(event.payload.preview_only)", 'preview cache load intent'],
  ["data-public-download", 'Download control'],
  ["data-public-preview", 'Preview control'],
  ["listen<PublicShareOffer>('public-file-offer'", 'incoming metadata listener'],
  ["const placeholderId = `claim:${offerId}`;", 'receiver-side claim placeholder'],
  ["status: 'requesting'", 'visible receiver negotiation state'],
  ["state.transfers.delete(`claim:${event.payload.public_offer_id}`);", 'claim placeholder reconciliation'],
]) requireText(frontend, needle, label);

const listenerStart = frontend.indexOf("listen<PublicShareOffer>('public-file-offer'");
const listenerEnd = frontend.indexOf("listen<{ offer_id: string }>('public-offer-expired'", listenerStart);
const listener = frontend.slice(listenerStart, listenerEnd);
if (listener.includes("claim_public_file") || listener.includes('claimPublicOffer(')) {
  throw new Error('Receiving a #WORLD announcement must not automatically download the file.');
}

const previewStart = frontend.indexOf('function showImagePreview(');
const claimStart = frontend.indexOf('async function claimPublicOffer(');
if (previewStart < 0 || claimStart < 0) throw new Error('Public sharing functions are missing.');

console.log('Public sharing contract passed: metadata-only announcements, explicit claims, temporary verified previews and persistent explicit downloads.');
