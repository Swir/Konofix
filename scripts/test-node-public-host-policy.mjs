import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicy } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = {
  nodeSource: fs.readFileSync(path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs'), 'utf8'),
  windowsLauncher: fs.readFileSync(path.join(ROOT, 'scripts/public-node.ps1'), 'utf8'),
  linuxInstaller: fs.readFileSync(path.join(ROOT, 'scripts/install-public-node-linux.sh'), 'utf8'),
};

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(inputs, pattern) {
  const errors = checkNodePublicHostPolicy(inputs);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern}; got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicy(baseline), []);

expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, '"--allow-private-address" => {', '"--allow-lab" => {', 'raw lab flag') }, /CLI.*allow-private-address/i);
expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, '(Ipv4Addr::new(100, 64, 0, 0), 10)', '(Ipv4Addr::new(100, 64, 0, 0), 9)', 'CGNAT prefix') }, /100, 64.*10/);
expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, '(Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)', '(Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 48)', 'RFC 9637 documentation prefix') }, /0x3fff.*20/);
expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, 'Refusing to publish public bootstrap addresses', 'Warning about public bootstrap addresses', 'fail-closed refusal') }, /fail closed/i);
expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, 'NOT VALID FOR PUBLIC-NODE OR CROSS-COUNTRY PROMOTION', 'LAB MODE', 'evidence label') }, /promotion evidence/i);
expectFailure({ ...baseline, nodeSource: mutateOnce(baseline.nodeSource, 'let public_host_mode = args', 'let key_probe_marker = args', 'pre-side-effect classification marker') }, /before identity creation/i);
expectFailure({ ...baseline, windowsLauncher: mutateOnce(baseline.windowsLauncher, "if ($AllowPrivateAddress) { $nodeArgs += '--allow-private-address' }", '# lab forwarding removed', 'Windows launcher propagation') }, /Windows.*forward/i);
expectFailure({ ...baseline, windowsLauncher: mutateOnce(baseline.windowsLauncher, "@('3fff::', 20)", "@('3fff::', 48)", 'Windows RFC 9637 prefix') }, /Windows.*3fff::\/20/i);
expectFailure({ ...baseline, linuxInstaller: mutateOnce(baseline.linuxInstaller, 'NODE_LAB_FLAG=" --allow-private-address"', 'NODE_LAB_FLAG=""', 'Linux installer propagation') }, /Linux.*forward/i);
expectFailure({ ...baseline, linuxInstaller: mutateOnce(baseline.linuxInstaller, '"3fff::/20"', '"3fff::/48"', 'Linux RFC 9637 prefix') }, /Linux.*3fff::\/20/i);

console.log('Konofix Node public-host adversarial policy tests: PASS');
