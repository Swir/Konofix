import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-promotion-evidence-snapshot-binding.mjs');
const files = [
  'scripts/evidence-snapshot.ps1',
  'scripts/validate-network-test-report.ps1',
  'scripts/validate-network-test-session.ps1',
  'scripts/release-gate.ps1',
  'scripts/check-promotion-evidence.ps1',
];
const canonical = Object.fromEntries(files.map((name) => [name, fs.readFileSync(name, 'utf8').replaceAll('\r\n', '\n')]));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-promotion-evidence-binding-'));

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Mutation source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`Mutation source is not unique: ${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const run = (overrides = {}) => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(tempRoot, 'scripts'), { recursive: true });
  for (const name of files) {
    fs.writeFileSync(path.join(tempRoot, name), overrides[name] ?? canonical[name], 'utf8');
  }
  return spawnSync(process.execPath, [checker], { cwd: tempRoot, encoding: 'utf8' });
};

const baseline = run();
if (baseline.status !== 0) {
  throw new Error(`Canonical promotion evidence snapshot policy must pass before mutations.\n${baseline.stdout}\n${baseline.stderr}`);
}

const cases = [
  {
    name: 'helper permits in-place writers',
    file: 'scripts/evidence-snapshot.ps1',
    from: '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
    to: '[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete',
    expected: 'must deny in-place writers',
  },
  {
    name: 'helper loses strict UTF-8 decoding',
    file: 'scripts/evidence-snapshot.ps1',
    from: '[System.Text.UTF8Encoding]::new($false, $true)',
    to: '[System.Text.UTF8Encoding]::new($false, $false)',
    expected: 'is missing required guard',
  },
  {
    name: 'report validator reopens the manifest path',
    file: 'scripts/validate-network-test-report.ps1',
    from: '$data = $snapshot.Data',
    to: '$data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json',
    expected: 'must not reopen manifest paths',
  },
  {
    name: 'report validator drops structured aggregate mode',
    file: 'scripts/validate-network-test-report.ps1',
    from: '    [switch]$AsJson\n)',
    to: ')',
    expected: 'is missing required guard',
  },
  {
    name: 'session validator hashes path separately',
    file: 'scripts/validate-network-test-session.ps1',
    from: "    $snapshot = Read-KonofixBoundedJsonSnapshot -Path $manifestFullPath -MaxBytes 262144 -Label 'Network manifest'",
    to: "    $snapshot = Read-KonofixBoundedJsonSnapshot -Path $manifestFullPath -MaxBytes 262144 -Label 'Network manifest'\n    $legacyHash = Get-FileHash -LiteralPath $manifestFullPath -Algorithm SHA256",
    expected: 'must bind inventory/hash/parse',
  },
  {
    name: 'session validator stops comparing report hashes to captured bytes',
    file: 'scripts/validate-network-test-session.ps1',
    from: '        Assert-True ([string]$validatedManifest.sha256 -ceq [string]$captured.Sha256) "Network evidence SHA-256 changed between session and report validation: $validatedName"\n',
    to: '',
    expected: 'is missing required guard',
  },
  {
    name: 'release gate reopens evidence manifests',
    file: 'scripts/release-gate.ps1',
    from: '      $expectedBootstrapPeer = [string]$networkValidation.bootstrap_peer_id',
    to: "      $manifestPath = $NetworkEvidence[0]\n      $legacyManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json\n      $expectedBootstrapPeer = [string]$networkValidation.bootstrap_peer_id",
    expected: 'must consume the validated aggregate',
  },
  {
    name: 'release gate stops requesting structured report output',
    file: 'scripts/release-gate.ps1',
    from: "validate-network-test-report.ps1') @validatorArgs -AsJson",
    to: "validate-network-test-report.ps1') @validatorArgs",
    expected: 'is missing required guard',
  },
  {
    name: 'stable promotion preflight reparses BUILD_INFO from the path',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '$buildInfo = $buildInfoSnapshot.Data',
    to: '$buildInfo = Get-Content -LiteralPath $buildInfoFullPath -Raw | ConvertFrom-Json',
    expected: 'restored a split path trust boundary',
  },
  {
    name: 'stable promotion preflight restores split Node size verification',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '$actualNodeBytes = [int64]$verifiedNode.Bytes',
    to: '$actualNodeBytes = [int64](Get-Item -LiteralPath $nodeBinaryPath).Length',
    expected: 'restored a split path trust boundary',
  },
  {
    name: 'stable promotion preflight reopens a validated manifest',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '$bootstrapPeer = [string]$sessionBootstrapProperty.Value',
    to: "$manifestPath = $resolvedNetworkEvidence[0]\n  $legacyManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json\n  $bootstrapPeer = [string]$sessionBootstrapProperty.Value",
    expected: 'restored a split path trust boundary',
  },
  {
    name: 'stable promotion preflight drops configurable evidence age policy',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '    -RequireAllChecks `\n    -MaxAgeDays $NetworkEvidenceMaxAgeDays `\n',
    to: '    -RequireAllChecks `\n',
    expected: 'is missing required guard',
  },
  {
    name: 'stable promotion preflight stops binding report and session hashes',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '    if ([string]$snapshot.sha256 -cne [string]$sessionSnapshot.sha256) {\n      throw "Network evidence SHA-256 changed between report and session validation: $name"\n    }\n',
    to: '',
    expected: 'is missing required guard',
  },
  {
    name: 'stable promotion preflight drops the held Node lock cleanup',
    file: 'scripts/check-promotion-evidence.ps1',
    from: '    $verifiedNode.Stream.Dispose()\n',
    to: '',
    expected: 'is missing required guard',
  },
];

for (const testCase of cases) {
  const mutated = mutateOnce(canonical[testCase.file], testCase.from, testCase.to);
  const result = run({ [testCase.file]: mutated });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) throw new Error(`Mutation '${testCase.name}' unexpectedly passed.`);
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`Promotion evidence snapshot binding adversarial tests passed (${cases.length} mutations rejected).`);
