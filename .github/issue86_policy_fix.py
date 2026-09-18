from pathlib import Path

checker = r'''import fs from "node:fs";
import path from "node:path";

const sourcePath = process.argv[2] ?? path.join("src-tauri", "src", "bin", "konofix-node.rs");
const source = fs.readFileSync(sourcePath, "utf8");
const required = [
  "allow_private_address: bool",
  "--allow-private-address",
  "fn is_global_ipv4",
  "fn is_global_ipv6",
  "100, 64, 0, 0), 10",
  "198, 18, 0, 0), 15",
  "198, 51, 100, 0), 24",
  "203, 0, 113, 0), 24",
  "2001:db8::",
  "3fff::",
  "fn validate_public_host",
  "Refusing to advertise it as a public Konofix Node",
  "not valid public-node evidence",
  "let lab_only_public_host",
  "args.public_host.as_deref()",
  "args.allow_private_address",
];
for (const needle of required) {
  if (!source.includes(needle)) throw new Error(`public-host policy missing: ${needle}`);
}
if (source.includes("WARNING: --public-host resolves to a non-public IP literal")) {
  throw new Error("warning-only public-host policy returned");
}
console.log("public-host fail-closed policy: PASS");
'''
Path("scripts/check-public-host-policy.mjs").write_text(checker, encoding="utf-8")

mutation = r'''import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(path.join("src-tauri", "src", "bin", "konofix-node.rs"), "utf8");
const mutations = [
  ["drop CGNAT", "        || ipv4_in_cidr(ip, Ipv4Addr::new(100, 64, 0, 0), 10)\n", ""],
  ["drop benchmark", "        || ipv4_in_cidr(ip, Ipv4Addr::new(198, 18, 0, 0), 15)\n", ""],
  ["restore warning-only wording", "Refusing to advertise it as a public Konofix Node", "WARNING: --public-host resolves to a non-public IP literal"],
  ["drop startup host binding", "args.public_host.as_deref()", "None"],
  ["drop explicit lab gate", "args.allow_private_address", "false"],
];
for (const [name, from, to] of mutations) {
  if (!source.includes(from)) throw new Error(`${name}: mutation anchor missing`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "konofix-public-host-"));
  const candidate = path.join(dir, "konofix-node.rs");
  fs.writeFileSync(candidate, source.replace(from, to));
  const run = spawnSync(process.execPath, ["scripts/check-public-host-policy.mjs", candidate], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  if (run.status === 0) throw new Error(`${name}: checker accepted adversarial mutation`);
}
console.log(`public-host adversarial mutations: ${mutations.length}/${mutations.length} rejected`);
'''
Path("scripts/test-public-host-policy.mjs").write_text(mutation, encoding="utf-8")
