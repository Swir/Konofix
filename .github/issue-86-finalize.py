from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one replacement target, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


# Raw Node: reject the generic IANA protocol-assignment block and 6to4,
# and make any explicit private-address override visibly lab-only.
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    """    if segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0x0000 {\n        return false;\n    }\n""",
    """    // 2001::/23 is IANA protocol-assignment space, not general public-node\n    // evidence. More-specific globally reachable anycast/service assignments inside\n    // this block are intentionally rejected by this conservative deployment policy.\n    if segments[0] == 0x2001 && segments[1] <= 0x01ff {\n        return false;\n    }\n    // 6to4 is transition/special-purpose space and is not accepted as stable\n    // public-node evidence even when a host happens to route it.\n    if segments[0] == 0x2002 {\n        return false;\n    }\n    if segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0x0000 {\n        return false;\n    }\n""",
)
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    """    match host.parse::<IpAddr>() {\n        Ok(ip) if is_public_evidence_ip(ip) => Ok(false),\n        Ok(_) if allow_private_address => Ok(true),\n        Ok(ip) => Err(format!(\n            \"--public-host address {ip} is not globally routable under the Konofix public-node evidence policy. Use --allow-private-address only for controlled lab testing; lab addresses are not valid public-node evidence.\"\n        )),\n        Err(_) if is_public_looking_dns_name(host) => Ok(false),\n        Err(_) => Err(format!(\n            \"--public-host is not a public-looking DNS name or valid IP literal: {host}\"\n        )),\n    }\n""",
    """    match host.parse::<IpAddr>() {\n        // The explicit override always marks the resulting addresses as lab-only,\n        // even when the literal itself would otherwise satisfy the public policy.\n        Ok(_) if allow_private_address => Ok(true),\n        Ok(ip) if is_public_evidence_ip(ip) => Ok(false),\n        Ok(ip) => Err(format!(\n            \"--public-host address {ip} is not globally routable under the Konofix public-node evidence policy. Use --allow-private-address only for controlled lab testing; lab addresses are not valid public-node evidence.\"\n        )),\n        Err(_) if is_public_looking_dns_name(host) && allow_private_address => Ok(true),\n        Err(_) if is_public_looking_dns_name(host) => Ok(false),\n        Err(_) => Err(format!(\n            \"--public-host is not a public-looking DNS name or valid IP literal: {host}\"\n        )),\n    }\n""",
)
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    '        println!("WARNING: --allow-private-address is active for a non-public IP literal.");\n',
    '        println!("WARNING: --allow-private-address is active; advertised addresses are lab-only.");\n',
)
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    '            "2001:2::1",\n',
    '            "2001::1",\n            "2001:2::1",\n            "2001:5::1",\n',
)
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    '            "2001:20::1",\n            "3fff::1",\n',
    '            "2001:20::1",\n            "2002::1",\n            "3fff::1",\n',
)
replace_once(
    "src-tauri/src/bin/konofix-node.rs",
    """        assert!(validate_public_host(\"3fff::1234\", true)\n            .expect(\"explicit documentation-address lab override should pass\"));\n""",
    """        assert!(validate_public_host(\"3fff::1234\", true)\n            .expect(\"explicit documentation-address lab override should pass\"));\n        assert!(validate_public_host(\"8.8.8.8\", true)\n            .expect(\"explicit override must keep even a global literal visibly lab-only\"));\n        assert!(validate_public_host(\"node.konofix.net\", true)\n            .expect(\"explicit override must keep a public-looking DNS host visibly lab-only\"));\n""",
)

# Windows launcher: align the evidence policy with the raw Node for IANA
# protocol-assignment and 6to4 special-purpose IPv6 space.
replace_once(
    "scripts/public-node.ps1",
    """  foreach ($blocked in @(\n    @('2001:2::', 48),\n""",
    """  foreach ($blocked in @(\n    @('2001::', 23),\n    @('2001:2::', 48),\n""",
)
replace_once(
    "scripts/public-node.ps1",
    """    @('2001:20::', 28)\n""",
    """    @('2001:20::', 28),\n    @('2002::', 16)\n""",
)
replace_once(
    "scripts/test-public-node.ps1",
    """  @('benchmark IPv6 rejection', '2001:2::1'),\n""",
    """  @('IETF protocol-assignment IPv6 rejection', '2001:5::1'),\n  @('benchmark IPv6 rejection', '2001:2::1'),\n""",
)
replace_once(
    "scripts/test-public-node.ps1",
    """  @('ORCHIDv2 IPv6 rejection', '2001:20::1'),\n""",
    """  @('ORCHIDv2 IPv6 rejection', '2001:20::1'),\n  @('6to4 IPv6 rejection', '2002::1'),\n  @('RFC 9637 documentation IPv6 rejection', '3fff::1'),\n""",
)

# Linux installer: same conservative special-purpose IPv6 boundary.
replace_once(
    "scripts/install-public-node-linux.sh",
    '    "2001:2::/48", "2001:db8::/32", "2001:10::/28", "2001:20::/28", "3fff::/20",\n',
    '    "2001::/23", "2001:2::/48", "2001:db8::/32", "2001:10::/28",\n    "2001:20::/28", "2002::/16", "3fff::/20",\n',
)
replace_once(
    "scripts/test-public-node-linux.sh",
    """expect_reject 'benchmark IPv6 without lab override' \\\n  --public-host 2001:2::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3e --install-dir /usr/local/lib/k3e --print-unit\n""",
    """expect_reject 'IETF protocol-assignment IPv6 without lab override' \\\n  --public-host 2001:5::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3e0 --install-dir /usr/local/lib/k3e0 --print-unit\nexpect_reject 'benchmark IPv6 without lab override' \\\n  --public-host 2001:2::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3e --install-dir /usr/local/lib/k3e --print-unit\n""",
)
replace_once(
    "scripts/test-public-node-linux.sh",
    """expect_reject 'RFC 9637 documentation IPv6 without lab override' \\\n  --public-host 3fff::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3g2 --install-dir /usr/local/lib/k3g2 --print-unit\n""",
    """expect_reject '6to4 IPv6 without lab override' \\\n  --public-host 2002::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3g1 --install-dir /usr/local/lib/k3g1 --print-unit\nexpect_reject 'RFC 9637 documentation IPv6 without lab override' \\\n  --public-host 3fff::1 --binary \"$FAKE_NODE\" --state-dir /var/lib/k3g2 --install-dir /usr/local/lib/k3g2 --print-unit\n""",
)

# Strengthen the fail-closed source-policy checker across raw Node + both wrappers.
checker = r'''import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_SOURCE_PATH = 'src-tauri/src/bin/konofix-node.rs';
const WINDOWS_LAUNCHER_PATH = 'scripts/public-node.ps1';
const LINUX_INSTALLER_PATH = 'scripts/install-public-node-linux.sh';

function requireToken(errors, source, token, message) {
  if (!source.includes(token)) errors.push(message);
}

export function checkNodePublicHostPolicy(nodeSource, windowsLauncherSource, linuxInstallerSource) {
  const errors = [];
  nodeSource = nodeSource.replaceAll('\r\n', '\n');
  windowsLauncherSource = windowsLauncherSource.replaceAll('\r\n', '\n');
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
  requireToken(errors, nodeSource, 'segments[0] == 0x2001 && segments[1] <= 0x01ff', 'Raw Node policy must reject generic IANA 2001::/23 protocol-assignment space.');
  requireToken(errors, nodeSource, 'segments[0] == 0x2002', 'Raw Node policy must reject 6to4 2002::/16 as public-node evidence.');
  requireToken(errors, nodeSource, 'segments[0] == 0x2001 && segments[1] == 0x0db8', 'Raw Node policy must reject IPv6 documentation 2001:db8::/32.');
  requireToken(errors, nodeSource, 'segments[0] == 0x3fff && segments[1] & 0xf000 == 0x0000', 'Raw Node policy must reject IPv6 documentation 3fff::/20.');

  if (nodeSource.includes('fn is_non_public_ip(')) errors.push('Legacy warning-only is_non_public_ip policy must not return.');
  if (nodeSource.includes('WARNING: --public-host resolves to a non-public IP literal')) errors.push('Legacy warning-only public-host handling must not return.');

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
    if (!nodeSource.includes(testName)) errors.push(`Missing raw Node public-host regression test: ${testName}.`);
  }

  requireToken(errors, windowsLauncherSource, "@('2001::', 23)", 'Windows deployment policy must reject generic IANA 2001::/23 protocol-assignment space.');
  requireToken(errors, windowsLauncherSource, "@('2002::', 16)", 'Windows deployment policy must reject 6to4 2002::/16.');
  requireToken(errors, windowsLauncherSource, "@('3fff::', 20)", 'Windows deployment policy must reject the RFC 9637 IPv6 documentation prefix.');
  requireToken(errors, windowsLauncherSource, "$nodeArgs += '--allow-private-address'", 'Windows lab override must propagate into the raw Node command.');
  requireToken(errors, windowsLauncherSource, "lab_only = [bool]$AllowPrivateAddress", 'Windows preview JSON must label explicit override configurations as lab-only.');

  requireToken(errors, linuxInstallerSource, '"2001::/23"', 'Linux deployment policy must reject generic IANA 2001::/23 protocol-assignment space.');
  requireToken(errors, linuxInstallerSource, '"2002::/16"', 'Linux deployment policy must reject 6to4 2002::/16.');
  requireToken(errors, linuxInstallerSource, '"3fff::/20"', 'Linux deployment policy must reject the RFC 9637 IPv6 documentation prefix.');
  requireToken(errors, linuxInstallerSource, 'if ip.ipv4_mapped is not None:\n        return False', 'Linux deployment policy must reject IPv4-mapped IPv6 literals.');
  requireToken(errors, linuxInstallerSource, 'NODE_ADDRESS_OVERRIDE=" --allow-private-address"', 'Linux lab override must propagate into the raw Node service command.');
  requireToken(errors, linuxInstallerSource, '--public-host ${PUBLIC_HOST}${NODE_ADDRESS_OVERRIDE}', 'Generated systemd ExecStart must include the raw Node lab override when requested.');
  requireToken(errors, linuxInstallerSource, 'LAB ONLY (--allow-private-address); not valid public-node evidence', 'Linux lab override must be visibly labelled as non-evidence.');

  return errors;
}

function main() {
  const nodeSource = fs.readFileSync(path.join(ROOT, NODE_SOURCE_PATH), 'utf8');
  const windowsLauncherSource = fs.readFileSync(path.join(ROOT, WINDOWS_LAUNCHER_PATH), 'utf8');
  const linuxInstallerSource = fs.readFileSync(path.join(ROOT, LINUX_INSTALLER_PATH), 'utf8');
  const errors = checkNodePublicHostPolicy(nodeSource, windowsLauncherSource, linuxInstallerSource);
  if (errors.length > 0) {
    for (const error of errors) console.error(`NODE PUBLIC-HOST POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Node public-host fail-closed policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
'''
Path("scripts/check-node-public-host-policy.mjs").write_text(checker, encoding="utf-8", newline="\n")

tester = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodePublicHostPolicy } from './check-node-public-host-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeSource = fs.readFileSync(path.join(ROOT, 'src-tauri/src/bin/konofix-node.rs'), 'utf8');
const windowsLauncherSource = fs.readFileSync(path.join(ROOT, 'scripts/public-node.ps1'), 'utf8');
const linuxInstallerSource = fs.readFileSync(path.join(ROOT, 'scripts/install-public-node-linux.sh'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectFailure(node, windows, linux, pattern) {
  const errors = checkNodePublicHostPolicy(node, windows, linux);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkNodePublicHostPolicy(nodeSource, windowsLauncherSource, linuxInstallerSource), []);

const mutations = [
  [mutateOnce(nodeSource, '"--allow-private-address" =>', '"--private-lab-disabled" =>', 'raw Node lab flag parser'), windowsLauncherSource, linuxInstallerSource, /parse --allow-private-address/i],
  [mutateOnce(nodeSource, 'a == 100 && (64..=127).contains(&b)', 'a == 100 && (65..=127).contains(&b)', 'CGNAT lower boundary'), windowsLauncherSource, linuxInstallerSource, /CGNAT/i],
  [mutateOnce(nodeSource, 'segments[0] == 0x2001 && segments[1] <= 0x01ff', 'segments[0] == 0x2001 && segments[1] <= 0x00ff', 'IANA 2001::/23 boundary'), windowsLauncherSource, linuxInstallerSource, /2001::\/23/i],
  [mutateOnce(nodeSource, 'segments[0] == 0x2002', 'segments[0] == 0x2003', '6to4 prefix'), windowsLauncherSource, linuxInstallerSource, /6to4|2002/i],
  [mutateOnce(nodeSource, 'segments[0] == 0x3fff && segments[1] & 0xf000 == 0x0000', 'segments[0] == 0x3ffe && segments[1] & 0xf000 == 0x0000', 'RFC 9637 documentation prefix'), windowsLauncherSource, linuxInstallerSource, /3fff/i],
  [mutateOnce(nodeSource, 'not globally routable under the Konofix public-node evidence policy', 'may not be reachable from the public Internet', 'fail-closed literal error'), windowsLauncherSource, linuxInstallerSource, /fail closed/i],
  [mutateOnce(nodeSource, 'validate_public_host(host, args.allow_private_address)', 'Ok(false)', 'pre-side-effect validation call'), windowsLauncherSource, linuxInstallerSource, /before identity creation/i],
  [mutateOnce(nodeSource, '=== KONOFIX LAB-ONLY ADDRESSES ===', '=== KONOFIX ADDRESSES ===', 'lab-only output banner'), windowsLauncherSource, linuxInstallerSource, /LAB-ONLY/i],
  [nodeSource, mutateOnce(windowsLauncherSource, "$nodeArgs += '--allow-private-address'", "$nodeArgs += '--unsafe-private'", 'Windows lab override propagation'), linuxInstallerSource, /Windows lab override/i],
  [nodeSource, mutateOnce(windowsLauncherSource, "@('2002::', 16)", "@('2003::', 16)", 'Windows 6to4 policy'), linuxInstallerSource, /Windows.*6to4/i],
  [nodeSource, windowsLauncherSource, mutateOnce(linuxInstallerSource, '--public-host ${PUBLIC_HOST}${NODE_ADDRESS_OVERRIDE}', '--public-host ${PUBLIC_HOST}', 'systemd lab override propagation'), /ExecStart|override/i],
  [nodeSource, windowsLauncherSource, mutateOnce(linuxInstallerSource, '"2001::/23"', '"2001::/24"', 'Linux IANA protocol block'), /Linux.*2001::\/23/i],
  [nodeSource, windowsLauncherSource, mutateOnce(linuxInstallerSource, '"2002::/16"', '"2003::/16"', 'Linux 6to4 range'), /Linux.*6to4|Linux.*2002/i],
];

for (const mutation of mutations) expectFailure(...mutation);
console.log(`Node public-host adversarial policy tests: PASS (${mutations.length}/${mutations.length} mutations rejected)`);
'''
Path("scripts/test-node-public-host-policy.mjs").write_text(tester, encoding="utf-8", newline="\n")

# Documentation: keep the operator contract synchronized without changing milestone math.
replace_once(
    "CHANGELOG.md",
    "special IPv6 documentation ranges including `3fff::/20`",
    "special IPv6 protocol/transition/documentation ranges including `2001::/23`, `2002::/16` and `3fff::/20`",
)
replace_once(
    "ROADMAP.md",
    "IPv4-mapped IPv6 or other non-global literals",
    "IPv4-mapped IPv6, IANA protocol-assignment/6to4 or other non-global literals",
)
replace_once(
    "docs/NODE.md",
    "documentation ranges (including `2001:db8::/32` and `3fff::/20`), benchmark, multicast/reserved",
    "documentation ranges (including `2001:db8::/32` and `3fff::/20`), IANA protocol-assignment/6to4 transition space, benchmark, multicast/reserved",
)
replace_once(
    "docs/NODE_LINUX.md",
    "including the IPv6 documentation ranges `2001:db8::/32` and `3fff::/20`.",
    "including generic IANA protocol-assignment `2001::/23`, 6to4 `2002::/16`, and the IPv6 documentation ranges `2001:db8::/32` and `3fff::/20`.",
)

print("issue #86 final policy patch applied")
