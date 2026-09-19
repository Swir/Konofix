import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.resolve(root, 'scripts/check-network-session-bootstrap-snapshot-binding.mjs');
const sourceSession = fs.readFileSync(path.resolve(root, 'scripts/new-network-test-session.ps1'), 'utf8');
const sourceSnapshot = fs.readFileSync(path.resolve(root, 'scripts/evidence-snapshot.ps1'), 'utf8');

const run = (session, snapshot, expectSuccess, label) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-session-snapshot-policy-'));
  try {
    const sessionPath = path.join(temp, 'new-network-test-session.ps1');
    const snapshotPath = path.join(temp, 'evidence-snapshot.ps1');
    fs.writeFileSync(sessionPath, session);
    fs.writeFileSync(snapshotPath, snapshot);
    const result = spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        KONOFIX_NETWORK_SESSION_BOOTSTRAP: sessionPath,
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

run(sourceSession, sourceSnapshot, true, 'baseline');
run(
  sourceSession.replace(
    "$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $BuildInfoPath -MaxBytes (256KB) -Label 'BUILD_INFO.json'",
    '$buildInfo = Get-Content -LiteralPath $BuildInfoPath -Raw | ConvertFrom-Json',
  ),
  sourceSnapshot,
  false,
  'split BUILD_INFO read regression',
);
run(
  sourceSession.replace(
    '[IO.File]::WriteAllBytes($sessionBuildInfoPath, [byte[]]$buildInfoSnapshot.ContentBytes)',
    'Copy-Item -LiteralPath $BuildInfoPath -Destination $sessionBuildInfoPath',
  ),
  sourceSnapshot,
  false,
  'BUILD_INFO path reopen regression',
);
run(
  sourceSession.replace(
    "$nodeLock = Open-KonofixVerifiedExecutable -Path $nodePath -ExpectedBytes ([int64]$nodeMeta.bytes) -ExpectedSha256 $nodeHash -Label 'Konofix Node'",
    '$nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
  sourceSnapshot,
  false,
  'Node path rehash regression',
);
run(
  sourceSession.replace('$nodeLock.Stream.Dispose()', '# lock disposal removed'),
  sourceSnapshot,
  false,
  'Node lock lifetime regression',
);
run(
  sourceSession,
  sourceSnapshot.replace('ContentBytes = $capturedBytes', 'ContentBytes = $buffer'),
  false,
  'snapshot exact-byte return regression',
);

console.log('Network session snapshot binding mutation tests passed.');
