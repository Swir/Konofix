import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'Swir/Konofix';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function hasSigningConfiguration(env) {
  return Boolean(env.TAURI_SIGNING_PRIVATE_KEY?.trim() && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.trim());
}

function decodeBase64(value, label) {
  assert.equal(typeof value, 'string', `${label} must be base64 text`);
  assert(value.length > 0 && value.length <= 16_384, `${label} has an invalid length`);
  const bytes = Buffer.from(value, 'base64');
  assert.equal(bytes.toString('base64'), value, `${label} is not canonical base64`);
  return bytes;
}

function decodeLines(encoded, expected, label) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(encoded, label));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.length, expected, `${label} has an invalid line count`);
  assert(lines[0].startsWith('untrusted comment: '), `${label} is missing its untrusted comment`);
  return lines;
}

// Minisign format: https://jedisct1.github.io/minisign/#signature-format
// Tauri wraps the complete minisign public-key/signature text in base64.
// Only modern ED (BLAKE2b-512 prehashed) signatures are accepted for new releases.
export function verifyUpdaterSignature(bytes, encodedSignature, encodedPublicKey, version) {
  const keyLines = decodeLines(encodedPublicKey, 2, 'Embedded updater public key');
  const signatureLines = decodeLines(encodedSignature, 4, 'Updater signature');
  const key = decodeBase64(keyLines[1], 'Minisign public key');
  const signed = decodeBase64(signatureLines[1], 'Minisign signature');
  const global = decodeBase64(signatureLines[3], 'Minisign trusted-comment signature');
  assert.equal(key.length, 42, 'Invalid Minisign public-key size');
  assert.equal(signed.length, 74, 'Invalid Minisign signature size');
  assert.equal(global.length, 64, 'Invalid Minisign trusted-comment signature size');
  assert.equal(key.subarray(0, 2).toString('ascii'), 'Ed', 'Unsupported Minisign public-key algorithm');
  assert.equal(signed.subarray(0, 2).toString('ascii'), 'ED', 'New updater signatures must use Minisign prehash mode');
  assert(key.subarray(2, 10).equals(signed.subarray(2, 10)), 'Updater signature key ID differs from the embedded public key');
  assert(signatureLines[2].startsWith('trusted comment: '), 'Missing Minisign trusted comment');
  const trustedComment = signatureLines[2].slice('trusted comment: '.length);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const signature = signed.subarray(10);
  assert(verify(null, createHash('blake2b512').update(bytes).digest(), publicKey, signature),
    'Updater executable signature does not verify against the embedded public key');
  assert(verify(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), publicKey, global),
    'Updater trusted-comment signature does not verify against the embedded public key');
  // Match the installed updater's version binding when the signing CLI includes it.
  const signedVersions = trustedComment.split('\t').filter(field => field.startsWith('version:'));
  assert(signedVersions.length <= 1, 'Duplicate signed updater version');
  if (signedVersions.length) assert.equal(signedVersions[0].slice('version:'.length), version, 'Signed updater version mismatch');
}

export function prepareUpdaterPlan(version, tag, names, readFile, publicKey) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Updater requires a stable package version');
  assert(tag === version || tag === `v${version}`, 'Release tag must match the stable package version');
  const installer = `Konofix-Chat-${version}-Windows-x64-updater.exe`;
  const orderedNames = [installer, `${installer}.sig`, 'latest.json'];
  assert.deepEqual([...names].sort(), [...orderedNames].sort(), 'Unexpected or missing signed updater files');
  const files = orderedNames.map(name => {
    const bytes = readFile(name);
    assert(bytes.length > 0, `Empty updater asset: ${name}`);
    return { name, bytes, size: bytes.length, sha256: digest(bytes) };
  });
  const manifest = JSON.parse(files[2].bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.equal(manifest.version, version, 'Updater manifest version mismatch');
  assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64'], 'Unexpected updater platform');
  assert.equal(manifest.platforms['windows-x86_64'].url,
    `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${installer}`,
    'Updater URL must address the exact signed executable in this release');
  assert.equal(manifest.platforms['windows-x86_64'].signature, files[1].bytes.toString('utf8').trim(),
    'Updater manifest signature does not match the detached signature');
  assert(manifest.platforms['windows-x86_64'].signature.length > 0, 'Updater signature is empty');
  verifyUpdaterSignature(files[0].bytes, manifest.platforms['windows-x86_64'].signature, publicKey, version);
  return { version, tag, files };
}

function assertAsset(expected, actual) {
  assert.equal(actual.state, 'uploaded', `Incomplete existing updater asset: ${expected.name}`);
  assert.equal(actual.size, expected.size, `Refusing to replace different updater asset: ${expected.name}`);
  assert.equal(actual.digest, `sha256:${expected.sha256}`, `Refusing to replace different updater asset: ${expected.name}`);
}

export async function publishUpdater(plan, api) {
  const release = await api('GET', `/releases/tags/${encodeURIComponent(plan.tag)}`);
  assert.equal(release.tag_name, plan.tag);
  assert.equal(release.draft, false, 'Updater requires a published release');
  assert.equal(release.prerelease, false, 'Updater must never publish to a prerelease');
  const endpoint = `/releases/${release.id}/assets`;
  const assets = await api('GET', `${endpoint}?per_page=100`);
  assert(assets.length < 100, 'Too many assets for an unambiguous immutable upload preflight');
  // Check ALL collisions before uploading anything. Other manual-release assets remain untouched.
  for (const file of plan.files) {
    const existing = assets.filter(asset => asset.name === file.name);
    assert(existing.length <= 1, `Duplicate updater asset: ${file.name}`);
    if (existing.length) assertAsset(file, existing[0]);
  }
  // Publish the manifest last: clients cannot discover an incomplete new updater package.
  for (const file of plan.files) {
    if (assets.some(asset => asset.name === file.name)) continue;
    const uploaded = await api('UPLOAD', `${endpoint}?name=${encodeURIComponent(file.name)}`, file.bytes);
    assert.equal(uploaded.name, file.name);
    assertAsset(file, uploaded);
  }
  const verified = await api('GET', `${endpoint}?per_page=100`);
  assert(verified.length < 100, 'Too many assets for final verification');
  for (const file of plan.files) {
    const matching = verified.filter(asset => asset.name === file.name);
    assert.equal(matching.length, 1, `Missing or duplicate published updater asset: ${file.name}`);
    assertAsset(file, matching[0]);
  }
}

async function main() {
  if (process.argv[2] === 'check-signing') {
    const configured = hasSigningConfiguration(process.env);
    assert(process.env.GITHUB_OUTPUT, 'Workflow output path is required');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `configured=${configured}\n`);
    const status = configured
      ? 'Signing configuration present; signed updater publication is still pending build and verification.'
      : 'UNCONFIGURED: signed automatic updates are not published. The signing key and password must both be configured. No signed build, latest.json or updater upload will be produced; manual stable installers remain unchanged.';
    console.log(status);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${status}\n`);
    return;
  }
  assert.equal(process.argv[2], 'publish');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert(process.env.GH_TOKEN, 'Workflow token is required');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const publicKey = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).plugins.updater.pubkey;
  const plan = prepareUpdaterPlan(version, process.env.RELEASE_TAG,
    fs.readdirSync('stable-assets'), name => fs.readFileSync(path.join('stable-assets', name)), publicKey);
  const api = async (method, endpoint, bytes) => {
    const upload = method === 'UPLOAD';
    const response = await fetch(`https://${upload ? 'uploads' : 'api'}.github.com/repos/${repository}${endpoint}`, {
      method: upload ? 'POST' : method,
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', ...(upload ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    assert(response.ok, `GitHub updater ${method} ${endpoint} returned HTTP ${response.status}`);
    return response.json();
  };
  await publishUpdater(plan, api);
  const status = 'Signed stable updater assets published and their uploaded SHA-256 digests verified. Existing release assets were not overwritten.';
  console.log(status);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${status}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
