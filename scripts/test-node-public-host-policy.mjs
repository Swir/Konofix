import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicySources } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const baseline = {
  nodeSource: read('src-tauri/src/bin/konofix-node.rs'),
  windowsLauncher: read('scripts/public-node.ps1'),
  windowsLauncherTest: read('scripts/test-public-node.ps1'),
  linuxInstaller: read('scripts/install-public-node-linux.sh'),
  linuxInstallerTest: read('scripts/test-public-node-linux.sh'),
  runtimeSmoke: read('scripts/test-node-runtime.ps1'),
  packageJson: read('package.json'),
};

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(changes, pattern) {
  const errors = checkNodePublicHostPolicySources({ ...baseline, ...changes });
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicySources(baseline), []);

expectFailure(
  { nodeSource: mutateOnce(baseline.nodeSource, '"100.64.0.1"', '"100.63.255.255"', 'CGNAT IPv4 regression fixture') },
  /100\.64\.0\.1/,
);

expectFailure(
  {
    nodeSource: mutateOnce(
      baseline.nodeSource,
      '(a == 100 && (64..=127).contains(&b))',
      '(a == 100 && (65..=127).contains(&b))',
      'CGNAT classifier range',
    ),
  },
  /CGNAT classification/i,
);

expectFailure(
  {
    nodeSource: mutateOnce(
      baseline.nodeSource,
      'segments[0] & 0xe000 != 0x2000',
      'segments[0] & 0xf000 != 0x2000',
      'IPv6 global-unicast boundary',
    ),
  },
  /IPv6 global-unicast boundary/i,
);

expectFailure(
  { nodeSource: mutateOnce(baseline.nodeSource, 'allow_private_address: bool', 'lab_mode: bool', 'Node lab flag field') },
  /allow_private_address/,
);

expectFailure(
  { nodeSource: mutateOnce(baseline.nodeSource, 'let public_host_policy =', 'let unverified_public_host_policy =', 'pre-side-effect policy binding') },
  /before identity creation/i,
);

expectFailure(
  { windowsLauncher: mutateOnce(baseline.windowsLauncher, "$nodeArgs += '--allow-private-address'", "$nodeArgs += '--unsafe-lab-address'", 'Windows lab propagation') },
  /Windows public-node launcher/i,
);

expectFailure(
  { linuxInstaller: mutateOnce(baseline.linuxInstaller, 'lab_override=" --allow-private-address"', 'lab_override=""', 'Linux lab propagation') },
  /Linux public-node installer/i,
);

expectFailure(
  { runtimeSmoke: mutateOnce(baseline.runtimeSmoke, "        '--allow-private-address',\n", '', 'runtime loopback lab override') },
  /Loopback runtime smoke/i,
);

expectFailure(
  { packageJson: mutateOnce(baseline.packageJson, 'node scripts/test-node-public-host-policy.mjs && ', '', 'adversarial audit hook') },
  /Project audit/i,
);

console.log('Konofix Node public-host adversarial policy tests: PASS');
