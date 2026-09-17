import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-rustsec-workflow.mjs');
const workflowPath = path.resolve('.github/workflows/rustsec-audit.yml');
const source = fs.readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-rustsec-policy-'));

const run = (content) => {
  const candidate = path.join(tempDir, 'rustsec-audit.yml');
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
  throw new Error('Canonical RustSec workflow must pass its policy checker before adversarial mutations run.');
}

const cases = [
  {
    name: 'write permission',
    source: 'permissions:\n  contents: read\n',
    replacement: 'permissions:\n  contents: write\n',
    expected: 'read-only',
  },
  {
    name: 'floating action ref',
    source: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    replacement: 'actions/checkout@v7',
    expected: 'immutable 40-character commit SHA',
  },
  {
    name: 'persisted checkout credentials',
    source: 'persist-credentials: false',
    replacement: 'persist-credentials: true',
    expected: 'disable persisted credentials',
  },
  {
    name: 'unlocked cargo-audit install',
    source: 'cargo install cargo-audit --version "$CARGO_AUDIT_VERSION" --locked --force',
    replacement: 'cargo install cargo-audit --version "$CARGO_AUDIT_VERSION" --force',
    expected: 'exact-version and Cargo --locked',
  },
  {
    name: 'missing scheduled refresh',
    source: "  schedule:\n    - cron: '37 5 * * 1'\n",
    replacement: '',
    expected: 'scheduled advisory refresh',
  },
  {
    name: 'production lock audit removed',
    source: 'cargo audit --file src-tauri/Cargo.lock',
    replacement: 'echo "production audit accidentally removed"',
    expected: 'production Cargo.lock',
  },
];

for (const testCase of cases) {
  const mutated = mutateOnce(source, testCase.source, testCase.replacement);
  const result = run(mutated);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the RustSec workflow policy checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected output containing '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`RustSec workflow adversarial policy tests passed (${cases.length} mutations rejected).`);
