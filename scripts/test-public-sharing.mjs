import fs from 'node:fs';

const rust = fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n');
const frontend = fs.readFileSync('src/main.ts', 'utf8').replaceAll('\r\n', '\n');
const relay = fs.readFileSync('src/world-relay.ts', 'utf8').replaceAll('\r\n', '\n');
const rtc = fs.readFileSync('src/rtc-config.ts', 'utf8').replaceAll('\r\n', '\n');

const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`Public-sharing contract missing: ${label}`);
};

for (const [needle, label] of [
  ['struct PublicShareOffer {', 'bounded metadata offer type'],
  ['sha256: String,', 'signed offer integrity metadata'],
  ['PublicFileOffer(PublicShareOffer)', 'authenticated GossipSub offer event'],
  ['ClaimPublic {', 'explicit on-demand claim request'],
  ['public_offer_id: Option<String>', 'claim binding on transfer state'],
  ['preview_only: bool', 'preview/download intent binding'],
  ['MAX_PUBLIC_IMAGE_SIZE: u64 = 8 * 1024 * 1024', 'bounded image preview size'],
  ['fn image_mime_from_header', 'image magic-byte validation'],
  ['probe_image_mime(&path).await?', 'automatic image recognition from bytes'],
  ['async fn prepare_public_rtc_file(', 'one-use direct WebRTC descriptor for a WORLD claim'],
  ['let directory = if preview_only {', 'temporary direct preview destination'],
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
  ["worldRelay.publishPublicFile(offer)", 'signed WAN metadata announcement'],
  ["action: 'public_file_request'", 'recipient-addressed WAN claim'],
  ["invoke<RtcFileDescriptor>('prepare_public_rtc_file'", 'sender-side prepared direct transfer'],
  ["peerTransport.acceptFile(offer.token, pending.intent === 'preview')", 'automatic consent-bound direct receive after explicit claim'],
  ["await invoke('claim_public_file', { offerId, previewOnly: intent === 'preview' })", 'explicit download/preview claim'],
  ["await invoke<string>('load_image_preview'", 'post-transfer image preview'],
  ["previewOnly: Boolean(event.payload.preview_only)", 'preview cache load intent'],
  ["data-public-download", 'Download control'],
  ["data-public-preview", 'Preview control'],
  ["listen<PublicShareOffer>('public-file-offer'", 'incoming metadata listener'],
  ["const placeholderId = `claim:${offerId}`;", 'receiver-side claim placeholder'],
  ["status: 'requesting'", 'visible receiver negotiation state'],
  ["action: 'public_file_reject'", 'encrypted sender-side failure response'],
  ['PUBLIC_CLAIM_TIMEOUT_MS = 45_000', 'bounded receiver claim timeout'],
  ["failPublicClaim(transferToken, t('publicShare.timeout'))", 'visible timeout cleanup'],
  ["state.transfers.delete(`claim:${event.payload.public_offer_id}`);", 'claim placeholder reconciliation'],
]) requireText(frontend, needle, label);

for (const [needle, label] of [
  ["type: 'public_file'", 'signed public file payload'],
  ['onPublicFile?(offer: RelayPublicFileOffer)', 'WAN offer callback'],
  ['publishPublicFile(offer: RelayPublicFileOffer)', 'WAN announcement API'],
  ["type: 'rtc_signal'", 'encrypted direct claim signaling envelope'],
  ["'public_file_reject'", 'validated encrypted claim rejection'],
]) requireText(relay, needle, label);

for (const [needle, label] of [
  ['stun:stun.cloudflare.com:3478', 'primary STUN discovery'],
  ['stun:stun.l.google.com:19302', 'independent STUN discovery'],
  ['iceCandidatePoolSize: 1', 'bounded ICE candidate pool'],
  ["iceTransportPolicy: 'all'", 'direct path remains preferred'],
]) requireText(rtc, needle, label);

if (rtc.includes('openrelay.metered.ca') || rtc.includes("username: 'openrelayproject'")) {
  throw new Error('Retired anonymous Open Relay credentials must not be presented as a working WAN fallback.');
}

if (frontend.includes('id="shareWorldImage"') || frontend.includes("sharePublic('image'")) {
  throw new Error('The separate Share image action must be removed; the file picker auto-detects supported images.');
}

const listenerStart = frontend.indexOf("listen<PublicShareOffer>('public-file-offer'");
const listenerEnd = frontend.indexOf("listen<{ offer_id: string }>('public-offer-expired'", listenerStart);
const listener = frontend.slice(listenerStart, listenerEnd);
if (listener.includes("claim_public_file") || listener.includes('claimPublicOffer(')) {
  throw new Error('Receiving a #WORLD announcement must not automatically download the file.');
}

const previewStart = frontend.indexOf('function showImagePreview(');
const claimStart = frontend.indexOf('async function claimPublicOffer(');
if (previewStart < 0 || claimStart < 0) throw new Error('Public sharing functions are missing.');

const shareStart = frontend.indexOf('async function sharePublic(');
const shareEnd = frontend.indexOf('async function claimPublicOffer(', shareStart);
const shareBody = frontend.slice(shareStart, shareEnd);
if (shareBody.includes('worldRelayState.connected > 0')) {
  throw new Error('WORLD file announcements must enter the relay queue during a temporary disconnect.');
}
requireText(shareBody, 'relayPublishError', 'visible public announcement failure instead of a swallowed relay error');
requireText(frontend, 'stored = existing', 'public offer card restoration after bounded history trimming');
requireText(frontend, 'beforeMicrophoneCapture() {\n      groupVoice.leaveWorld();\n      groupVoice.leaveRoom();', 'private audio releases group microphone ownership');
requireText(frontend, 'beforeMicrophoneCapture() { peerTransport.hangupAllCalls(); }', 'group audio releases private microphone ownership');

const relayPresenceStart = frontend.indexOf('onPresence(peer: RelayPeer)');
const relayPresenceEnd = frontend.indexOf('onOffline(peerId: string)', relayPresenceStart);
const relayPresence = frontend.slice(relayPresenceStart, relayPresenceEnd);
const relayAudioOnline = relayPresence.indexOf('groupVoice.peerOnline(peer.peer_id)');
const nativeDuplicateGuard = relayPresence.indexOf('if (state.peers.has(peer.claimed_peer_id))');
if (relayPresenceStart < 0 || relayPresenceEnd < 0 || relayAudioOnline < 0
  || nativeDuplicateGuard < 0 || relayAudioOnline > nativeDuplicateGuard) {
  throw new Error('Relay media presence must reach group voice before hiding a duplicate native peer from the people list.');
}

console.log('Public sharing contract passed: metadata-only announcements, explicit claims, temporary verified previews and persistent explicit downloads.');
