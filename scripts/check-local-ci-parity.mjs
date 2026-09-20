import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8').replaceAll('\\', '/');
const fail = (message) => {
  console.error(`LOCAL/CI PARITY ERROR: ${message}`);
  process.exitCode = 1;
};

// Overrides are used only by the adversarial fixture self-test. Normal audit
// runs always read the repository's real Windows workflow and local preflight.
const workflowPath = process.env.KONOFIX_PARITY_WORKFLOW ?? '.github/workflows/windows-ci.yml';
const localCheckPath = process.env.KONOFIX_PARITY_LOCAL_CHECK ?? 'scripts/check.ps1';
const workflow = read(workflowPath);
const localCheck = read(localCheckPath);

// scripts/check.ps1 is a source preflight, not a production packaging/runtime
// driver. Every single-line repository PowerShell gate in Windows CI must be
// mirrored locally unless it is explicitly classified here as runtime-only.
const runtimeOnlyPowerShellGates = new Set([
  'test-chat-installer.ps1',
  'test-node-runtime.ps1',
  'verify-release.ps1',
]);
const requiredPowerShellGates = [
  'release-gate.ps1',
  'test-release-artifact-name.ps1',
  'test-tester-handoff.ps1',
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

const workflowPowerShellScripts = new Set(
  [...workflow.matchAll(/^\s*run:\s*\.\/scripts\/([^\s'"`]+\.ps1)\s*$/gm)].map((match) => match[1]),
);
const workflowPowerShellGates = new Set(
  [...workflowPowerShellScripts].filter((script) => !runtimeOnlyPowerShellGates.has(script)),
);
const localPowerShellGates = new Set(
  [...localCheck.matchAll(/^\s*&\s+['"]\.\/scripts\/([^'"]+\.ps1)['"]\s*$/gm)].map((match) => match[1]),
);

for (const script of requiredPowerShellGates) {
  if (!workflowPowerShellGates.has(script)) {
    fail(`Windows CI is missing required preflight gate ${script}.`);
  }
  if (!localPowerShellGates.has(script)) {
    fail(`scripts/check.ps1 is missing Windows CI preflight gate ${script}.`);
  }
}
for (const script of workflowPowerShellGates) {
  if (!localPowerShellGates.has(script)) {
    fail(`scripts/check.ps1 is missing Windows CI PowerShell preflight gate ${script}.`);
  }
}
for (const script of localPowerShellGates) {
  if (!workflowPowerShellGates.has(script)) {
    fail(`scripts/check.ps1 contains a PowerShell gate that Windows CI does not run: ${script}`);
  }
}

const normalizeSourceCommand = (raw) => raw.trim().replace(/\s+\|\s+Out-Null\s*$/i, '').trim();
const isSourcePreflightCommand = (command) => (
  command.startsWith('npm ci ')
  || command === 'npm run audit'
  || command === 'npm run build'
  || command.startsWith('cargo metadata ')
  || command.startsWith('cargo fmt ')
  || command.startsWith('cargo clippy ')
  || command.startsWith('cargo test ')
  || command.startsWith('cargo check ')
);

const workflowSourceCommands = new Set(
  [...workflow.matchAll(/^\s*run:\s*([^\r\n]+)$/gm)]
    .map((match) => normalizeSourceCommand(match[1]))
    .filter(isSourcePreflightCommand),
);
const localSourceCommands = new Set(
  localCheck
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(normalizeSourceCommand)
    .filter(isSourcePreflightCommand),
);

for (const command of workflowSourceCommands) {
  if (!localSourceCommands.has(command)) {
    fail(`scripts/check.ps1 is missing Windows CI source command: ${command}`);
  }
}
for (const command of localSourceCommands) {
  if (!workflowSourceCommands.has(command)) {
    fail(`scripts/check.ps1 contains a source command that Windows CI does not run: ${command}`);
  }
}

const requiredSourceCommands = [
  'npm ci --no-audit --no-fund',
  'npm run audit',
  'npm run build',
  'cargo metadata --locked --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1',
  'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check',
  'cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D clippy::correctness -D clippy::suspicious -D clippy::perf',
  'cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets',
  'cargo check --locked --manifest-path src-tauri/Cargo.toml',
  'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-node',
  'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-netprobe',
];
for (const command of requiredSourceCommands) {
  if (!workflowSourceCommands.has(command)) fail(`Windows CI is missing required source command: ${command}`);
  if (!localSourceCommands.has(command)) fail(`scripts/check.ps1 is missing required source command: ${command}`);
}

if (!process.exitCode) {
  console.log(`Local/Windows CI preflight parity: ${workflowPowerShellGates.size} PowerShell gates and ${workflowSourceCommands.size} source commands aligned.`);
}
