import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const canonical = fs.readFileSync("src-tauri/src/bin/konofix-node.rs", "utf8");
const checker = path.resolve("scripts/check-public-host-policy.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "konofix-public-host-policy-"));

const mutations = [
  ["remove-main-validation", text => text.replace(
    "validate_public_host(host, args.allow_private_address)",
    "validate_public_host_DISABLED(host, args.allow_private_address)"
  )],
  ["remove-lab-option", text => text.replaceAll("--allow-private-address", "--lab-option-removed")],
  ["remove-cgnat-range", text => text.replace("100.64.0.0/10 CGNAT", "CGNAT RANGE REMOVED")],
  ["restore-warning-only-marker", text => text + "\n// WARNING: --public-host resolves to a non-public IP literal\n"],
];

try {
  for (const [name, mutate] of mutations) {
    const mutated = mutate(canonical);
    if (mutated === canonical) throw new Error(`mutation did not apply: ${name}`);
    const fixture = path.join(tempDir, `${name}.rs`);
    fs.writeFileSync(fixture, mutated);
    const result = spawnSync(process.execPath, [checker, fixture], { encoding: "utf8" });
    if (result.status === 0) {
      throw new Error(`checker accepted adversarial mutation: ${name}`);
    }
  }
  console.log(`public-host policy adversarial tests: PASS (${mutations.length}/${mutations.length} rejected)`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
