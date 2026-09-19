import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const capturePath = process.env.KONOFIX_CLIENT_NETPROBE_CAPTURE ?? 'scripts/capture-client-netprobe.ps1';
const snapshotPath = process.env.KONOFIX_SNAPSHOT_HELPER ?? 'scripts/evidence-snapshot.ps1';
const read = (name) => fs.readFileSync(path.resolve(root, name), 'utf8').replaceAll('\r\n', '\n');

const capture = read(capturePath);
const snapshot = read(snapshotPath);

const fail = (message) => {
  console.error(`CLIENT NETPROBE CAPTURE POLICY ERROR: ${message}`);
  process.exit(1);
};

const requireAll = (source, label, snippets) => {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) fail(`${label} is missing required guard: ${snippet}`);
  }
};

for (const forbidden of [
  'function Read-BoundedJson',
  'Get-Content -LiteralPath $Path -Raw',
  '$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath',
  '$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath',
  '$actualNetprobeHash = (Get-FileHash -LiteralPath $netprobePath',
  '[int64](Get-Item -LiteralPath $netprobePath).Length',
]) {
  if (capture.includes(forbidden)) fail(`capture restored a split path trust boundary: ${forbidden}`);
}

requireAll(capture, 'client Netprobe capture', [
  ". $snapshotHelper",
  "$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'",
  "$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $buildInfoPath -MaxBytes 262144 -Label 'BUILD_INFO.json'",
  '$sessionInfoPath = [string]$sessionSnapshot.Path',
  '$buildInfoPath = [string]$buildInfoSnapshot.Path',
  '$actualBuildInfoHash = [string]$buildInfoSnapshot.Sha256',
  '$actualSessionInfoHash = [string]$sessionSnapshot.Sha256',
  "$netprobeLock = Open-KonofixVerifiedExecutable -Path $netprobePath -ExpectedBytes $netprobeBytes -ExpectedSha256 $netprobeHash -Label 'Konofix Netprobe'",
  '$netprobePath = [string]$netprobeLock.Path',
  '$actualNetprobeHash = [string]$netprobeLock.Sha256',
]);

requireAll(snapshot, 'shared evidence/executable snapshot helper', [
  'function Read-KonofixBoundedJsonSnapshot',
  '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
  '$capturedBytes = [byte[]]::new($totalRead)',
  '[Array]::Copy($buffer, 0, $capturedBytes, 0, $totalRead)',
  '[System.Text.UTF8Encoding]::new($false, $true)',
  '$digest = $sha.ComputeHash($capturedBytes)',
  'ContentBytes = $capturedBytes',
  'function Open-KonofixVerifiedExecutable',
  '$digest = $sha.ComputeHash($stream)',
  '$stream.Position = 0',
  'Stream = $stream',
  '$stream.Dispose()',
]);

const executableFunctionStart = snapshot.indexOf('function Open-KonofixVerifiedExecutable');
const executableFunction = executableFunctionStart >= 0 ? snapshot.slice(executableFunctionStart) : '';
if (!executableFunction.includes('[System.IO.FileShare]::Read')) {
  fail('verified executable helper must permit read sharing so the verified path remains launchable while locked.');
}
for (const forbiddenShare of ['[System.IO.FileShare]::ReadWrite', '[System.IO.FileShare]::Delete', '[System.IO.FileShare]::None']) {
  if (executableFunction.includes(forbiddenShare)) {
    fail(`verified executable helper has an unsafe/incompatible share mode: ${forbiddenShare}`);
  }
}

const lockIndex = capture.indexOf('$netprobeLock = Open-KonofixVerifiedExecutable');
const tcpIndex = capture.indexOf('$tcpProbe = Invoke-Netprobe', lockIndex);
const quicIndex = capture.indexOf('$quicProbe = Invoke-Netprobe', tcpIndex);
const disposeIndexes = [...capture.matchAll(/\$netprobeLock\.Stream\.Dispose\(\)/g)].map((match) => match.index);
if (lockIndex < 0 || tcpIndex < 0 || quicIndex < 0 || disposeIndexes.length !== 1) {
  fail('capture must have one verified executable lock spanning both TCP and QUIC probe launches.');
}
const disposeIndex = disposeIndexes[0];
if (!(lockIndex < tcpIndex && tcpIndex < quicIndex && quicIndex < disposeIndex)) {
  fail('verified executable lock is released before the complete TCP + QUIC capture window finishes.');
}

console.log('Client Netprobe capture binding policy passed: JSON provenance uses exact snapshots and the verified executable remains read-share launchable while locked through TCP + QUIC capture.');
