// Fixed Windows stress batch for the original captured/parallel Rust harness.
// No retry after failure. Log descriptors avoid pipe/capture backpressure.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const watched = 'knp_chat::tests::real_chat_is_bidirectional_acknowledged_and_restarts_without_old_session';
const root = resolve(process.env.KONOFIX_KNP_DIAGNOSTICS || 'test-results/knp-capture');
mkdirSync(root, { recursive: true });

function writeNew(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

async function run(label, executable, args, expected, limitMs) {
  const directory = mkdtempSync(join(root, label + '-'));
  const log = join(directory, 'output.log');
  const output = openSync(log, 'wx');
  const env = { ...process.env, RUST_BACKTRACE: '1' };
  delete env.RUST_TEST_NOCAPTURE;
  delete env.RUST_TEST_THREADS;
  writeNew(join(directory, 'start.json'), {
    schema: 1, source_commit: process.env.GITHUB_SHA || null,
    label, executable_sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    args, expected_tests: expected, limit_ms: limitMs, status: 'STARTED',
    output_capture: true, test_threads: 'Rust default',
  });
  const started = performance.now();
  let timedOut = false;
  let spawnError = null;
  const child = spawn(executable, args, { env, stdio: ['ignore', output, output] });
  closeSync(output);
  child.on('error', error => { spawnError = error.message; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, limitMs);
  const [code, signal] = await new Promise(resolveExit => {
    child.on('close', (code, signal) => resolveExit([code, signal]));
  });
  clearTimeout(timer);
  const text = readFileSync(log, 'utf8');
  const summary = 'test result: ok. ' + expected + ' passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;';
  const completed = text.includes('test ' + watched + ' ... ok') && text.includes(summary);
  const result = {
    schema: 1, label, source_commit: process.env.GITHUB_SHA || null,
    elapsed_ms: Math.round(performance.now() - started), limit_ms: limitMs,
    timed_out: timedOut, exit_code: code, signal, spawn_error: spawnError,
    harness_completed: completed,
    success: !timedOut && !spawnError && code === 0 && completed,
    log_sha256: createHash('sha256').update(readFileSync(log)).digest('hex'),
  };
  writeNew(join(directory, 'result.json'), result);
  console.log(JSON.stringify(result));
  if (!result.success) console.log(text.slice(-16000));
  return { ...result, directory };
}

if (process.argv[2] === '--fixture') {
  const mode = process.argv[3];
  if (mode !== 'empty') {
    // Synthetic watchdog control, never product/WAN evidence.
    writeFileSync(1, 'test ' + watched + ' ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n');
  }
  if (mode === 'stall-after-summary') setInterval(() => {}, 1000);
  else process.exit(mode === 'failure' ? 7 : 0);
} else if (process.argv[2] === '--self-test') {
  const fixture = mode => [self, '--fixture', mode];
  const ok = await run('fixture-success', process.execPath, fixture('success'), 1, 10000);
  const empty = await run('fixture-empty', process.execPath, fixture('empty'), 1, 10000);
  const failed = await run('fixture-failure', process.execPath, fixture('failure'), 1, 10000);
  const stalled = await run('fixture-stall', process.execPath, fixture('stall-after-summary'), 1, 2000);
  assert.equal(ok.success, true);
  assert.equal(empty.success, false);
  assert.equal(empty.harness_completed, false);
  assert.equal(failed.success, false);
  assert.equal(failed.exit_code, 7);
  assert.equal(stalled.success, false);
  assert.equal(stalled.timed_out, true);
  assert.equal(stalled.harness_completed, true);
  assert.equal(new Set([ok, empty, failed, stalled].map(r => r.directory)).size, 4);
  console.log('Capture supervisor self-tests PASS (synthetic controls only).');
} else {
  assert.equal(process.platform, 'win32', 'This experiment requires the actual Windows product graph.');
  // Cargo reports the precise executable; never select a stale glob match.
  const build = spawnSync('cargo', [
    'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--test', 'knp_chat_live', '--no-run', '--message-format=json',
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  const artifacts = build.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(item => item.reason === 'compiler-artifact' && item.profile.test
      && item.target.name === 'knp_chat_live' && item.executable);
  assert.equal(artifacts.length, 1, 'Require exactly one Cargo-selected test executable.');
  const executable = artifacts[0].executable;
  const listed = spawnSync(executable, ['--list'], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(listed.error);
  assert.equal(listed.status, 0, listed.stderr);
  const tests = listed.stdout.split(/\r?\n/).filter(line => line.endsWith(': test')).map(line => line.slice(0, -6));
  assert(tests.includes(watched), 'Restart test must actually be selected.');
  assert(tests.length >= 8, 'Keep the original concurrent tests.');
  const runs = [];
  for (let iteration = 1; iteration <= 24; iteration++) {
    const result = await run('original-capture-' + iteration, executable, [], tests.length, 60000);
    runs.push(result);
    assert.equal(result.success, true, 'Stop at first failed/stalled process; evidence: ' + result.directory);
  }
  writeNew(join(mkdtempSync(join(root, 'batch-')), 'summary.json'), {
    schema: 1, source_commit: process.env.GITHUB_SHA || null,
    iterations: runs.length, tests_per_iteration: tests.length,
    status: 'PASS', scope: 'Windows local sockets; not WAN evidence or a timeout root cause',
    results: runs.map(result => result.directory),
  });
  console.log('Original captured/parallel Windows batch PASS: 24 processes, ' + tests.length + ' tests each.');
}
