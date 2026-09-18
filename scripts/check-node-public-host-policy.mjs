import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST_PATH = 'src-tauri/src/bin/konofix-node.rs';
const WINDOWS_PATH = 'scripts/public-node.ps1';
const LINUX_PATH = 'scripts/install-public-node-linux.sh';

function requireText(errors, source, needle, message) {
  if (!source.includes(needle)) errors.push(message);
}

export function checkNodePublicHostPolicySource(rustSource, windowsSource, linuxSource) {
  const errors = [];

  if (rustSource.includes('fn is_non_public_ip(')) {
    errors.push('Legacy warning-only is_non_public_ip guard must not remain in the raw Node.');
  }

  requireText(errors, rustSource, 'allow_private_address: bool', 'Raw Node arguments must carry an explicit lab-only override state.');
  requireText(errors, rustSource, '"--allow-private-address"', 'Raw Node must expose the explicit --allow-private-address lab override.');
  requireText(errors, rustSource, 'fn is_globally_routable_ipv4(', 'Raw Node must define the IPv4 global-routability policy.');
  requireText(errors, rustSource, 'fn is_globally_routable_ipv6(', 'Raw Node must define the IPv6 global-routability policy.');
  requireText(errors, rustSource, 'fn classify_public_host(', 'Raw Node must classify public-host input before printing bootstrap addresses.');
  requireText(errors, rustSource, 'fn validate_public_host(', 'Raw Node must validate public-host input fail-closed.');
  requireText(errors, rustSource, 'validate_public_host(host, allow_private_address)?;', 'Raw Node argument parsing must validate --public-host before runtime/shareable output.');
  requireText(errors, rustSource, 'not globally routable under the Konofix public-node evidence policy', 'Raw Node rejection must identify the public-node evidence policy.');
  requireText(errors, rustSource, 'KONOFIX LAB-ONLY ADDRESSES', 'Lab override output must be visibly labelled lab-only.');
  requireText(errors, rustSource, 'NOT VALID FOR PUBLIC-NODE RELEASE EVIDENCE', 'Lab override output must state that it is not release evidence.');
  requireText(errors, rustSource, 'global reachability is not proven', 'Raw DNS handling must not claim that hostname syntax proves global reachability.');

  const requiredRustTests = [
    'public_host_classification_is_fail_closed_for_special_use_literals',
    'non_global_public_host_requires_explicit_lab_override',
    'dns_public_host_remains_supported_without_claiming_global_reachability',
  ];
  for (const testName of requiredRustTests) {
    requireText(errors, rustSource, testName, `Missing raw Node public-host regression test: ${testName}.`);
  }

  const requiredPolicyFixtures = [
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::ffff:192.168.1.1',
    'fd00::1',
    'ff02::1',
    '2001:db8::1',
    '3fff::1',
  ];
  for (const fixture of requiredPolicyFixtures) {
    requireText(errors, rustSource, `"${fixture}"`, `Raw Node public-host tests are missing required special-use fixture ${fixture}.`);
  }

  const windowsPropagation = /if\s*\(\$AllowPrivateAddress\)\s*\{[\s\S]{0,240}\$nodeArgs\s*\+=\s*'--allow-private-address'/m;
  if (!windowsPropagation.test(windowsSource)) {
    errors.push('Windows public-node wrapper must propagate -AllowPrivateAddress into the raw Node only inside the explicit lab override branch.');
  }

  if (!linuxSource.includes('NODE_LAB_ARG=""') ||
      !/if\s*\(\(ALLOW_PRIVATE\)\);\s*then[\s\S]{0,180}NODE_LAB_ARG=" --allow-private-address"/m.test(linuxSource) ||
      !linuxSource.includes('${NODE_LAB_ARG}')) {
    errors.push('Linux systemd installer must propagate --allow-private-address only when the explicit lab override is enabled.');
  }

  return errors;
}

function main() {
  const rustSource = fs.readFileSync(path.join(ROOT, RUST_PATH), 'utf8');
  const windowsSource = fs.readFileSync(path.join(ROOT, WINDOWS_PATH), 'utf8');
  const linuxSource = fs.readFileSync(path.join(ROOT, LINUX_PATH), 'utf8');
  const errors = checkNodePublicHostPolicySource(rustSource, windowsSource, linuxSource);
  if (errors.length > 0) {
    for (const error of errors) console.error(`NODE PUBLIC-HOST POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Node public-host fail-closed policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
