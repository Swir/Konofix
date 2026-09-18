import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_SOURCE = 'src-tauri/src/bin/konofix-node.rs';
const WINDOWS_LAUNCHER = 'scripts/public-node.ps1';
const LINUX_INSTALLER = 'scripts/install-public-node-linux.sh';

const IPV4_POLICY_MARKERS = [
  'Ipv4Addr::new(0, 0, 0, 0), 8',
  'Ipv4Addr::new(10, 0, 0, 0), 8',
  'Ipv4Addr::new(100, 64, 0, 0), 10',
  'Ipv4Addr::new(127, 0, 0, 0), 8',
  'Ipv4Addr::new(169, 254, 0, 0), 16',
  'Ipv4Addr::new(172, 16, 0, 0), 12',
  'Ipv4Addr::new(192, 0, 0, 0), 24',
  'Ipv4Addr::new(192, 0, 2, 0), 24',
  'Ipv4Addr::new(192, 88, 99, 0), 24',
  'Ipv4Addr::new(192, 168, 0, 0), 16',
  'Ipv4Addr::new(198, 18, 0, 0), 15',
  'Ipv4Addr::new(198, 51, 100, 0), 24',
  'Ipv4Addr::new(203, 0, 113, 0), 24',
  'Ipv4Addr::new(224, 0, 0, 0), 4',
  'Ipv4Addr::new(240, 0, 0, 0), 4',
];

const IPV6_POLICY_MARKERS = [
  'Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3',
  'Ipv6Addr::new(0x2001, 0x0002, 0, 0, 0, 0, 0, 0), 48',
  'Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32',
  'Ipv6Addr::new(0x2001, 0x0010, 0, 0, 0, 0, 0, 0), 28',
  'Ipv6Addr::new(0x2001, 0x0020, 0, 0, 0, 0, 0, 0), 28',
  'Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20',
];

const REQUIRED_RUST_TESTS = [
  'parses_allow_private_address',
  'public_host_ipv4_policy_covers_special_use_ranges',
  'public_host_ipv6_policy_covers_special_use_ranges',
  'non_global_public_host_requires_explicit_lab_override',
  'dns_public_host_remains_syntax_only',
  'ipv4_mapped_ipv6_uses_ipv4_multiaddr_prefix',
];

export function checkNodePublicHostPolicy({ nodeSource, windowsLauncher, linuxInstaller }) {
  const errors = [];

  if (!nodeSource.includes('allow_private_address: bool')) {
    errors.push('Raw Node arguments must carry an explicit lab-only address override.');
  }
  if (!nodeSource.includes('"--allow-private-address" => {')) {
    errors.push('Raw Node CLI must expose --allow-private-address explicitly.');
  }
  const classifyStart = nodeSource.indexOf('fn classify_public_host(');
  const printStart = nodeSource.indexOf('fn print_shareable_addresses(');
  const mainStart = nodeSource.indexOf('#[tokio::main]');
  if (classifyStart < 0 || printStart < 0 || printStart <= classifyStart) {
    errors.push('Raw Node must classify --public-host before advertising it.');
  }
  const classifyRegion = classifyStart >= 0 && printStart > classifyStart ? nodeSource.slice(classifyStart, printStart) : '';
  const printRegion = printStart >= 0 && mainStart > printStart ? nodeSource.slice(printStart, mainStart) : '';
  if (!classifyRegion.includes('Refusing to publish public bootstrap addresses')) {
    errors.push('Non-global IP literals must fail closed instead of warning-only behavior.');
  }
  if (!printRegion.includes('NOT VALID FOR PUBLIC-NODE OR CROSS-COUNTRY PROMOTION')) {
    errors.push('Lab-only bootstrap output must be visibly invalid for promotion evidence.');
  }
  if (!nodeSource.includes('DNS NOTE: hostname syntax is accepted here')) {
    errors.push('Raw Node DNS output must state that syntax acceptance is not reachability evidence.');
  }

  for (const marker of [...IPV4_POLICY_MARKERS, ...IPV6_POLICY_MARKERS]) {
    if (!nodeSource.includes(marker)) {
      errors.push(`Public-host routability policy marker is missing: ${marker}`);
    }
  }

  const classifyAt = nodeSource.indexOf('let public_host_mode = args');
  const identityAt = nodeSource.indexOf('let key = load_or_create_identity');
  if (classifyAt < 0 || identityAt < 0 || classifyAt > identityAt) {
    errors.push('Public-host fail-closed classification must happen before identity creation or network startup side effects.');
  }

  if (!nodeSource.includes('ip.to_ipv4_mapped()')) {
    errors.push('IPv4-mapped IPv6 literals must be evaluated against the IPv4 policy.');
  }
  if (!nodeSource.includes('Some(mapped) => format!("/ip4/{mapped}")')) {
    errors.push('IPv4-mapped IPv6 literals must normalize to an /ip4 multiaddr prefix.');
  }

  for (const testName of REQUIRED_RUST_TESTS) {
    if (!nodeSource.includes(`fn ${testName}()`)) {
      errors.push(`Missing raw Node public-host regression test: ${testName}.`);
    }
  }

  if (!windowsLauncher.includes("if ($AllowPrivateAddress) { $nodeArgs += '--allow-private-address' }")) {
    errors.push('Windows public-node launcher must forward the lab-only override to the raw Node binary.');
  }
  if (!windowsLauncher.includes("@('3fff::', 20)")) {
    errors.push('Windows deployment policy must reject RFC 9637 documentation prefix 3fff::/20.');
  }
  if (!linuxInstaller.includes('"3fff::/20"')) {
    errors.push('Linux deployment policy must reject RFC 9637 documentation prefix 3fff::/20.');
  }
  if (!linuxInstaller.includes('NODE_LAB_FLAG=""') ||
      !linuxInstaller.includes('NODE_LAB_FLAG=" --allow-private-address"') ||
      !linuxInstaller.includes('${NODE_LAB_FLAG}')) {
    errors.push('Linux service generation must forward the lab-only override to the raw Node binary only in lab mode.');
  }

  return errors;
}

function main() {
  const inputs = {
    nodeSource: fs.readFileSync(path.join(ROOT, NODE_SOURCE), 'utf8'),
    windowsLauncher: fs.readFileSync(path.join(ROOT, WINDOWS_LAUNCHER), 'utf8'),
    linuxInstaller: fs.readFileSync(path.join(ROOT, LINUX_INSTALLER), 'utf8'),
  };
  const errors = checkNodePublicHostPolicy(inputs);
  if (errors.length) {
    for (const error of errors) console.error(`NODE PUBLIC HOST POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Konofix Node public-host fail-closed policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
