import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n');
const helper = read('scripts/evidence-snapshot.ps1');
const report = read('scripts/validate-network-test-report.ps1');
const session = read('scripts/validate-network-test-session.ps1');
const gate = read('scripts/release-gate.ps1');

const fail = (message) => {
  console.error(`PROMOTION EVIDENCE SNAPSHOT POLICY ERROR: ${message}`);
  process.exit(1);
};

const requireAll = (source, label, snippets) => {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) fail(`${label} is missing required guard: ${snippet}`);
  }
};

if (helper.includes('[System.IO.FileShare]::ReadWrite')) {
  fail('evidence snapshot helper must deny in-place writers while exact bytes are captured.');
}
requireAll(helper, 'evidence snapshot helper', [
  'function Read-KonofixBoundedJsonSnapshot',
  '[System.IO.File]::Open(',
  '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
  '[System.Text.UTF8Encoding]::new($false, $true)',
  ".TrimStart().StartsWith('{', [System.StringComparison]::Ordinal)",
  '$sha.ComputeHash($buffer, 0, $totalRead)',
  'Bytes = [int64]$totalRead',
  'Sha256 = $sha256',
  'Data = $value',
]);

if (report.includes('Get-Content -LiteralPath $path') || report.includes('Get-FileHash -LiteralPath $path')) {
  fail('network evidence validator must not reopen manifest paths after snapshot capture.');
}
requireAll(report, 'network evidence validator', [
  ". (Join-Path $PSScriptRoot 'evidence-snapshot.ps1')",
  '$snapshot = Read-KonofixBoundedJsonSnapshot -Path $path -MaxBytes $MaxManifestBytes',
  '$data = $snapshot.Data',
  '[switch]$AsJson',
  'bootstrap_peer_id = if ($bootstrapPeerIds.Count -eq 1)',
  'bytes = [int64]$snapshot.Bytes',
  'sha256 = [string]$snapshot.Sha256',
]);

if (session.includes('Get-FileHash -LiteralPath $manifestFullPath') || session.includes('Get-Content -LiteralPath $path -Raw')) {
  fail('network session validator must bind inventory/hash/parse to captured manifest snapshots.');
}
requireAll(session, 'network session validator', [
  ". (Join-Path $PSScriptRoot 'evidence-snapshot.ps1')",
  '$sessionSnapshot = Read-KonofixBoundedJsonSnapshot',
  '$snapshot = Read-KonofixBoundedJsonSnapshot -Path $manifestFullPath',
  '$manifestSnapshotsByName.Add($manifestName, $snapshot)',
  '$data = $snapshot.Data',
  '[int64]$validatedManifest.bytes -eq [int64]$captured.Bytes',
  '[string]$validatedManifest.sha256 -ceq [string]$captured.Sha256',
  'session_info_sha256 = [string]$sessionSnapshot.Sha256',
]);

if (gate.includes('Get-Content -LiteralPath $manifestPath')) {
  fail('release gate must consume the validated aggregate instead of reopening network evidence manifests.');
}
requireAll(gate, 'release gate', [
  "validate-network-test-report.ps1') @validatorArgs -AsJson",
  '$expectedBootstrapPeer = [string]$networkValidation.bootstrap_peer_id',
  "Network evidence validator did not return the expected PASS aggregate.",
]);

console.log('Promotion evidence snapshot binding policy passed: release/session/report decisions stay bound to validated bytes.');
