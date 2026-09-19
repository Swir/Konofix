import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const validatorPath = process.env.KONOFIX_CLIENT_NETPROBE_VALIDATOR ?? 'scripts/validate-client-netprobe.ps1';
const helperPath = process.env.KONOFIX_SNAPSHOT_HELPER ?? 'scripts/evidence-snapshot.ps1';
const read = (name) => fs.readFileSync(path.resolve(root, name), 'utf8').replaceAll('\r\n', '\n');

const validator = read(validatorPath);
const helper = read(helperPath);

const fail = (message) => {
  console.error(`CLIENT NETPROBE SNAPSHOT POLICY ERROR: ${message}`);
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
  '$capturedBytes = [byte[]]::new($totalRead)',
  '[Array]::Copy($buffer, 0, $capturedBytes, 0, $totalRead)',
  '$digest = $sha.ComputeHash($capturedBytes)',
  'ContentBytes = $capturedBytes',
  'function Open-KonofixVerifiedExecutable',
  '[System.IO.FileShare]::Read,\n            4096,',
]);

for (const forbidden of [
  'function Read-BoundedJson',
  'Get-Content -LiteralPath $Path -Raw',
  '$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath',
  '$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath',
  'Test-Path -LiteralPath $netprobePath -PathType Leaf',
  'Get-Item -LiteralPath $netprobePath',
  'Get-FileHash -LiteralPath $netprobePath',
]) {
  if (validator.includes(forbidden)) {
    fail(`client Netprobe validator restored a split path read/hash trust boundary: ${forbidden}`);
  }
}

requireAll(validator, 'client Netprobe validator', [
  ". $snapshotHelper",
  "$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'",
  "$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $buildInfoPath -MaxBytes 262144 -Label 'BUILD_INFO.json'",
  '$sessionInfoPath = [string]$sessionSnapshot.Path',
  '$buildInfoPath = [string]$buildInfoSnapshot.Path',
  '$session = $sessionSnapshot.Data',
  '$buildInfo = $buildInfoSnapshot.Data',
  '$actualBuildInfoHash = [string]$buildInfoSnapshot.Sha256',
  '$actualSessionInfoHash = [string]$sessionSnapshot.Sha256',
  '$verifiedNetprobe = Open-KonofixVerifiedExecutable',
  '-Path $netprobePath',
  '-ExpectedBytes $netprobeBytes',
  '-ExpectedSha256 $netprobeHash',
  '$actualNetprobeHash = [string]$verifiedNetprobe.Sha256',
  "$evidenceSnapshot = Read-KonofixBoundedJsonSnapshot -Path $path -MaxBytes $MaxEvidenceBytes -Label 'Client netprobe evidence'",
  '$path = [string]$evidenceSnapshot.Path',
  '$data = $evidenceSnapshot.Data',
  'snapshot_bytes = [int64]$evidenceSnapshot.Bytes',
  'snapshot_sha256 = [string]$evidenceSnapshot.Sha256',
  'finally {',
  '$verifiedNetprobe.Stream.Dispose()',
]);

const lockIndex = validator.indexOf('$verifiedNetprobe = Open-KonofixVerifiedExecutable');
const evidenceLoopIndex = validator.indexOf('foreach ($path in $resolvedEvidence)');
const resultIndex = validator.indexOf('$result = [ordered]@{');
const disposeIndex = validator.indexOf('$verifiedNetprobe.Stream.Dispose()');
if (!(lockIndex >= 0 && lockIndex < evidenceLoopIndex && evidenceLoopIndex < resultIndex && resultIndex < disposeIndex)) {
  fail('verified Netprobe read lock must remain held from exact-byte verification through evidence validation and result construction.');
}

const disposeCount = validator.split('$verifiedNetprobe.Stream.Dispose()').length - 1;
if (disposeCount !== 1) {
  fail(`verified Netprobe lock must be disposed exactly once from the final cleanup path; found ${disposeCount}.`);
}

console.log('Client Netprobe snapshot binding policy passed: promotion JSON parsing/provenance and the verified Netprobe executable stay bound to exact bytes, with the executable write/replacement lock held through evidence validation.');
