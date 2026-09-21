import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sealer = path.join(here, 'seal-global-beta-evidence.mjs');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [sealer, ...args], { cwd, encoding: 'utf8' });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-sealer-test-'));
try {
  const candidate = Buffer.from('candidate-bytes');
  write(temp, 'candidate.zip', candidate);
  const load50 = Buffer.from('{"load":50}\n');
  const load100 = Buffer.from('{"load":100}\n');
  const load250 = Buffer.from('{"load":250}\n');
  write(temp, 'load-50.json', load50);
  write(temp, 'load-100.json', load100);
  write(temp, 'load-250.json', load250);

  const checkNames = ['world_chat', 'rooms', 'reconnect', 'file_a_to_b_sha256', 'file_b_to_a_sha256', 'tcp', 'quic_v1', 'relay', 'dcutr', 'cgnat'];
  const checks = checkNames.map((name) => {
    const bytes = Buffer.from(`${name}-evidence\n`);
    write(temp, `evidence/${name}.json`, bytes);
    return { name, status: 'pending', evidence: { path: `evidence/${name}.json`, sha256: '' }, observed_sha256: name.includes('sha256') ? '' : undefined };
  });
  write(temp, 'evidence/failover.json', Buffer.from('failover-evidence\n'));

  const manifest = {
    _template: true,
    schema: 2,
    tool: 'konofix-global-beta-evidence',
    status: 'pending',
    candidate: { version: '', source_commit: '', artifact_path: 'candidate.zip', artifact_sha256: '' },
    window: { started_utc: '', ended_utc: '', duration_seconds: 0 },
    participants: [],
    contact_paths: [],
    clients: [],
    load_runs: [
      { clients: 50, path: 'load-50.json', sha256: '' },
      { clients: 100, path: 'load-100.json', sha256: '' },
      { clients: 250, path: 'load-250.json', sha256: '' },
    ],
    checks,
    failover: {
      lost_peer_id: '', recovered_via_peer_ids: [], discovery_recovered: false, chat_recovered: false, rooms_recovered: false,
      evidence: { path: 'evidence/failover.json', sha256: '' },
    },
  };
  const sourcePath = write(temp, 'working.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const outputPath = path.join(temp, 'sealed.json');

  let result = run([sourcePath, '--output', outputPath], temp);
  assert.equal(result.status, 0, result.stderr);
  const sealed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(sealed._template, true, 'sealer must not clear template flag');
  assert.equal(sealed.status, 'pending', 'sealer must not promote status');
  assert.equal(sealed.candidate.version, '', 'sealer must not invent candidate identity');
  assert.equal(sealed.candidate.artifact_sha256, digest(candidate));
  assert.equal(sealed.load_runs[0].sha256, digest(load50));
  assert.equal(sealed.load_runs[1].sha256, digest(load100));
  assert.equal(sealed.load_runs[2].sha256, digest(load250));
  for (const entry of sealed.checks) {
    assert.match(entry.evidence.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.status, 'pending');
  }
  assert.match(sealed.failover.evidence.sha256, /^[0-9a-f]{64}$/);

  result = run([outputPath, '--check'], temp);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS - 15 package files/);

  fs.appendFileSync(path.join(temp, 'evidence/rooms.json'), 'tamper');
  result = run([outputPath, '--check'], temp);
  assert.notEqual(result.status, 0, 'tampered evidence must fail check mode');
  assert.match(result.stderr, /does not match the captured file bytes/);

  fs.writeFileSync(path.join(temp, 'evidence/rooms.json'), 'rooms-evidence\n');
  const escaped = structuredClone(manifest);
  escaped.checks[0].evidence.path = '../outside.json';
  write(path.dirname(temp), 'outside.json', 'outside\n');
  const escapedPath = write(temp, 'escaped.json', `${JSON.stringify(escaped)}\n`);
  result = run([escapedPath, '--output', path.join(temp, 'escaped-sealed.json')], temp);
  assert.notEqual(result.status, 0, 'path escape must fail');
  assert.match(result.stderr, /escapes the evidence manifest directory/);

  const absolute = structuredClone(manifest);
  absolute.checks[0].evidence.path = 'C:\\Windows\\evidence.json';
  const absolutePath = write(temp, 'absolute.json', `${JSON.stringify(absolute)}\n`);
  result = run([absolutePath, '--output', path.join(temp, 'absolute-sealed.json')], temp);
  assert.notEqual(result.status, 0, 'portable Windows absolute path must fail on any host');
  assert.match(result.stderr, /must be relative/);

  result = run([sourcePath, '--output', sourcePath], temp);
  assert.notEqual(result.status, 0, 'source manifest overwrite must fail');
  assert.match(result.stderr, /must not overwrite/);

  const existingOutput = write(temp, 'existing-sealed.json', 'sentinel\n');
  result = run([sourcePath, '--output', existingOutput], temp);
  assert.notEqual(result.status, 0, 'pre-existing output must not be overwritten');
  assert.match(result.stderr, /must not already exist/);
  assert.equal(fs.readFileSync(existingOutput, 'utf8'), 'sentinel\n', 'pre-existing output bytes must remain unchanged');

  const outsideOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-sealer-outside-'));
  try {
    const linkedParent = path.join(temp, 'linked-output');
    fs.symlinkSync(outsideOutputRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedOutput = path.join(linkedParent, 'sealed.json');
    result = run([sourcePath, '--output', escapedOutput], temp);
    assert.notEqual(result.status, 0, 'symlinked output parent escaping the package must fail');
    assert.match(result.stderr, /resolves outside the evidence package directory/);
    assert.equal(fs.existsSync(path.join(outsideOutputRoot, 'sealed.json')), false, 'outside output must not be created');
  } finally {
    fs.rmSync(outsideOutputRoot, { recursive: true, force: true });
  }

  console.log('PASS - Global Beta evidence sealer hashes package files without inventing readiness and fails closed on tamper/path/output attacks.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
