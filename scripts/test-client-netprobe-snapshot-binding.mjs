import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-client-netprobe-snapshot-binding.mjs');
const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-client-netprobe.ps1'), 'utf8').replaceAll('\r\n', '\n');
const helper = fs.readFileSync(path.join(root, 'scripts', 'evidence-snapshot.ps1'), 'utf8').replaceAll('\r\n', '\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-client-netprobe-binding-'));

const run = (validatorText, helperText = helper) => {
  const validatorPath = path.join(temp, 'validate-client-netprobe.ps1');
  const helperPath = path.join(temp, 'evidence-snapshot.ps1');
  fs.writeFileSync(validatorPath, validatorText);
  fs.writeFileSync(helperPath, helperText);
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: {
      ...process.env,
      KONOFIX_CLIENT_NETPROBE_VALIDATOR: validatorPath,
      KONOFIX_SNAPSHOT_HELPER: helperPath,
    },
    encoding: 'utf8',
  });
};

const expectPass = (name, validatorText = validator, helperText = helper) => {
  const result = run(validatorText, helperText);
  if (result.status !== 0) {
    console.error(`${name} unexpectedly failed:\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
};

const expectFail = (name, validatorText, helperText = helper) => {
  const result = run(validatorText, helperText);
  if (result.status === 0) {
    console.error(`${name} unexpectedly passed.`);
    process.exit(1);
  }
};

expectPass('current client Netprobe snapshot binding');
expectFail(
  'path reread regression',
  validator.replace(
    '$actualBuildInfoHash = [string]$buildInfoSnapshot.Sha256',
    '$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
);
expectFail(
  'session hash reread regression',
  validator.replace(
    '$actualSessionInfoHash = [string]$sessionSnapshot.Sha256',
    '$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
);
expectFail(
  'Netprobe hash reread regression',
  validator.replace(
    '$actualNetprobeHash = [string]$verifiedNetprobe.Sha256',
    '$actualNetprobeHash = (Get-FileHash -LiteralPath $netprobePath -Algorithm SHA256).Hash.ToLowerInvariant()',
  ),
);
expectFail(
  'Netprobe size reread regression',
  validator.replace(
    '-ExpectedBytes $netprobeBytes',
    '-ExpectedBytes ([int64](Get-Item -LiteralPath $netprobePath).Length)',
  ),
);
expectFail(
  'Netprobe early lock release regression',
  validator.replace(
    '$actualNetprobeHash = [string]$verifiedNetprobe.Sha256',
    '$actualNetprobeHash = [string]$verifiedNetprobe.Sha256\n    $verifiedNetprobe.Stream.Dispose()',
  ),
);
expectFail(
  'local raw reader regression',
  validator.replace(
    "$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'",
    "function Read-BoundedJson { param([string]$Path); Get-Content -LiteralPath $Path -Raw }\n$sessionSnapshot = Read-KonofixBoundedJsonSnapshot -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'",
  ),
);
expectFail(
  'writer-sharing regression',
  validator,
  helper.replace(
    '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
    '[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete',
  ),
);
expectFail(
  'verified executable replacement-sharing regression',
  validator,
  helper.replace(
    '[System.IO.FileAccess]::Read,\n            [System.IO.FileShare]::Read\n        )',
    '[System.IO.FileAccess]::Read,\n            [System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete\n        )',
  ),
);

fs.rmSync(temp, { recursive: true, force: true });
console.log('Client Netprobe snapshot binding mutation tests passed.');
