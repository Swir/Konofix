import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkNicknameLeasePolicy(source, packageJson) {
  const failures = [];
  const requireText = (needle, label) => {
    if (!source.includes(needle)) failures.push(label);
  };
  requireText('core::SignedEnvelope', 'libp2p SignedEnvelope import is missing');
  requireText('NICK_LEASE_DOMAIN', 'nickname lease domain separation is missing');
  requireText('NICK_LEASE_CLOCK_SKEW_SECS', 'bounded nickname lease clock skew is missing');
  requireText('envelope: Vec<u8>', 'wire/DHT nickname lease envelope is missing');
  requireText('SignedEnvelope::new(', 'nickname leases are not signed');
  requireText('SignedEnvelope::from_protobuf_encoding', 'nickname lease envelopes are not decoded');
  requireText('envelope.verify(NICK_LEASE_DOMAIN.to_string())', 'nickname lease signature verification is missing');
  requireText('payload_and_signing_key(', 'nickname lease payload/signing-key binding is missing');
  requireText('signing_key.to_peer_id() == claimed_peer', 'signature identity is not bound to claimed Peer ID');
  requireText('key != &nick_record_key(&lease.canonical)', 'DHT nickname key is not bound to the canonical nickname');
  requireText('lease.expires_at > maximum_expiry', 'nickname lease future lifetime is not bounded');
  requireText('record_publisher.is_some_and(|publisher| publisher != &claimed_peer)', 'DHT publisher mismatch is not rejected');
  if (!/GetRecord\(Ok\(GetRecordOk::FoundRecord\(peer_record\)\)\)[\s\S]{0,900}verify_nick_lease\([\s\S]{0,500}check_nick_conflict/.test(source)) failures.push('DHT nickname conflicts are not gated by lease authentication');
  if (!source.includes('WireEvent::NickClaim') || !source.includes('verify_nick_lease(&lease, None, None, now_ms())')) failures.push('GossipSub nickname claims do not share authenticated lease validation');
  const pkg = JSON.parse(packageJson);
  const audit = pkg.scripts?.audit ?? '';
  if (!audit.includes('test-nickname-lease-auth.mjs') || !audit.includes('check-nickname-lease-auth.mjs')) failures.push('npm run audit does not enforce nickname lease policy and adversarial tests');
  return failures;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const source = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
  const packageJson = fs.readFileSync('package.json', 'utf8');
  const failures = checkNicknameLeasePolicy(source, packageJson);
  if (failures.length) {
    for (const failure of failures) console.error(`NICK LEASE POLICY ERROR: ${failure}`);
    process.exit(1);
  }
  console.log('Nickname lease authentication policy: verified.');
}
