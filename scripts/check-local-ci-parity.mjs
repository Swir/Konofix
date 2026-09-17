import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8').replaceAll('\\', '/');
const fail = (message) => {
  console.error(`LOCAL/CI PARITY ERROR: ${message}`);
  process.exitCode = 1;
};

const workflow = read('.github/workflows/windows-ci.yml');
const localCheck = read('scripts/check.ps1');

// These are source/preflight gates that must be runnable both by Windows CI and
// by contributors before opening a PR. Build-only artifact/runtime steps are
// intentionally excluded because scripts/check.ps1 is a source preflight.
const requiredPowerShellGates = [
  'release-gate.ps1',
  'test-network-evidence-gate.ps1',
  'test-client-netprobe-evidence.ps1',
  'test-promotion-evidence.ps1',
  'test-network-report-editor.ps1',
  'test-network-test-session.ps1',
  'test-internet-precheck.ps1',
  'test-public-node.ps1',
  'test-public-node-task.ps1',
  'test-public-node-readiness.ps1',
  'test-node-health.ps1',
  'test-node-soak.ps1',
  'test-node-soak-collector.ps1',
];

for (const script of requiredPowerShellGates) {
  const invocation = `./scripts/${script}`;
  if (!workflow.includes(invocation)) {
    fail(`Windows CI is missing required preflight gate ${script}.`);
  }
  if (!localCheck.includes(invocation)) {
    fail(`scripts/check.ps1 is missing Windows CI preflight gate ${script}.`);
  }
}

const workflowCargoChecks = [...workflow.matchAll(/^\s*run:\s*(cargo check --locked[^\r\n]+)$/gm)]
  .map((match) => match[1].trim());

if (workflowCargoChecks.length < 3) {
  fail(`Expected at least three locked cargo check commands in Windows CI; found ${workflowCargoChecks.length}.`);
}

for (const command of workflowCargoChecks) {
  if (!localCheck.includes(command)) {
    fail(`scripts/check.ps1 is missing Windows CI Rust check: ${command}`);
  }
}

const requiredTargets = [
  'cargo check --locked --manifest-path src-tauri/Cargo.toml',
  'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-node',
  'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-netprobe',
];
for (const command of requiredTargets) {
  if (!workflow.includes(command)) fail(`Windows CI is missing required Rust check: ${command}`);
  if (!localCheck.includes(command)) fail(`scripts/check.ps1 is missing required Rust check: ${command}`);
}

if (!process.exitCode) {
  console.log(`Local/Windows CI preflight parity: ${requiredPowerShellGates.length} PowerShell gates and ${workflowCargoChecks.length} locked Cargo checks aligned.`);
}
