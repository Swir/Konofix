import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-health-snapshot-binding.mjs');
const healthPath = path.resolve('scripts/check-node-health.ps1');
const readinessPath = path.resolve('scripts/check-public-node-readiness.ps1');
const healthSource = fs.readFileSync(healthPath, 'utf8').replaceAll('\r\n', '\n');
const readinessSource = fs.readFileSync(readinessPath, 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-health-snapshot-binding-'));

const run = (healthContent, readinessContent) => {
  const candidateHealth = path.join(tempDir, 'check-node-health.ps1');
  const candidateReadiness = path.join(tempDir, 'check-public-node-readiness.ps1');
  fs.writeFileSync(candidateHealth, healthContent, 'utf8');
  fs.writeFileSync(candidateReadiness, readinessContent, 'utf8');
  return spawnSync(process.execPath, [checker, candidateHealth, candidateReadiness], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
};

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Test fixture source is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const baseline = run(healthSource, readinessSource);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical health/readiness sources must pass snapshot-binding policy before adversarial mutations run.');
}

const cases = [
  {
    name: 'health checker falls back to path-based Get-Content',
    health: mutateOnce(
      healthSource,
      '$snapshot = Read-BoundedSnapshotText -SnapshotPath $Path -MaxBytes $MaxSnapshotBytes',
      '$snapshot = [pscustomobject]@{ Text = (Get-Content -LiteralPath $Path -Raw); Bytes = 1 }',
    ),
    readiness: readinessSource,
    expected: 'required single-snapshot health guard is missing',
  },
  {
    name: 'bounded reader no longer opens a stable file handle',
    health: mutateOnce(healthSource, '[System.IO.File]::Open(', '[System.IO.File]::OpenText('),
    readiness: readinessSource,
    expected: 'required single-snapshot health guard is missing',
  },
  {
    name: 'readiness discards structured health output',
    health: healthSource,
    readiness: mutateOnce(
      readinessSource,
      '$healthJsonText = (& $healthCheck @healthArgs -AsJson | Out-String).Trim()',
      '& $healthCheck @healthArgs *> $null',
    ),
    expected: 'required readiness health-binding guard is missing',
  },
  {
    name: 'readiness reopens HealthPath after validation',
    health: healthSource,
    readiness: mutateOnce(
      readinessSource,
      '$health = $healthJsonText | ConvertFrom-Json',
      '$health = Get-Content -LiteralPath $HealthPath -Raw | ConvertFrom-Json',
    ),
    expected: 'required readiness health-binding guard is missing',
  },
  {
    name: 'structured snapshot byte evidence removed',
    health: healthSource,
    readiness: mutateOnce(
      readinessSource,
      '    health_snapshot_bytes = [int64]$health.snapshot_bytes\n',
      '',
    ),
    expected: 'required readiness health-binding guard is missing',
  },
];

for (const testCase of cases) {
  const result = run(testCase.health, testCase.readiness);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the health snapshot binding checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`Health snapshot binding adversarial policy tests passed (${cases.length} mutations rejected).`);
