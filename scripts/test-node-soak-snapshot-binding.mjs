import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-node-soak-snapshot-binding.mjs');
const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-node-soak.ps1'), 'utf8').replaceAll('\r\n', '\n');
const helper = fs.readFileSync(path.join(root, 'scripts', 'evidence-snapshot.ps1'), 'utf8').replaceAll('\r\n', '\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-soak-binding-'));

const run = (validatorText, helperText = helper) => {
  const validatorPath = path.join(temp, 'validate-node-soak.ps1');
  const helperPath = path.join(temp, 'evidence-snapshot.ps1');
  fs.writeFileSync(validatorPath, validatorText);
  fs.writeFileSync(helperPath, helperText);
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: {
      ...process.env,
      KONOFIX_SOAK_VALIDATOR: validatorPath,
      KONOFIX_SNAPSHOT_HELPER: helperPath,
    },
    encoding: 'utf8',
  });
};

const expectPass = (name, validatorText = validator, helperText = helper) => {
  const result = run(validatorText, helperText);
  if (result.status !== 0) {
    throw new Error(`${name} should pass.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
};

const expectReject = (name, validatorText = validator, helperText = helper) => {
  const result = run(validatorText, helperText);
  if (result.status === 0) {
    throw new Error(`${name} should be rejected.`);
  }
};

try {
  expectPass('current snapshot-bound validator');

  expectReject(
    'path reread regression',
    validator.replace(
      '$health = $snapshot.Data',
      '$health = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json',
    ),
  );

  expectReject(
    'size precheck regression',
    validator.replace(
      '$snapshot = Read-KonofixBoundedJsonSnapshot -Path $path -MaxBytes $MaxSnapshotBytes -Label \'Node soak snapshot\'',
      '$file = Get-Item -LiteralPath $path\n    $snapshot = Read-KonofixBoundedJsonSnapshot -Path $path -MaxBytes $MaxSnapshotBytes -Label \'Node soak snapshot\'',
    ),
  );

  expectReject(
    'writer-sharing regression',
    validator,
    helper.replace(
      '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
      '[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete',
    ),
  );

  expectReject(
    'snapshot hash traceability regression',
    validator.replace('sha256 = [string]$snapshot.Sha256', 'sha256 = \'unknown\''),
  );

  console.log('Node soak snapshot binding adversarial policy tests passed (4 mutations rejected).');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
