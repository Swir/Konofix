import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicySource } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustSource = fs.readFileSync(path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs'), 'utf8');
const windowsSource = fs.readFileSync(path.join(ROOT, 'scripts/public-node.ps1'), 'utf8');
const linuxSource = fs.readFileSync(path.join(ROOT, 'scripts/install-public-node-linux.sh'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(rust, windows, linux, pattern) {
  const errors = checkNodePublicHostPolicySource(rust, windows, linux);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicySource(rustSource, windowsSource, linuxSource), []);

expectFailure(
  mutateOnce(rustSource, 'validate_public_host(host, allow_private_address)?;', 'let _ = (host, allow_private_address);', 'fail-closed parser validation'),
  windowsSource,
  linuxSource,
  /validate.*before runtime|argument parsing/i,
);

expectFailure(
  mutateOnce(rustSource, '"100.64.0.1"', '"8.8.4.4"', 'CGNAT regression fixture'),
  windowsSource,
  linuxSource,
  /100\.64\.0\.1/,
);

expectFailure(
  mutateOnce(rustSource, 'NOT VALID FOR PUBLIC-NODE RELEASE EVIDENCE', 'LAB OUTPUT', 'lab evidence warning'),
  windowsSource,
  linuxSource,
  /not release evidence/i,
);

expectFailure(
  rustSource,
  mutateOnce(windowsSource, "$nodeArgs += '--allow-private-address'", "$nodeArgs += '--lab-flag-removed'", 'Windows lab override propagation'),
  linuxSource,
  /Windows.*propagate/i,
);

expectFailure(
  rustSource,
  windowsSource,
  mutateOnce(linuxSource, 'NODE_LAB_ARG=" --allow-private-address"', 'NODE_LAB_ARG=""', 'Linux lab override propagation'),
  /Linux.*propagate/i,
);

console.log('Node public-host adversarial policy tests: PASS');
