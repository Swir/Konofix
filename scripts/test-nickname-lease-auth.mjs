import fs from 'node:fs';
import { checkNicknameLeasePolicy } from './check-nickname-lease-auth.mjs';

const source = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');
const baseline = checkNicknameLeasePolicy(source, packageJson);
if (baseline.length) throw new Error(`baseline nickname lease policy failed: ${baseline.join('; ')}`);

const mutations = [
  ['signature verification', source.replace('envelope.verify(NICK_LEASE_DOMAIN.to_string())', 'true')],
  ['claimed identity binding', source.replace('signing_key.to_peer_id() == claimed_peer', 'true')],
  ['DHT key binding', source.replace('key != &nick_record_key(&lease.canonical)', 'false')],
  ['future lifetime bound', source.replace('lease.expires_at > maximum_expiry', 'false')],
];
for (const [label, mutated] of mutations) {
  if (mutated === source) throw new Error(`${label}: mutation did not apply`);
  if (checkNicknameLeasePolicy(mutated, packageJson).length === 0) throw new Error(`${label}: policy checker accepted adversarial mutation`);
}
const pkg = JSON.parse(packageJson);
pkg.scripts.audit = pkg.scripts.audit
  .replace('node scripts/test-nickname-lease-auth.mjs && ', '')
  .replace('node scripts/check-nickname-lease-auth.mjs && ', '');
if (checkNicknameLeasePolicy(source, JSON.stringify(pkg)).length === 0) throw new Error('audit wiring: checker accepted removed nickname-lease gates');
console.log('Nickname lease authentication adversarial policy tests: PASS.');
