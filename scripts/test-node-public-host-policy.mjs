import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicy } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeSource = fs.readFileSync(path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs'), 'utf8');
const linuxInstallerSource = fs.readFileSync(path.join(ROOT, 'scripts/install-public-node-linux.sh'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(node, linux, pattern) {
  const errors = checkNodePublicHostPolicy(node, linux);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicy(nodeSource, linuxInstallerSource), []);

expectFailure(
  mutateOnce(nodeSource, '"--allow-private-address" =>', '"--private-lab-disabled" =>', 'raw Node lab flag parser'),
  linuxInstallerSource,
  /parse --allow-private-address/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    'a == 100 && (64..=127).contains(&b)',
    'a == 100 && (65..=127).contains(&b)',
    'CGNAT lower boundary',
  ),
  linuxInstallerSource,
  /CGNAT/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    'segments[0] == 0x3fff && segments[1] & 0xf000 == 0x0000',
    'segments[0] == 0x3ffe && segments[1] & 0xf000 == 0x0000',
    'RFC 9637 documentation prefix',
  ),
  linuxInstallerSource,
  /3fff/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    'not globally routable under the Konofix public-node evidence policy',
    'may not be reachable from the public Internet',
    'fail-closed literal error',
  ),
  linuxInstallerSource,
  /fail closed/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    'validate_public_host(host, args.allow_private_address)',
    'Ok(false)',
    'pre-side-effect validation call',
  ),
  linuxInstallerSource,
  /before identity creation/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    '=== KONOFIX LAB-ONLY ADDRESSES ===',
    '=== KONOFIX ADDRESSES ===',
    'lab-only output banner',
  ),
  linuxInstallerSource,
  /LAB-ONLY/i,
);

expectFailure(
  nodeSource,
  mutateOnce(
    linuxInstallerSource,
    '--public-host ${PUBLIC_HOST}${NODE_ADDRESS_OVERRIDE}',
    '--public-host ${PUBLIC_HOST}',
    'systemd lab override propagation',
  ),
  /ExecStart|override/i,
);

expectFailure(
  nodeSource,
  mutateOnce(linuxInstallerSource, '"3fff::/20"', '"3ffe::/20"', 'Linux RFC 9637 range'),
  /RFC 9637|3fff/i,
);

console.log('Node public-host adversarial policy tests: PASS');
