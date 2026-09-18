import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicy } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeSource = fs.readFileSync(path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs'), 'utf8');
const linuxInstallerSource = fs.readFileSync(path.join(ROOT, 'scripts/install-public-node-linux.sh'), 'utf8');
const windowsLauncherSource = fs.readFileSync(path.join(ROOT, 'scripts/public-node.ps1'), 'utf8');
const internetTestSource = fs.readFileSync(path.join(ROOT, 'scripts/internet-test.ps1'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(node, linux, windows, internet, pattern) {
  const errors = checkNodePublicHostPolicy(node, linux, windows, internet);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicy(nodeSource, linuxInstallerSource, windowsLauncherSource, internetTestSource), []);

expectFailure(
  mutateOnce(nodeSource, '"--allow-private-address" =>', '"--private-lab-disabled" =>', 'raw Node lab flag parser'),
  linuxInstallerSource,
  windowsLauncherSource,
  internetTestSource,
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
  windowsLauncherSource,
  internetTestSource,
  /CGNAT/i,
);

expectFailure(
  mutateOnce(
    nodeSource,
    'segments[0] == 0x3fff && segments[1] & 0xf000 == 0x0000',
    'segments[0] == 0x3ffe && segments[1] & 0xf000 == 0x0000',
    'raw Node RFC 9637 documentation prefix',
  ),
  linuxInstallerSource,
  windowsLauncherSource,
  internetTestSource,
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
  windowsLauncherSource,
  internetTestSource,
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
  windowsLauncherSource,
  internetTestSource,
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
  windowsLauncherSource,
  internetTestSource,
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
  windowsLauncherSource,
  internetTestSource,
  /ExecStart|override/i,
);

expectFailure(
  nodeSource,
  mutateOnce(linuxInstallerSource, '"3fff::/20"', '"3ffe::/20"', 'Linux RFC 9637 range'),
  windowsLauncherSource,
  internetTestSource,
  /RFC 9637|3fff/i,
);

expectFailure(
  nodeSource,
  linuxInstallerSource,
  mutateOnce(windowsLauncherSource, "@('3fff::', 20)", "@('3ffe::', 20)", 'Windows RFC 9637 range'),
  internetTestSource,
  /Windows public-Node launcher|RFC 9637|3fff/i,
);

expectFailure(
  nodeSource,
  linuxInstallerSource,
  windowsLauncherSource,
  mutateOnce(internetTestSource, "@('3fff::', 20)", "@('3ffe::', 20)", 'Internet-precheck RFC 9637 range'),
  /Internet evidence precheck|RFC 9637|3fff/i,
);

console.log('Node public-host adversarial policy tests: PASS');
