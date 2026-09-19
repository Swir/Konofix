import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-local-ci-parity.mjs');
const workflowSource = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-ci.yml'), 'utf8');
const localSource = fs.readFileSync(path.join(root, 'scripts', 'check.ps1'), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-ci-parity-'));

const writeFixture = (name, content) => {
  const target = path.join(tempDir, name);
  fs.writeFileSync(target, content, 'utf8');
  return target;
};

const runChecker = (workflow, localCheck) => spawnSync(process.execPath, [checker], {
  cwd: root,
  env: {
    ...process.env,
    KONOFIX_PARITY_WORKFLOW: workflow,
    KONOFIX_PARITY_LOCAL_CHECK: localCheck,
  },
  encoding: 'utf8',
});

const removeLineContaining = (source, needle) => {
  const lines = source.split(/\r?\n/);
  const filtered = lines.filter((line) => !line.includes(needle));
  if (filtered.length === lines.length) {
    throw new Error(`Fixture mutation could not find: ${needle}`);
  }
  return filtered.join('\n');
};

const expectPass = (label, workflow, localCheck) => {
  const result = runChecker(workflow, localCheck);
  if (result.status !== 0) {
    throw new Error(`${label}: expected PASS, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
};

const expectFail = (label, workflow, localCheck) => {
  const result = runChecker(workflow, localCheck);
  if (result.status === 0) {
    throw new Error(`${label}: expected failure but parity checker returned PASS.`);
  }
};

try {
  const workflowFixture = writeFixture('windows-ci.yml', workflowSource);
  const localFixture = writeFixture('check.ps1', localSource);
  expectPass('baseline repository parity', workflowFixture, localFixture);

  const missingReleaseNaming = removeLineContaining(localSource, "& '.\\scripts\\test-release-artifact-name.ps1'");
  const missingReleaseNamingFixture = writeFixture('check-missing-release-artifact-name.ps1', missingReleaseNaming);
  expectFail('missing release artifact naming gate', workflowFixture, missingReleaseNamingFixture);

  const workflowMissingReleaseNaming = removeLineContaining(
    workflowSource,
    'run: .\\scripts\\test-release-artifact-name.ps1',
  );
  const workflowMissingReleaseNamingFixture = writeFixture('windows-ci-missing-release-artifact-name.yml', workflowMissingReleaseNaming);
  expectFail('Windows CI cannot silently drop the release artifact naming gate', workflowMissingReleaseNamingFixture, localFixture);

  const missingNetprobeEvidence = removeLineContaining(localSource, "& '.\\scripts\\test-client-netprobe-evidence.ps1'");
  const missingGateFixture = writeFixture('check-missing-netprobe-evidence.ps1', missingNetprobeEvidence);
  expectFail('missing Netprobe evidence gate', workflowFixture, missingGateFixture);

  const commentDecoy = `${missingNetprobeEvidence}\n# & '.\\scripts\\test-client-netprobe-evidence.ps1'\n`;
  const commentDecoyFixture = writeFixture('check-comment-decoy.ps1', commentDecoy);
  expectFail('comment cannot impersonate an active PowerShell gate', workflowFixture, commentDecoyFixture);

  const workflowExtraGate = `${workflowSource}\n      - name: Synthetic future source gate\n        shell: pwsh\n        run: .\\scripts\\future-source-gate.ps1\n`;
  const workflowExtraGateFixture = writeFixture('windows-ci-extra-source-gate.yml', workflowExtraGate);
  expectFail('new Windows CI PowerShell preflight must be mirrored locally', workflowExtraGateFixture, localFixture);

  const localExtraPowerShellGate = `${localSource}\n& '.\\scripts\\future-local-only-gate.ps1'\n`;
  const localExtraPowerShellFixture = writeFixture('check-extra-powershell-gate.ps1', localExtraPowerShellGate);
  expectFail('local PowerShell preflight cannot drift away from Windows CI', workflowFixture, localExtraPowerShellFixture);

  const missingNetprobeCargo = removeLineContaining(
    localSource,
    'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-netprobe',
  );
  const missingCargoFixture = writeFixture('check-missing-netprobe-cargo.ps1', missingNetprobeCargo);
  expectFail('missing locked Netprobe Cargo check', workflowFixture, missingCargoFixture);

  const workflowMissingNodeCheck = removeLineContaining(
    workflowSource,
    'cargo check --locked --manifest-path src-tauri/Cargo.toml --bin konofix-node',
  );
  const workflowMissingFixture = writeFixture('windows-ci-missing-node.yml', workflowMissingNodeCheck);
  expectFail('Windows CI cannot silently drop a required Rust target', workflowMissingFixture, localFixture);

  const localMissingTests = removeLineContaining(
    localSource,
    'cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets',
  );
  const localMissingTestsFixture = writeFixture('check-missing-cargo-tests.ps1', localMissingTests);
  expectFail('local preflight cannot silently drop all-target Rust tests', workflowFixture, localMissingTestsFixture);

  const workflowMissingFrontendBuild = removeLineContaining(workflowSource, 'run: npm run build');
  const workflowMissingFrontendBuildFixture = writeFixture('windows-ci-missing-frontend-build.yml', workflowMissingFrontendBuild);
  expectFail('Windows CI cannot silently drop the frontend production build', workflowMissingFrontendBuildFixture, localFixture);

  const localExtraSourceGate = `${localSource}\ncargo check --locked --manifest-path src-tauri/Cargo.toml --bin imaginary-target\n`;
  const localExtraSourceGateFixture = writeFixture('check-extra-source-gate.ps1', localExtraSourceGate);
  expectFail('local preflight cannot drift to an unmirrored source command', workflowFixture, localExtraSourceGateFixture);

  console.log('Local/Windows CI parity adversarial self-tests: PASS');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
