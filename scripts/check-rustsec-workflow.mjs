import fs from 'node:fs';

const workflowPath = process.argv[2] ?? '.github/workflows/rustsec-audit.yml';
const text = fs.readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`RUSTSEC WORKFLOW ERROR: ${message}`);
  process.exitCode = 1;
};

const requireText = (needle, message) => {
  if (!text.includes(needle)) fail(message);
};

requireText('permissions:\n  contents: read\n', 'workflow permissions must remain read-only (`contents: read`).');

for (const capability of ['contents', 'actions', 'checks', 'deployments', 'issues', 'packages', 'pull-requests', 'statuses']) {
  const writePermission = new RegExp(`^\\s*${capability}:\\s*write\\s*$`, 'm');
  if (writePermission.test(text)) {
    fail(`workflow must not grant ${capability}: write.`);
  }
}

if (/\bGITHUB_TOKEN\b/.test(text) || /\bgh\s+api\b/.test(text)) {
  fail('RustSec audit must remain read-only and must not script GitHub token/API mutations.');
}

const usesLines = [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
if (usesLines.length === 0) {
  fail('workflow must declare at least the pinned checkout Action.');
}
for (const action of usesLines) {
  if (action.startsWith('./')) continue;
  const at = action.lastIndexOf('@');
  const ref = at >= 0 ? action.slice(at + 1) : '';
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    fail(`external Action '${action}' must be pinned to an immutable 40-character commit SHA.`);
  }
}

requireText('persist-credentials: false', 'checkout must disable persisted credentials.');
requireText("CARGO_AUDIT_VERSION: '0.22.2'", 'cargo-audit must stay pinned to the reviewed 0.22.2 package version.');
requireText("RUST_TOOLCHAIN: '1.88.0'", 'RustSec audit must use the reviewed Rust 1.88.0 toolchain.');
requireText('cargo install cargo-audit --version "$CARGO_AUDIT_VERSION" --locked --force', 'cargo-audit installation must be exact-version and Cargo --locked.');
requireText('cargo install --list | grep -Fxq "cargo-audit v$CARGO_AUDIT_VERSION:"', 'installed cargo-audit package identity/version must be verified.');
requireText("FIXTURE_ADVISORY: 'RUSTSEC-2026-0285'", 'the controlled known-vulnerable fixture advisory must stay explicit.');
requireText('if [[ $status -eq 0 ]]; then', 'controlled vulnerable fixture must fail closed when cargo-audit unexpectedly succeeds.');
requireText('grep -Fq "\\\"$FIXTURE_ADVISORY\\\"" "$report"', 'fixture failure must be bound to the expected RustSec advisory ID.');
requireText('cargo audit --file src-tauri/Cargo.lock', 'the committed production Cargo.lock must be audited directly.');

if (!/^\s*schedule:\s*$/m.test(text) || !/^\s*-\s*cron:\s*['"][^'"]+['"]\s*$/m.test(text)) {
  fail('workflow must keep a scheduled advisory refresh even when dependencies do not change.');
}

for (const requiredPath of [
  "'src-tauri/Cargo.toml'",
  "'src-tauri/Cargo.lock'",
  "'node-linux/Cargo.toml'",
  "'.github/workflows/rustsec-audit.yml'",
  "'scripts/check-rustsec-workflow.mjs'",
  "'scripts/test-rustsec-workflow.mjs'",
]) {
  if (!text.includes(requiredPath)) {
    fail(`pull-request trigger is missing ${requiredPath}.`);
  }
}

if (!process.exitCode) {
  console.log('RustSec workflow policy: read-only permissions, immutable Actions, pinned audit toolchain, adversarial fixture and direct committed-lock audit are enforced.');
}
