import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublicHostPolicySource } from './check-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs');
const source = fs.readFileSync(SOURCE_PATH, 'utf8').replaceAll('\r\n', '\n');

const baseline = checkPublicHostPolicySource(source);
if (baseline.length > 0) {
  console.error('PUBLIC HOST POLICY TEST ERROR: baseline source already violates policy.');
  for (const error of baseline) console.error(`  ${error}`);
  process.exit(1);
}

const mutations = [
  {
    name: 'remove CGNAT range',
    find: '(Ipv4Addr::new(100, 64, 0, 0), 10),',
    replace: '',
  },
  {
    name: 'remove IPv4 benchmarking range',
    find: '(Ipv4Addr::new(198, 18, 0, 0), 15),',
    replace: '',
  },
  {
    name: 'remove IPv6 documentation range',
    find: '(Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32),',
    replace: '',
  },
  {
    name: 'restore warning-only behavior',
    find: 'validate_public_host(host, args.allow_private_address)',
    replace: 'Ok(false)',
  },
  {
    name: 'erase explicit lab flag parser',
    find: '"--allow-private-address" => {\n                allow_private_address = true;\n            }',
    replace: '"--allow-private-address" => {}',
  },
  {
    name: 'erase lab-only evidence warning',
    find: 'These addresses are NOT valid public-node or cross-country test evidence.',
    replace: 'These addresses can be shared.',
  },
  {
    name: 'erase DNS reachability disclaimer',
    find: 'DNS NOTE: this output confirms syntax only; DNS resolution and Internet reachability must still be verified externally.',
    replace: 'DNS ready.',
  },
];

let rejected = 0;
for (const mutation of mutations) {
  if (!source.includes(mutation.find)) {
    console.error(`PUBLIC HOST POLICY TEST ERROR: mutation did not match baseline: ${mutation.name}`);
    process.exit(1);
  }
  const mutated = source.replace(mutation.find, mutation.replace);
  if (mutated === source) {
    console.error(`PUBLIC HOST POLICY TEST ERROR: mutation was a no-op: ${mutation.name}`);
    process.exit(1);
  }
  const errors = checkPublicHostPolicySource(mutated);
  if (errors.length === 0) {
    console.error(`PUBLIC HOST POLICY TEST ERROR: checker accepted adversarial mutation: ${mutation.name}`);
    process.exit(1);
  }
  rejected += 1;
}

console.log(`Public-host policy adversarial tests: PASS (${rejected}/${mutations.length} rejected)`);
