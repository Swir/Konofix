import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-bootstrap-persistence.mjs');
const sourcePath = path.resolve('src/main.ts');
const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-bootstrap-persistence-'));

const run = (content) => {
  const candidate = path.join(tempDir, 'main.ts');
  fs.writeFileSync(candidate, content, 'utf8');
  return spawnSync(process.execPath, [checker, candidate], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
};

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Test fixture source is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const baseline = run(source);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical frontend must pass bootstrap persistence policy before adversarial mutations run.');
}

const guardedBlock = `    const next = [...loadBootstraps(), address];
    if (state.connected) {
      try { await invoke('add_bootstrap', { address }); }
      catch (e) { alert(String(e)); return; }
    }
    saveBootstraps(next);`;

const cases = [
  {
    name: 'candidate persisted before live backend validation',
    replacement: `    const next = [...loadBootstraps(), address];
    saveBootstraps(next);
    if (state.connected) {
      try { await invoke('add_bootstrap', { address }); }
      catch (e) { alert(String(e)); return; }
    }`,
    expected: 'only after successful backend validation',
  },
  {
    name: 'backend rejection falls through into persistence',
    replacement: `    const next = [...loadBootstraps(), address];
    if (state.connected) {
      try { await invoke('add_bootstrap', { address }); }
      catch (e) { alert(String(e)); }
    }
    saveBootstraps(next);`,
    expected: 'failure path must return',
  },
  {
    name: 'live backend validation removed',
    replacement: `    const next = [...loadBootstraps(), address];
    if (state.connected) {
      console.warn('validation accidentally removed');
    }
    saveBootstraps(next);`,
    expected: "required bootstrap persistence guard is missing: await invoke('add_bootstrap', { address });",
  },
];

for (const testCase of cases) {
  const mutated = mutateOnce(source, guardedBlock, testCase.replacement);
  const result = run(mutated);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the bootstrap persistence checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected output containing '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`Bootstrap persistence adversarial policy tests passed (${cases.length} mutations rejected).`);
