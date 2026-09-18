import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_IPV4_FIXTURES = [
  '100.64.0.1',
  '192.0.0.8',
  '192.0.2.1',
  '192.88.99.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
];
const REQUIRED_IPV6_FIXTURES = [
  '2001:2::1',
  '2001:db8::1',
  '2001:10::1',
  '2001:20::1',
  'fd00::1',
  'ff02::1',
  '::ffff:100.64.0.1',
];

const REQUIRED_CLASSIFIER_INVARIANTS = [
  ['CGNAT classification', '(a == 100 && (64..=127).contains(&b))'],
  ['IPv4 benchmark classification', '(a == 198 && (18..=19).contains(&b))'],
  ['IPv4 multicast/reserved classification', 'a >= 224'],
  ['IPv4-mapped IPv6 delegation', 'if let Some(mapped) = ip.to_ipv4_mapped()'],
  ['IPv6 global-unicast boundary', 'segments[0] & 0xe000 != 0x2000'],
  ['IPv6 benchmark classification', 'segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0'],
  ['IPv6 documentation classification', 'segments[0] == 0x2001 && segments[1] == 0x0db8'],
  ['IPv6 ORCHID classification', '(segments[1] & 0xfff0) == 0x0010'],
  ['IPv6 ORCHIDv2 classification', '(segments[1] & 0xfff0) == 0x0020'],
];

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) return null;
  return source.slice(start, end);
}

export function checkNodePublicHostPolicySources({
  nodeSource,
  windowsLauncher,
  windowsLauncherTest,
  linuxInstaller,
  linuxInstallerTest,
  runtimeSmoke,
  packageJson,
}) {
  const errors = [];

  for (const required of [
    'allow_private_address: bool',
    'enum PublicHostPolicy',
    'PublicHostPolicy::GlobalIp',
    'PublicHostPolicy::DnsUnverified',
    'PublicHostPolicy::LabOnlyIp',
    'fn is_globally_routable_ip(',
    'fn validate_public_host(',
    '--allow-private-address',
    'NOT VALID PUBLIC-NODE EVIDENCE',
    'DNS UNVERIFIED',
  ]) {
    if (!nodeSource.includes(required)) {
      errors.push(`Konofix Node public-host policy is missing required invariant: ${required}`);
    }
  }

  const nodeArgs = sliceBetween(nodeSource, 'struct NodeArgs {', 'enum PublicHostPolicy');
  if (!nodeArgs || !nodeArgs.includes('allow_private_address: bool')) {
    errors.push('NodeArgs must carry allow_private_address: bool so the lab override is explicit CLI state.');
  }

  if (nodeSource.includes('fn is_non_public_ip(')) {
    errors.push('Legacy warning-only is_non_public_ip policy must not coexist with the fail-closed public-host policy.');
  }

  const classifierStart = nodeSource.indexOf('fn is_globally_routable_ip(');
  const validatorStart = nodeSource.indexOf('fn validate_public_host(', classifierStart);
  const classifier = classifierStart >= 0 && validatorStart > classifierStart
    ? nodeSource.slice(classifierStart, validatorStart)
    : '';
  if (!classifier) {
    errors.push('Could not isolate the globally-routable IP classifier for fail-closed policy verification.');
  } else {
    for (const [label, invariant] of REQUIRED_CLASSIFIER_INVARIANTS) {
      if (!classifier.includes(invariant)) {
        errors.push(`Konofix Node ${label} invariant is missing from the public-host classifier.`);
      }
    }
  }

  const mainIndex = nodeSource.indexOf('async fn main()');
  const validationIndex = nodeSource.indexOf('let public_host_policy =', mainIndex);
  const identityIndex = nodeSource.indexOf('let key = load_or_create_identity(', mainIndex);
  if (mainIndex < 0 || validationIndex < 0 || identityIndex < 0 || validationIndex > identityIndex) {
    errors.push('Public-host policy must fail closed before identity creation and network startup side effects.');
  }

  const ipv4Tests = sliceBetween(
    nodeSource,
    'fn public_host_ipv4_policy_matches_evidence_ranges()',
    'fn public_host_ipv6_policy_matches_evidence_ranges()',
  );
  const ipv6Tests = sliceBetween(
    nodeSource,
    'fn public_host_ipv6_policy_matches_evidence_ranges()',
    'fn public_host_policy_fails_closed_without_lab_override()',
  );
  if (!ipv4Tests) {
    errors.push('Could not isolate the IPv4 public-host regression fixture table.');
  } else {
    for (const fixture of REQUIRED_IPV4_FIXTURES) {
      if (!ipv4Tests.includes(`"${fixture}"`)) {
        errors.push(`Missing IPv4 Rust regression fixture for non-global public-host class: ${fixture}`);
      }
    }
  }
  if (!ipv6Tests) {
    errors.push('Could not isolate the IPv6 public-host regression fixture table.');
  } else {
    for (const fixture of REQUIRED_IPV6_FIXTURES) {
      if (!ipv6Tests.includes(`"${fixture}"`)) {
        errors.push(`Missing IPv6 Rust regression fixture for non-global public-host class: ${fixture}`);
      }
    }
  }

  for (const testName of [
    'public_host_ipv4_policy_matches_evidence_ranges',
    'public_host_ipv6_policy_matches_evidence_ranges',
    'public_host_policy_fails_closed_without_lab_override',
    'public_host_policy_labels_lab_and_dns_modes',
    'parses_explicit_lab_override',
  ]) {
    if (!nodeSource.includes(testName)) {
      errors.push(`Missing Konofix Node public-host regression test: ${testName}.`);
    }
  }

  if (!windowsLauncher.includes("$nodeArgs += '--allow-private-address'")) {
    errors.push('Windows public-node launcher must propagate its lab-only override to the strict Node binary.');
  }
  if (!windowsLauncher.includes('lab_only = [bool]$AllowPrivateAddress')) {
    errors.push('Windows public-node JSON output must label lab-only configurations explicitly.');
  }
  if (!windowsLauncherTest.includes("$lab.args -contains '--allow-private-address'")) {
    errors.push('Windows public-node self-test must verify binary lab-override propagation.');
  }

  if (!linuxInstaller.includes('lab_override=" --allow-private-address"')) {
    errors.push('Linux public-node installer must derive an explicit binary lab override only when requested.');
  }
  if (!linuxInstaller.includes('${IDENTITY_FILE}${lab_override}')) {
    errors.push('Linux systemd ExecStart must propagate the explicit lab override to the strict Node binary.');
  }
  if (!linuxInstallerTest.includes("grep -Fq -- '--allow-private-address' <<<\"$lab_unit\"")) {
    errors.push('Linux installer self-test must verify lab-override propagation into the generated unit.');
  }

  const runtimeArgs = runtimeSmoke.indexOf("'--public-host', '127.0.0.1'");
  const runtimeOverride = runtimeSmoke.indexOf("'--allow-private-address'", runtimeArgs);
  if (runtimeArgs < 0 || runtimeOverride < 0 || runtimeOverride - runtimeArgs > 160) {
    errors.push('Loopback runtime smoke must opt into the explicit lab-only override after the strict Node policy.');
  }

  let parsedPackage = null;
  try {
    parsedPackage = JSON.parse(packageJson);
  } catch {
    errors.push('package.json must remain valid JSON for Node public-host policy verification.');
  }

  const auditScript = parsedPackage?.scripts?.audit;
  const adversarialCommand = 'node scripts/test-node-public-host-policy.mjs';
  const deterministicCommand = 'node scripts/check-node-public-host-policy.mjs';
  const adversarialIndex = typeof auditScript === 'string' ? auditScript.indexOf(adversarialCommand) : -1;
  const deterministicIndex = typeof auditScript === 'string' ? auditScript.indexOf(deterministicCommand) : -1;
  if (adversarialIndex < 0 || deterministicIndex < 0 || adversarialIndex > deterministicIndex) {
    errors.push('Project audit must run Node public-host adversarial tests before the deterministic policy check.');
  }

  return errors;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function main() {
  const errors = checkNodePublicHostPolicySources({
    nodeSource: read('src-tauri/src/bin/konofix-node.rs'),
    windowsLauncher: read('scripts/public-node.ps1'),
    windowsLauncherTest: read('scripts/test-public-node.ps1'),
    linuxInstaller: read('scripts/install-public-node-linux.sh'),
    linuxInstallerTest: read('scripts/test-public-node-linux.sh'),
    runtimeSmoke: read('scripts/test-node-runtime.ps1'),
    packageJson: read('package.json'),
  });

  if (errors.length > 0) {
    for (const error of errors) console.error(`NODE PUBLIC-HOST POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Konofix Node public-host fail-closed policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
