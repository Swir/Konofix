import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const editorPath = process.env.KONOFIX_NETWORK_REPORT_EDITOR ?? 'scripts/set-network-test-result.ps1';
const snapshotPath = process.env.KONOFIX_SNAPSHOT_HELPER ?? 'scripts/evidence-snapshot.ps1';
const read = (name) => fs.readFileSync(path.resolve(root, name), 'utf8').replaceAll('\r\n', '\n');

const editor = read(editorPath);
const snapshot = read(snapshotPath);

const fail = (message) => {
  console.error(`NETWORK REPORT EDITOR SNAPSHOT POLICY ERROR: ${message}`);
  process.exit(1);
};

const requireAll = (source, label, snippets) => {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) fail(`${label} is missing required guard: ${snippet}`);
  }
};

for (const forbidden of [
  'Get-Content -LiteralPath $manifestFull -Raw | ConvertFrom-Json',
  'Get-Item -LiteralPath $sessionInfoPath',
  '[IO.File]::ReadAllBytes($sessionInfoPath)',
  'Get-Content -LiteralPath $sessionInfoPath -Raw | ConvertFrom-Json',
  '[IO.File]::ReadAllBytes($manifestFull)',
  'Get-FileHash -LiteralPath $manifestFull',
  'Get-FileHash -LiteralPath $sessionInfoPath',
  'Get-Item -LiteralPath $manifestTemp -Force',
  'Get-FileHash -LiteralPath $manifestTemp',
  'Set-Content -LiteralPath $manifestTemp',
  'Set-Content -LiteralPath $sessionTemp',
]) {
  if (editor.includes(forbidden)) fail(`network report editor restored a split path trust boundary: ${forbidden}`);
}

requireAll(editor, 'network report editor', [
  ". $snapshotHelper",
  "$manifestSnapshot = Read-KonofixBoundedJsonSnapshot -Path $Manifest -MaxBytes (256KB) -Label 'Network test manifest'",
  '$manifestFull = [string]$manifestSnapshot.Path',
  '$data = $manifestSnapshot.Data',
  '$originalManifestBytes = [byte[]]$manifestSnapshot.ContentBytes',
  '$originalManifestSha256 = [string]$manifestSnapshot.Sha256',
  "$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes (256KB) -Label 'SESSION_INFO.json'",
  '$sessionData = $sessionSnapshot.Data',
  '$originalSessionBytes = [byte[]]$sessionSnapshot.ContentBytes',
  '$originalSessionSha256 = [string]$sessionSnapshot.Sha256',
  'function ConvertTo-KonofixUtf8JsonBytes',
  'function Get-KonofixSha256Hex',
  '$newManifestBytes = ConvertTo-KonofixUtf8JsonBytes -Value $data -Depth 8',
  '$newManifestSha256 = Get-KonofixSha256Hex -Bytes $newManifestBytes',
  '[IO.File]::WriteAllBytes($manifestTemp, $newManifestBytes)',
  '$sessionInventoryEntry.bytes = [int64]$newManifestBytes.Length',
  '$sessionInventoryEntry.sha256 = $newManifestSha256',
  '$newSessionBytes = ConvertTo-KonofixUtf8JsonBytes -Value $sessionData -Depth 8',
  '[IO.File]::WriteAllBytes($sessionTemp, $newSessionBytes)',
  '[IO.File]::WriteAllBytes($manifestFull, $originalManifestBytes)',
  '[IO.File]::WriteAllBytes($sessionInfoPath, $originalSessionBytes)',
]);

requireAll(snapshot, 'shared evidence snapshot helper', [
  'function Read-KonofixBoundedJsonSnapshot',
  'ContentBytes = $capturedBytes',
  'Sha256 = $sha256',
]);

const manifestSnapshotIndex = editor.indexOf('$manifestSnapshot = Read-KonofixBoundedJsonSnapshot');
const sessionSnapshotIndex = editor.indexOf('$sessionSnapshot = Read-KonofixBoundedJsonSnapshot');
const sessionValidationIndex = editor.indexOf('& $sessionValidator -SessionInfoPath $sessionInfoPath -Manifest $sessionManifestPaths');
const manifestSerializationIndex = editor.indexOf('$newManifestBytes = ConvertTo-KonofixUtf8JsonBytes');
const manifestCommitIndex = editor.indexOf('Move-Item -LiteralPath $manifestTemp -Destination $manifestFull -Force');
if (manifestSnapshotIndex < 0 || sessionSnapshotIndex < 0 || sessionValidationIndex < 0 || manifestSerializationIndex < 0 || manifestCommitIndex < 0) {
  fail('network report editor snapshot/validation/commit ordering anchors are incomplete.');
}
if (!(manifestSnapshotIndex < sessionSnapshotIndex && sessionSnapshotIndex < sessionValidationIndex && sessionValidationIndex < manifestSerializationIndex && manifestSerializationIndex < manifestCommitIndex)) {
  fail('network report editor must snapshot authoritative inputs, validate the full session, then serialize and commit replacements.');
}

console.log('Network report editor snapshot binding policy passed: authoritative input semantics/rollback bytes/SHA-256 values share exact snapshots and replacement manifest/session provenance is derived from one serialized byte sequence each.');
