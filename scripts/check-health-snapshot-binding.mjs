import fs from 'node:fs';
import path from 'node:path';

const healthPath = path.resolve(process.argv[2] ?? 'scripts/check-node-health.ps1');
const readinessPath = path.resolve(process.argv[3] ?? 'scripts/check-public-node-readiness.ps1');
const healthSource = fs.readFileSync(healthPath, 'utf8').replaceAll('\r\n', '\n');
const readinessSource = fs.readFileSync(readinessPath, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`HEALTH SNAPSHOT BINDING POLICY ERROR: ${message}`);
  process.exit(1);
};

if (healthSource.includes('[System.IO.FileShare]::ReadWrite')) {
  fail('health snapshot validation must deny in-place writers while the validated file handle is open.');
}
if (healthSource.includes('Get-Content -LiteralPath $Path -Raw')) {
  fail('health validation must not perform a second path-based content read after bounding the snapshot.');
}

const healthRequired = [
  'function Read-BoundedSnapshotText',
  '[System.IO.File]::Open(',
  '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
  '$snapshot = Read-BoundedSnapshotText -SnapshotPath $Path -MaxBytes $MaxSnapshotBytes',
  '$snapshotText = [string]$snapshot.Text',
  "$snapshotText.TrimStart().StartsWith('{', [System.StringComparison]::Ordinal)",
  '$health = $snapshotText | ConvertFrom-Json',
  "$health -isnot [pscustomobject]",
  "Health snapshot root must be a JSON object.",
  '[switch]$AsJson',
  '$result | ConvertTo-Json -Depth 4 -Compress',
  'snapshot_bytes = [int64]$snapshot.Bytes',
];
for (const snippet of healthRequired) {
  if (!healthSource.includes(snippet)) fail(`required single-snapshot health guard is missing: ${snippet}`);
}

const readinessRequired = [
  '$healthJsonText = (& $healthCheck @healthArgs -AsJson | Out-String).Trim()',
  '$health = $healthJsonText | ConvertFrom-Json',
  'health_snapshot_age_seconds = [int64]$health.snapshot_age_seconds',
  'health_snapshot_bytes = [int64]$health.snapshot_bytes',
];
for (const snippet of readinessRequired) {
  if (!readinessSource.includes(snippet)) fail(`required readiness health-binding guard is missing: ${snippet}`);
}

if (readinessSource.includes('Get-Content -LiteralPath $HealthPath')) {
  fail('public-node readiness must consume the checker result and never reopen HealthPath for trusted fields.');
}
if (readinessSource.includes('& $healthCheck @healthArgs *> $null')) {
  fail('public-node readiness must retain the structured result from health validation instead of discarding it.');
}

const capture = readinessSource.indexOf('$healthJsonText = (& $healthCheck @healthArgs -AsJson | Out-String).Trim()');
const parse = readinessSource.indexOf('$health = $healthJsonText | ConvertFrom-Json');
const result = readinessSource.indexOf('$result = [ordered]@{');
if (!(capture >= 0 && capture < parse && parse < result)) {
  fail('readiness ordering must validate/capture one health snapshot, parse that exact result, then build readiness evidence.');
}

console.log('Health snapshot binding policy passed: one bounded non-writable object-root snapshot feeds validation and public-node readiness evidence.');
