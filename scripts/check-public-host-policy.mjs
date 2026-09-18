import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const sourcePath = path.resolve(process.argv[2] ?? "src-tauri/src/bin/konofix-node.rs");
const source = fs.readFileSync(sourcePath, "utf8");

function requireText(needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`public-host policy check failed: missing ${label}`);
  }
}

requireText("--allow-private-address", "explicit lab-only override");
requireText("fn is_globally_routable_ip", "global-routability classifier");
requireText("100.64.0.0/10 CGNAT", "CGNAT rejection range");
requireText("198.18.0.0/15 benchmarking", "IPv4 benchmarking rejection range");
requireText("2001:db8::/32 documentation", "IPv6 documentation rejection range");
requireText("NOT VALID FOR PUBLIC-NODE OR CROSS-COUNTRY PROMOTION", "lab-only output label");
requireText("non-global IP literal", "fail-closed literal error");

if (source.includes("WARNING: --public-host resolves to a non-public IP literal")) {
  throw new Error("public-host policy check failed: warning-only legacy behavior returned");
}

const mainStart = source.indexOf("#[tokio::main]");
if (mainStart < 0) throw new Error("public-host policy check failed: async main not found");
const main = source.slice(mainStart);
const validationCall = main.indexOf("validate_public_host(host, args.allow_private_address)");
const identityLoad = main.indexOf("load_or_create_identity(&identity_path)");
if (validationCall < 0) {
  throw new Error("public-host policy check failed: main does not validate --public-host");
}
if (identityLoad < 0 || validationCall > identityLoad) {
  throw new Error("public-host policy check failed: literal validation must happen before identity creation/startup side effects");
}

console.log("public-host policy: PASS");
