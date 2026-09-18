#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class PolicyError extends Error {}

export function checkPublicHostPolicy(source) {
  const required = [
    "allow_private_address: bool",
    '"--allow-private-address" =>',
    "fn classify_public_host(",
    "fn is_global_ipv4_literal(",
    "fn is_global_ipv6_literal(",
    "public_host_kind = args",
    ".map(|host| classify_public_host(host, args.allow_private_address))",
    "print_shareable_addresses(host, port, local_peer, kind)",
    "kind == PublicHostKind::LabOnlyIp",
    "LAB ONLY - NOT VALID PUBLIC-NODE EVIDENCE",
    '"100.64.0.1"',
    '"198.18.0.1"',
    '"203.0.113.1"',
    '"2001:db8::1"',
    '"ff02::1"',
  ];

  for (const token of required) {
    if (!source.includes(token)) {
      throw new PolicyError(`Public-host fail-closed policy is missing required token: ${token}`);
    }
  }

  const forbidden = [
    "fn is_non_public_ip(",
    "WARNING: --public-host resolves to a non-public IP literal",
  ];
  for (const token of forbidden) {
    if (source.includes(token)) {
      throw new PolicyError(`Retired warning-only public-host behavior returned: ${token}`);
    }
  }

  const gate = source.indexOf("public_host_kind = args");
  const identity = source.indexOf("load_or_create_identity(&identity_path)");
  if (gate < 0 || identity < 0 || gate > identity) {
    throw new PolicyError(
      "Public-host routability validation must run before persistent identity creation."
    );
  }

  const overrideGuard = source.indexOf("Ok(ip) if allow_private_address =>");
  const defaultReject = source.indexOf('Ok(ip) => Err(format!(');
  if (overrideGuard < 0 || defaultReject < 0 || overrideGuard > defaultReject) {
    throw new PolicyError(
      "Non-global literals must fail closed by default and only enter lab mode through the explicit override."
    );
  }

  const dnsGate = source.indexOf("Err(_) if is_valid_dns_name(host) =>");
  if (dnsGate < 0) {
    throw new PolicyError("DNS names must pass an explicit syntax gate.");
  }

  return true;
}

function parseArgs(argv) {
  let sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src-tauri",
    "src",
    "bin",
    "konofix-node.rs"
  );

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") {
      const value = argv[i + 1];
      if (!value) throw new PolicyError("Missing value after --source");
      sourcePath = path.resolve(value);
      i += 1;
    } else {
      throw new PolicyError(`Unknown argument: ${argv[i]}`);
    }
  }

  return { sourcePath };
}

function main() {
  try {
    const { sourcePath } = parseArgs(process.argv.slice(2));
    const source = fs.readFileSync(sourcePath, "utf8");
    checkPublicHostPolicy(source);
    console.log(`Public-host policy PASS: ${sourcePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Public-host policy FAIL: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
