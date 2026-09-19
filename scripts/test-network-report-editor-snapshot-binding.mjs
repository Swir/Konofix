import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.resolve(root, 'scripts/check-network-report-editor-snapshot-binding.mjs');
const sourceEditor = fs.readFileSync(path.resolve(root, 'scripts/set-network-test-result.ps1'), 'utf8');
const sourceSnapshot = fs.readFileSync(path.resolve(root, 'scripts/evidence-snapshot.ps1'), 'utf8');

const run = (editor, snapshot, expectSuccess, label) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-report-editor-snapshot-policy-'));
  try {
    const editorPath = path.join(temp, 'set-network-test-result.ps1');
    const snapshotPath = path.join(temp, 'evidence-snapshot.ps1');
    fs.writeFileSync(editorPath, editor);
    fs.writeFileSync(snapshotPath, snapshot);
    const result = spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        KONOFIX_NETWORK_REPORT_EDITOR: editorPath,
        KONOFIX_SNAPSHOT_HELPER: snapshotPath,
      },
    });
    if (expectSuccess && result.status !== 0) {
      throw new Error(`${label}: expected PASS, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    if (!expectSuccess && result.status === 0) {
      throw new Error(`${label}: expected rejection, but policy checker passed.`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};

run(sourceEditor, sourceSnapshot, true, 'baseline');
run(
  sourceEditor.replace(
    "$manifestSnapshot = Read-KonofixBoundedJsonSnapshot -Path $Manifest -MaxBytes (256KB) -Label 'Network test manifest'",
    '$data = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json',
  ),
  sourceSnapshot,
  false,
  'manifest split-read regression',
);
run(
  sourceEditor.replace(
    "$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes (256KB) -Label 'SESSION_INFO.json'",
    '$sessionData = Get-Content -LiteralPath $sessionInfoPath -Raw | ConvertFrom-Json',
  ),
  sourceSnapshot,
  false,
  'session split-read regression',
);
run(
  sourceEditor.replace(
    '$newManifestSha256 = Get-KonofixSha256Hex -Bytes $newManifestBytes',
    '$newManifestSha256 = (Get-FileHash -LiteralPath $manifestTemp -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
  sourceSnapshot,
  false,
  'replacement manifest path-rehash regression',
);
run(
  sourceEditor.replace(
    '[IO.File]::WriteAllBytes($manifestTemp, $newManifestBytes)',
    '$data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestTemp -Encoding utf8',
  ),
  sourceSnapshot,
  false,
  'replacement manifest reserialization regression',
);
run(
  sourceEditor.replace(
    '$newSessionBytes = ConvertTo-KonofixUtf8JsonBytes -Value $sessionData -Depth 8',
    '$sessionData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sessionTemp -Encoding utf8',
  ),
  sourceSnapshot,
  false,
  'replacement session reserialization regression',
);
run(
  sourceEditor.replace('$originalManifestBytes = [byte[]]$manifestSnapshot.ContentBytes', '$originalManifestBytes = [IO.File]::ReadAllBytes($manifestFull)'),
  sourceSnapshot,
  false,
  'manifest rollback path-reread regression',
);
run(
  sourceEditor,
  sourceSnapshot.replace('ContentBytes = $capturedBytes', 'ContentBytes = $buffer'),
  false,
  'snapshot exact-byte return regression',
);

console.log('Network report editor snapshot binding mutation tests passed.');
