#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublicHostPolicy } from "./check-public-host-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionSource = path.join(
  repoRoot,
  "src-tauri",
  "src",
  "bin",
  "konofix-node.rs"
);
const source = fs.readFileSync(productionSource, "utf8");

checkPublicHostPolicy(source);

const mutations = [
  {
    name: "remove pre-identity gate",
    mutate(text) {
      return text.replace("public_host_kind = args", "public_host_kind_removed = args");
    },
  },
  {
    name: "make private override implicit",
    mutate(text) {
      return text.replace(
        "Ok(ip) if allow_private_address =>",
        "Ok(ip) =>"
      );
    },
  },
  {
    name: "remove default fail-closed rejection",
    mutate(text) {
      return text.replace(
        'Ok(ip) => Err(format!(',
        'Ok(ip) if false => Err(format!('
      );
    },
  },
  {
    name: "remove lab-only evidence label",
    mutate(text) {
      return text.replace(
        "LAB ONLY - NOT VALID PUBLIC-NODE EVIDENCE",
        "LOCAL ADDRESS"
      );
    },
  },
  {
    name: "remove CGNAT regression fixture",
    mutate(text) {
      return text.replace('"100.64.0.1"', '"100.64.0.2"');
    },
  },
  {
    name: "restore warning-only helper",
    mutate(text) {
      return `${text}\nfn is_non_public_ip(_host: &str) -> bool { false }\n`;
    },
  },
];

for (const mutation of mutations) {
  const mutated = mutation.mutate(source);
  if (mutated === source) {
    throw new Error(`Adversarial mutation did not apply: ${mutation.name}`);
  }

  let rejected = false;
  try {
    checkPublicHostPolicy(mutated);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Adversarial mutation unexpectedly passed: ${mutation.name}`);
  }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "konofix-public-host-policy-"));
try {
  const sourcePath = path.join(tempDir, "konofix-node.rs");
  fs.writeFileSync(sourcePath, source, "utf8");
  checkPublicHostPolicy(fs.readFileSync(sourcePath, "utf8"));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Public-host policy adversarial tests PASS: ${mutations.length}/${mutations.length} rejected`);
