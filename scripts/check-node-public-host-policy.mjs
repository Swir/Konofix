import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_SOURCE_PATH = 'src-tauri/src/bin/konofix-node.rs';
const LINUX_INSTALLER_PATH = 'scripts/install-public-node-linux.sh';

function requireToken(errors, source, token, message) {
  if (!source.includes(token)) errors.push(message);
}

export function checkNodePublicHostPolicy(nodeSource, linuxInstallerSource) {
  const errors = [];
  nodeSource = nodeSource.replaceAll('\r\n', '\n');
  linuxInstallerSource = linuxInstallerSource.replaceAll('\r\n', '\n');

  requireToken(errors, nodeSource, 'allow_private_address: bool', 'Raw Node arguments must carry the explicit lab-only private-address override.');
  requireToken(errors, nodeSource, '"--allow-private-address" =>', 'Raw Node must parse --allow-private-address explicitly.');
  requireToken(errors, nodeSource, 'fn validate_public_host(', 'Raw Node is missing the centralized public-host validator.');
  requireToken(errors, nodeSource, 'not globally routable under the Konofix public-node evidence policy', 'Non-global literal public hosts must fail closed by default.');
  requireToken(errors, nodeSource, '=== KONOFIX LAB-ONLY ADDRESSES ===', 'LAB-ONLY override output must be visibly separated from shareable public-node output.');
  requireToken(errors, nodeSource, 'NOT valid public-node or promotion evidence', 'Lab-only output must state that it cannot satisfy public-node/promotion evidence.');
  requireToken(errors, nodeSource, 'DNS syntax alone is not reachability evidence', 'DNS public-host output must not claim syntax as reachability evidence.');
  requireToken(errors, nodeSource, 'a == 100 && (64..=127).contains(&b)', 'Raw Node policy must reject IPv4 CGNAT 100.64.0.0/10.');
  requireToken(errors, nodeSource, 'a == 198 && (b == 18 || b == 19)', 'Raw Node policy must reject IPv4 benchmark 198.18.0.0/15.');
  requireToken(errors, nodeSource, 'a == 203 && b == 0 && c == 113', 'Raw Node policy must reject IPv4 documentation 203.0.113.0/24.');
  requireToken(errors, nodeSource, 'segments[0] == 0x2001 && segments[1] == 0x0db8', 'Raw Node policy must reject IPv6 documentation 2001:db8::/32.');
  requireToken(errors, nodeSource, 'segments[0] == 0x3fff && segments[1] & 0xf000 == 0x0000', 'Raw Node policy must reject IPv6 documentation 3fff::/20.');

  if (nodeSource.includes('fn is_non_public_ip(')) {
    errors.push('Legacy warning-only is_non_public_ip policy must not return.');
  }
  if (nodeSource.includes('WARNING: --public-host resolves to a non-public IP literal')) {
    errors.push('Legacy warning-only public-host handling must not return.');
  }

  const mainStart = nodeSource.indexOf('async fn main()');
  const validateCall = nodeSource.indexOf('validate_public_host(host, args.allow_private_address)', mainStart);
  const identityLoad = nodeSource.indexOf('load_or_create_identity(&identity_path)', mainStart);
  if (mainStart < 0 || validateCall < 0 || identityLoad < 0 || validateCall > identityLoad) {
    errors.push('Public-host policy must run before identity creation and network startup side effects.');
  }

  for (const testName of [
    'parses_lab_override_and_requires_public_host',
    'public_host_policy_accepts_global_ip_literals',
    'public_host_policy_rejects_non_global_ip_literals_by_default',
    'explicit_private_address_override_is_lab_only',
    'public_host_policy_validates_dns_shape_without_claiming_reachability',
  ]) {
    if (!nodeSource.includes(testName)) {
      errors.push(`Missing raw Node public-host regression test: ${testName}.`);
    }
  }

  requireToken(errors, linuxInstallerSource, '"3fff::/20"', 'Linux deployment policy must reject the RFC 9637 IPv6 documentation prefix.');
  requireToken(errors, linuxInstallerSource, 'if ip.ipv4_mapped is not None:\n        return False', 'Linux deployment policy must reject IPv4-mapped IPv6 literals.');
  requireToken(errors, linuxInstallerSource, 'NODE_ADDRESS_OVERRIDE=" --allow-private-address"', 'Linux lab override must propagate into the raw Node service command.');
  requireToken(errors, linuxInstallerSource, '--public-host ${PUBLIC_HOST}${NODE_ADDRESS_OVERRIDE}', 'Generated systemd ExecStart must include the raw Node lab override when requested.');
  requireToken(errors, linuxInstallerSource, 'LAB ONLY (--allow-private-address); not valid public-node evidence', 'Linux lab override must be visibly labelled as non-evidence.');

  return errors;
}

function main() {
  const nodeSource = fs.readFileSync(path.join(ROOT, NODE_SOURCE_PATH), 'utf8');
  const linuxInstallerSource = fs.readFileSync(path.join(ROOT, LINUX_INSTALLER_PATH), 'utf8');
  const errors = checkNodePublicHostPolicy(nodeSource, linuxInstallerSource);
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
