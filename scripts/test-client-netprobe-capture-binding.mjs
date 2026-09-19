import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-client-netprobe-capture-binding.mjs');
const capture = fs.readFileSync(path.join(root, 'scripts', 'capture-client-netprobe.ps1'), 'utf8').replaceAll('\r\n', '\n');
const snapshot = fs.readFileSync(path.join(root, 'scripts', 'evidence-snapshot.ps1'), 'utf8').replaceAll('\r\n', '\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-client-capture-binding-'));

const run = (captureText, snapshotText = snapshot) => {
  const capturePath = path.join(temp, 'capture-client-netprobe.ps1');
  const snapshotPath = path.join(temp, 'evidence-snapshot.ps1');
  fs.writeFileSync(capturePath, captureText);
  fs.writeFileSync(snapshotPath, snapshotText);
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: {
      ...process.env,
      KONOFIX_CLIENT_NETPROBE_CAPTURE: capturePath,
      KONOFIX_SNAPSHOT_HELPER: snapshotPath,
    },
    encoding: 'utf8',
  });
};

const expectPass = (name, captureText = capture, snapshotText = snapshot) => {
  const result = run(captureText, snapshotText);
  if (result.status !== 0) {
    console.error(`${name} unexpectedly failed:\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
};

const expectFail = (name, captureText, snapshotText = snapshot) => {
  const result = run(captureText, snapshotText);
  if (result.status === 0) {
    console.error(`${name} unexpectedly passed.`);
    process.exit(1);
  }
};

const mutateExecutableHelper = (from, to) => {
  const marker = 'function Open-KonofixVerifiedExecutable';
  const start = snapshot.indexOf(marker);
  if (start < 0) throw new Error('Executable helper marker missing from fixture.');
  const prefix = snapshot.slice(0, start);
  const executable = snapshot.slice(start);
  const mutated = executable.replace(from, to);
  if (mutated === executable) throw new Error(`Executable helper mutation target missing: ${from}`);
  return prefix + mutated;
};

expectPass('current client Netprobe capture binding');
expectFail(
  'BUILD_INFO path hash reread regression',
  capture.replace(
    '$actualBuildInfoHash = [string]$buildInfoSnapshot.Sha256',
    '$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
);
expectFail(
  'SESSION_INFO path hash reread regression',
  capture.replace(
    '$actualSessionInfoHash = [string]$sessionSnapshot.Sha256',
    '$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
);
expectFail(
  'local raw JSON reader regression',
  capture.replace(
    'function Assert-True',
    "function Read-BoundedJson { param([string]$Path); Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }\n\nfunction Assert-True",
  ),
);
expectFail(
  'writer-sharing executable regression',
  capture,
  mutateExecutableHelper('[System.IO.FileShare]::Read', '[System.IO.FileShare]::ReadWrite'),
);
expectFail(
  'delete-sharing executable regression',
  capture,
  mutateExecutableHelper('[System.IO.FileShare]::Read', '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete'),
);
expectFail(
  'non-launchable executable lock regression',
  capture,
  mutateExecutableHelper('[System.IO.FileShare]::Read', '[System.IO.FileShare]::None'),
);
const prematureDispose = capture.replace(
  '    $quicProbe = Invoke-Netprobe -NetprobePath $netprobePath -Target $quicBootstrap -Timeout $TimeoutSeconds\n} finally {\n    $netprobeLock.Stream.Dispose()\n}',
  '    $netprobeLock.Stream.Dispose()\n    $quicProbe = Invoke-Netprobe -NetprobePath $netprobePath -Target $quicBootstrap -Timeout $TimeoutSeconds\n} finally {\n}',
);
expectFail('premature executable lock release regression', prematureDispose);

fs.rmSync(temp, { recursive: true, force: true });
console.log('Client Netprobe capture binding mutation tests passed.');
