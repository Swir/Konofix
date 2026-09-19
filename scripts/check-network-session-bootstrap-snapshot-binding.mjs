import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sessionPath = process.env.KONOFIX_NETWORK_SESSION_BOOTSTRAP ?? 'scripts/new-network-test-session.ps1';
const snapshotPath = process.env.KONOFIX_SNAPSHOT_HELPER ?? 'scripts/evidence-snapshot.ps1';
const read = (name) => fs.readFileSync(path.resolve(root, name), 'utf8').replaceAll('\r\n', '\n');

const session = read(sessionPath);
const snapshot = read(snapshotPath);

const fail = (message) => {
  console.error(`NETWORK SESSION SNAPSHOT POLICY ERROR: ${message}`);
  process.exit(1);
};

const requireAll = (source, label, snippets) => {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) fail(`${label} is missing required guard: ${snippet}`);
  }
};

for (const forbidden of [
  'function Read-BoundedJson',
  'Copy-Item -LiteralPath $BuildInfoPath',
  'Get-FileHash -LiteralPath $BuildInfoPath',
  'Get-Item -LiteralPath $nodePath',
  'Get-FileHash -LiteralPath $nodePath',
]) {
  if (session.includes(forbidden)) fail(`session bootstrap restored a split path trust boundary: ${forbidden}`);
}

requireAll(session, 'network session bootstrap', [
  ". $snapshotHelper",
  "$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $BuildInfoPath -MaxBytes (256KB) -Label 'BUILD_INFO.json'",
  '$BuildInfoPath = [string]$buildInfoSnapshot.Path',
  '$buildInfo = $buildInfoSnapshot.Data',
  '$buildInfoHash = [string]$buildInfoSnapshot.Sha256',
  "$nodeLock = Open-KonofixVerifiedExecutable -Path $nodePath -ExpectedBytes ([int64]$nodeMeta.bytes) -ExpectedSha256 $nodeHash -Label 'Konofix Node'",
  '$nodePath = [string]$nodeLock.Path',
  '$nodeHash = [string]$nodeLock.Sha256',
  '[IO.File]::WriteAllBytes($sessionBuildInfoPath, [byte[]]$buildInfoSnapshot.ContentBytes)',
  'build_info_sha256 = $buildInfoHash',
  'node_sha256 = $nodeHash',
  '$nodeLock.Stream.Dispose()',
]);

requireAll(snapshot, 'shared evidence snapshot helper', [
  '$capturedBytes = [byte[]]::new($totalRead)',
  '[Array]::Copy($buffer, 0, $capturedBytes, 0, $totalRead)',
  '$digest = $sha.ComputeHash($capturedBytes)',
  'ContentBytes = $capturedBytes',
  'function Open-KonofixVerifiedExecutable',
]);

const lockIndex = session.indexOf('$nodeLock = Open-KonofixVerifiedExecutable');
const copyIndex = session.indexOf('[IO.File]::WriteAllBytes($sessionBuildInfoPath', lockIndex);
const sessionWriteIndex = session.indexOf("Set-Content -LiteralPath (Join-Path $stagingDirectory 'SESSION_INFO.json')", copyIndex);
const disposeIndexes = [...session.matchAll(/\$nodeLock\.Stream\.Dispose\(\)/g)].map((match) => match.index);
if (lockIndex < 0 || copyIndex < 0 || sessionWriteIndex < 0 || disposeIndexes.length !== 1) {
  fail('session bootstrap must hold one verified Node lock through exact BUILD_INFO copy and SESSION_INFO creation.');
}
const disposeIndex = disposeIndexes[0];
if (!(lockIndex < copyIndex && copyIndex < sessionWriteIndex && sessionWriteIndex < disposeIndex)) {
  fail('verified Node lock is released before exact session provenance has been committed.');
}

console.log('Network session snapshot binding policy passed: BUILD_INFO semantics/copy/hash share one snapshot and the verified Node remains protected until SESSION_INFO provenance is written.');
