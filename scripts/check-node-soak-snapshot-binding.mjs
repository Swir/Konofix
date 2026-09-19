import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const validatorPath = process.env.KONOFIX_SOAK_VALIDATOR ?? 'scripts/validate-node-soak.ps1';
const helperPath = process.env.KONOFIX_SNAPSHOT_HELPER ?? 'scripts/evidence-snapshot.ps1';
const read = (name) => fs.readFileSync(path.resolve(root, name), 'utf8').replaceAll('\r\n', '\n');

const validator = read(validatorPath);
const helper = read(helperPath);

const fail = (message) => {
  console.error(`NODE SOAK SNAPSHOT POLICY ERROR: ${message}`);
  process.exit(1);
};

const requireAll = (source, label, snippets) => {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) fail(`${label} is missing required guard: ${snippet}`);
  }
};

if (helper.includes('[System.IO.FileShare]::ReadWrite')) {
  fail('shared evidence snapshot helper must deny in-place writers while exact bytes are captured.');
}
requireAll(helper, 'shared evidence snapshot helper', [
  'function Read-KonofixBoundedJsonSnapshot',
  '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
  '[System.Text.UTF8Encoding]::new($false, $true)',
  ".TrimStart().StartsWith('{', [System.StringComparison]::Ordinal)",
  '$sha.ComputeHash($buffer, 0, $totalRead)',
]);

for (const forbidden of [
  'Get-Item -LiteralPath $path',
  'Get-Content -LiteralPath $path',
  'Get-FileHash -LiteralPath $path',
  '$snapshot = Read-KonofixBoundedJsonSnapshot',
]) {
  if (validator.includes(forbidden)) {
    fail(`node soak validator must not restore an unsafe path reread or collide with the typed Snapshot parameter: ${forbidden}`);
  }
}

requireAll(validator, 'node soak validator', [
  ". (Join-Path $PSScriptRoot 'evidence-snapshot.ps1')",
  "$capturedSnapshot = Read-KonofixBoundedJsonSnapshot -Path $path -MaxBytes $MaxSnapshotBytes -Label 'Node soak snapshot'",
  '$health = $capturedSnapshot.Data',
  '$validatedPath = [string]$capturedSnapshot.Path',
  'bytes = [int64]$capturedSnapshot.Bytes',
  'sha256 = [string]$capturedSnapshot.Sha256',
]);

console.log('Node soak snapshot binding policy passed: stable-promotion soak parsing stays bound to bounded strict-UTF-8 captured bytes without typed-parameter shadowing.');
