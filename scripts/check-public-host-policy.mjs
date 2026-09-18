import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'src-tauri/src/bin/konofix-node.rs';

const requiredIpv4Fixtures = [
  '100.64.0.1',
  '192.0.2.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
];
const requiredIpv6Fixtures = [
  '::1',
  '100::1',
  '2001:2::1',
  '2001:db8::1',
  '2002::1',
  '3fff::1',
  'fc00::1',
  'fe80::1',
  'ff02::1',
];

export function checkPublicHostPolicySource(source) {
  const errors = [];
  const parseStart = source.indexOf('fn parse_args_from<I>');
  const prefixStart = source.indexOf('fn public_prefix(');
  const validateStart = source.indexOf('fn validate_public_host(');
  const printStart = source.indexOf('fn print_shareable_addresses(');
  const mainStart = source.indexOf('async fn main()');
  const identityLoad = source.indexOf('load_or_create_identity(', mainStart);

  if (parseStart < 0 || prefixStart < 0 || validateStart < 0 || printStart < 0 || mainStart < 0 || identityLoad < 0) {
    return ['Could not isolate public-host policy boundaries; validation cannot be verified.'];
  }

  const parser = source.slice(parseStart, prefixStart);
  const policy = source.slice(prefixStart, printStart);
  const main = source.slice(mainStart);

  if (!source.includes('allow_private_address: bool')) {
    errors.push('NodeArgs must carry an explicit lab-only private-address override state.');
  }
  if (!parser.includes('"--allow-private-address"')) {
    errors.push('CLI parser must expose --allow-private-address explicitly.');
  }
  if (!parser.includes('allow_private_address = true;')) {
    errors.push('CLI parser must set the lab-only override only when requested.');
  }
  if (!policy.includes('fn is_globally_routable_ipv4(') || !policy.includes('fn is_globally_routable_ipv6(')) {
    errors.push('Both IPv4 and IPv6 literal routability policies must remain explicit and testable.');
  }
  if (!policy.includes('Ipv4Addr::new(100, 64, 0, 0), 10')) {
    errors.push('IPv4 CGNAT 100.64.0.0/10 must remain blocked.');
  }
  if (!policy.includes('Ipv4Addr::new(198, 18, 0, 0), 15')) {
    errors.push('IPv4 benchmarking 198.18.0.0/15 must remain blocked.');
  }
  if (!policy.includes('Ipv4Addr::new(203, 0, 113, 0), 24')) {
    errors.push('IPv4 documentation ranges must remain blocked.');
  }
  if (!policy.includes('Ipv6Addr::new(0x2001, 0x0db8')) {
    errors.push('IPv6 documentation 2001:db8::/32 must remain blocked.');
  }
  if (!policy.includes('Ipv6Addr::new(0x3fff')) {
    errors.push('IPv6 documentation 3fff::/20 must remain blocked.');
  }
  if (!policy.includes('if allow_private_address {') || !policy.includes('return Ok(true);')) {
    errors.push('Non-global literals may proceed only through the explicit lab override.');
  }
  if (!policy.includes('not valid public-node evidence')) {
    errors.push('Lab override must be explicitly excluded from public-node evidence.');
  }
  if (!source.includes('=== KONOFIX LAB-ONLY ADDRESSES ===')) {
    errors.push('Lab-only output must be visibly distinct from normal shareable output.');
  }
  if (!source.includes('DNS NOTE: this output confirms syntax only')) {
    errors.push('DNS output must not claim that syntax proves Internet reachability.');
  }

  const validationCall = main.indexOf('validate_public_host(host, args.allow_private_address)');
  const mainIdentityLoad = main.indexOf('load_or_create_identity(');
  if (validationCall < 0 || mainIdentityLoad < 0 || validationCall > mainIdentityLoad) {
    errors.push('Public-host validation must fail closed before identity creation/network startup.');
  }
  if (source.includes('WARNING: --public-host resolves to a non-public IP literal')) {
    errors.push('The retired warning-only non-public literal path must not return.');
  }

  for (const fixture of requiredIpv4Fixtures) {
    if (!source.includes(`"${fixture}"`)) {
      errors.push(`Missing non-global IPv4 regression fixture: ${fixture}.`);
    }
  }
  for (const fixture of requiredIpv6Fixtures) {
    if (!source.includes(`"${fixture}"`)) {
      errors.push(`Missing non-global IPv6 regression fixture: ${fixture}.`);
    }
  }

  for (const testName of [
    'parses_lab_only_private_address_override',
    'public_ipv4_literals_are_accepted',
    'non_global_ipv4_literals_fail_closed',
    'public_ipv6_literals_are_accepted',
    'non_global_and_special_ipv6_literals_fail_closed',
    'dns_public_host_is_supported_without_claiming_ip_validation',
  ]) {
    if (!source.includes(`fn ${testName}()`)) {
      errors.push(`Missing public-host regression test: ${testName}.`);
    }
  }

  return errors;
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, SOURCE_PATH), 'utf8').replaceAll('\r\n', '\n');
  const errors = checkPublicHostPolicySource(source);
  if (errors.length > 0) {
    for (const error of errors) console.error(`PUBLIC HOST POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Public-host global-routability policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
