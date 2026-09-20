import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LOAD_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_FIELD_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(`Global Beta evidence sealing failed: ${message}`);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty.`);
  return value.trim();
}

function isPortableAbsolute(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveEvidencePath(root, raw, label) {
  const value = nonEmpty(raw, label);
  if (isPortableAbsolute(value)) fail(`${label} must be relative to the evidence manifest directory.`);
  const lexical = path.resolve(root, value);
  if (!isInside(root, lexical)) fail(`${label} escapes the evidence manifest directory.`);
  if (!fs.existsSync(lexical)) fail(`${label} does not exist: ${value}`);
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(lexical);
  if (!isInside(realRoot, realTarget)) fail(`${label} resolves outside the evidence manifest directory.`);
  return realTarget;
}

function readExactFile(filePath, maxBytes, label) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} must be a regular file.`);
    if (stat.size <= 0) fail(`${label} must not be empty.`);
    if (stat.size > maxBytes) fail(`${label} exceeds the ${maxBytes}-byte safety limit.`);
    if (stat.size > Number.MAX_SAFE_INTEGER) fail(`${label} is too large to seal safely.`);

    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) fail(`${label} ended before the captured byte count was read.`);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      fail(`${label} changed while it was being captured.`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function setOrCheckHash(target, key, digest, label, check) {
  if (check) {
    if (!SHA256_RE.test(String(target?.[key] ?? ''))) fail(`${label} must be a lowercase 64-character SHA-256 digest.`);
    if (target[key] !== digest) fail(`${label} does not match the captured file bytes.`);
  } else {
    target[key] = digest;
  }
}

function sealReference(root, reference, label, maxBytes, check) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    fail(`${label} must be an object with path and sha256.`);
  }
  const relative = nonEmpty(reference.path, `${label}.path`);
  const resolved = resolveEvidencePath(root, relative, `${label}.path`);
  const bytes = readExactFile(resolved, maxBytes, `${label}.path`);
  const digest = sha256(bytes);
  setOrCheckHash(reference, 'sha256', digest, `${label}.sha256`, check);
  return { path: relative, sha256: digest, bytes: bytes.length };
}

export function sealGlobalBetaEvidence(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('root must be an object.');
  if (document.schema !== 2) fail('schema must equal 2.');
  if (document.tool !== 'konofix-global-beta-evidence') fail("tool must equal 'konofix-global-beta-evidence'.");

  const root = path.resolve(options.root ?? '.');
  const check = options.check === true;
  const sealed = [];

  const candidate = document.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('candidate is required.');
  const artifactPath = nonEmpty(candidate.artifact_path, 'candidate.artifact_path');
  const resolvedArtifact = resolveEvidencePath(root, artifactPath, 'candidate.artifact_path');
  const artifactBytes = readExactFile(resolvedArtifact, MAX_CANDIDATE_ARTIFACT_BYTES, 'candidate.artifact_path');
  const artifactDigest = sha256(artifactBytes);
  setOrCheckHash(candidate, 'artifact_sha256', artifactDigest, 'candidate.artifact_sha256', check);
  sealed.push({ path: artifactPath, sha256: artifactDigest, bytes: artifactBytes.length, kind: 'candidate' });

  if (!Array.isArray(document.load_runs) || document.load_runs.length === 0) fail('load_runs must be a non-empty array.');
  for (const [index, run] of document.load_runs.entries()) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) fail(`load_runs[${index}] must be an object.`);
    const record = sealReference(root, run, `load_runs[${index}]`, MAX_LOAD_EVIDENCE_BYTES, check);
    sealed.push({ ...record, kind: 'load' });
  }

  if (!Array.isArray(document.checks) || document.checks.length === 0) fail('checks must be a non-empty array.');
  for (const [index, entry] of document.checks.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`checks[${index}] must be an object.`);
    nonEmpty(entry.name, `checks[${index}].name`);
    const record = sealReference(root, entry.evidence, `checks[${index}].evidence`, MAX_FIELD_EVIDENCE_BYTES, check);
    sealed.push({ ...record, kind: 'check' });
  }

  if (!document.failover || typeof document.failover !== 'object' || Array.isArray(document.failover)) fail('failover is required.');
  const failoverRecord = sealReference(root, document.failover.evidence, 'failover.evidence', MAX_FIELD_EVIDENCE_BYTES, check);
  sealed.push({ ...failoverRecord, kind: 'failover' });

  return { document, sealed };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/seal-global-beta-evidence.mjs <manifest.json> --output <sealed.json>',
    '  node scripts/seal-global-beta-evidence.mjs <manifest.json> --check',
    '',
    'The sealer only computes/verifies package file SHA-256 values. It never changes PASS/PENDING status,',
    'participants, clients, timestamps, observed transfer digests, or release-readiness claims.',
  ].join('\n');
}

function cli(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const manifestArg = argv[0];
  const check = argv.includes('--check');
  const outputIndex = argv.indexOf('--output');
  if (check && outputIndex !== -1) fail('--check and --output cannot be used together.');
  if (!check && outputIndex === -1) fail('choose --check or provide --output <sealed.json>.');
  if (outputIndex !== -1 && (outputIndex + 1 >= argv.length || argv[outputIndex + 1].startsWith('--'))) {
    fail('--output requires a file path.');
  }

  const manifestPath = path.resolve(manifestArg);
  if (!fs.existsSync(manifestPath)) fail(`manifest does not exist: ${manifestArg}`);
  if (fs.lstatSync(manifestPath).isSymbolicLink()) fail('manifest itself must not be a symbolic link.');
  const manifestBytes = readExactFile(manifestPath, MAX_MANIFEST_BYTES, 'manifest');
  const document = parseJsonBytes(manifestBytes, 'manifest');
  const root = path.dirname(manifestPath);
  const result = sealGlobalBetaEvidence(document, { root, check });

  if (check) {
    console.log(`PASS - ${result.sealed.length} package files match the manifest SHA-256 bindings.`);
    return;
  }

  const outputPath = path.resolve(argv[outputIndex + 1]);
  if (!isInside(root, outputPath)) fail('--output must stay inside the evidence package directory.');
  if (outputPath === manifestPath) fail('--output must not overwrite the source manifest; write a separate sealed manifest.');
  if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink()) fail('--output must not replace a symbolic link.');

  const serialized = `${JSON.stringify(result.document, null, 2)}\n`;
  const tempPath = `${outputPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    fs.renameSync(tempPath, outputPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  console.log(`SEALED - wrote ${result.sealed.length} package SHA-256 bindings to ${outputPath}`);
  console.log('No evidence status or readiness claim was changed. Run validate-global-beta-evidence.mjs separately.');
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
