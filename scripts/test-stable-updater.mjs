import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { hasSigningConfiguration, prepareUpdaterPlan, publishUpdater, verifyUpdaterSignature } from './stable-updater-release.mjs';

const { isStableVersion } = await import('../src/updater.ts');
assert.equal(isStableVersion('0.6.0'), true);
assert.equal(isStableVersion('2.0.1+build.9'), true);
assert.equal(isStableVersion('0.6.0-rc.1'), false, 'prereleases must never enter the stable updater');
assert.equal(isStableVersion('0.6.0-5'), false, 'alpha build identifiers must never enter the stable updater');

const frontend = fs.readFileSync('src/updater.ts', 'utf8');
const main = fs.readFileSync('src/main.ts', 'utf8');
const tauri = fs.readFileSync('src-tauri/tauri.conf.json', 'utf8');
const capability = fs.readFileSync('src-tauri/capabilities/main-events.json', 'utf8');
const workflow = fs.readFileSync('.github/workflows/stable-updater.yml', 'utf8');

assert.ok(frontend.indexOf('await callbacks.ask') < frontend.indexOf('update.downloadAndInstall'), 'user approval must happen before download and install');
assert.match(frontend, /restartAfterInstall:\s*true/);
assert.match(main, /window\.confirm\(t\('update\.available'/, 'the installed app must ask before every stable install');
assert.match(tauri, /releases\/latest\/download\/latest\.json/);
assert.match(tauri, /"pubkey":\s*"[A-Za-z0-9+/=]+"/, 'a public signature verification key must be embedded');
assert.match(capability, /"updater:default"/);
assert.match(workflow, /release:\s*[\s\S]*types:\s*\[published\]/);
assert.match(workflow, /prerelease == false/);
assert.match(workflow, /Package version '[^']*' is not stable SemVer|is not stable SemVer/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.doesNotMatch(workflow, /\.nsis\.zip|--clobber/);
assert.match(workflow, /-Filter '\*-setup\.exe'/);
assert.match(workflow, /\$signaturePath = "\$\(\$installer\[0\]\.FullName\)\.sig"/);
assert.match(workflow, /\.sig/);
assert.match(workflow, /latest\.json/);
assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/);
function assertImmutableReleaseSource(source) {
  assert.match(source, /ref: \$\{\{ github\.sha \}\}/, 'Checkout must use the immutable event commit');
  assert.doesNotMatch(source, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/, 'Checkout must never follow a mutable tag');
  assert.match(source, /RELEASE_SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert(source.includes("$env:RELEASE_SOURCE_SHA -cnotmatch '^[0-9a-f]{40}$'"), 'Expected source must be a canonical full SHA');
  assert(source.includes('$checkedOut = (& git rev-parse HEAD).Trim()'), 'Read the actual checked-out commit');
  assert(source.includes("$LASTEXITCODE -ne 0 -or $checkedOut -cne $env:RELEASE_SOURCE_SHA) { throw"), 'Reject unexpected checkout before reading release inputs');
  assert(source.includes('git fetch --no-tags origin "refs/tags/$($env:RELEASE_TAG)"'), 'Resolve only the validated exact tag ref');
  assert(source.includes("$tagCommit = (& git rev-parse 'FETCH_HEAD^{commit}').Trim()"), 'Peel annotated tags to commit identity');
  assert(source.includes('$LASTEXITCODE -ne 0 -or $tagCommit -cne $env:RELEASE_SOURCE_SHA) { throw'), 'Reject moved release tags');
  assert(source.indexOf('Release tag does not match package version') < source.indexOf('git fetch --no-tags origin "refs/tags/'), 'Validate the tag before using it as a ref');
  assert(source.indexOf('$tagCommit -cne $env:RELEASE_SOURCE_SHA') < source.indexOf('git fetch --no-tags origin main'), 'Check tag identity before FETCH_HEAD is replaced');
}
assertImmutableReleaseSource(workflow);
for (const weakened of [
  workflow.replace('ref: ${{ github.sha }}', 'ref: ${{ github.event.release.tag_name }}'),
  workflow.replace("-cnotmatch '^[0-9a-f]{40}$'", "-cnotmatch '^[0-9a-f]+$'"),
  workflow.replace('$checkedOut -cne $env:RELEASE_SOURCE_SHA', '$checkedOut -eq $null'),
  workflow.replace("'FETCH_HEAD^{commit}'", "'HEAD'"),
  workflow.replace('$tagCommit -cne $env:RELEASE_SOURCE_SHA', '$tagCommit -eq $null'),
]) assert.throws(() => assertImmutableReleaseSource(weakened), 'Mutated immutable source policy must fail');
assert.equal(JSON.parse(fs.readFileSync('src-tauri/tauri.stable.conf.json', 'utf8')).bundle.createUpdaterArtifacts, true);
for (const step of ['Setup Rust MSVC', 'Install frontend dependencies', 'Verify source and locked Rust graph',
  'Build signed stable updater artifacts', 'Create signed static update manifest',
  'Publish signed updater without replacing existing release assets', 'Preserve signed stable artifacts']) {
  const start = workflow.indexOf(`- name: ${step}`);
  assert(start >= 0, `Required updater step missing: ${step}`);
  const end = workflow.indexOf('\n      - name:', start + 1);
  assert.match(workflow.slice(start, end < 0 ? undefined : end), /if: steps\.signing\.outputs\.configured == 'true'/,
    `Unsigned updater step must be skipped: ${step}`);
}

assert.equal(hasSigningConfiguration({}), false);
assert.equal(hasSigningConfiguration({ TAURI_SIGNING_PRIVATE_KEY: 'key' }), false);
assert.equal(hasSigningConfiguration({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password' }), false);
assert.equal(hasSigningConfiguration({ TAURI_SIGNING_PRIVATE_KEY: ' ', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password' }), false);
assert.equal(hasSigningConfiguration({ TAURI_SIGNING_PRIVATE_KEY: 'key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ' ' }), false);
assert.equal(hasSigningConfiguration({ TAURI_SIGNING_PRIVATE_KEY: 'key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password' }), true);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-updater-policy-'));
try {
  const output = path.join(temporary, 'output.txt');
  const summary = path.join(temporary, 'summary.md');
  const result = spawnSync(process.execPath, ['scripts/stable-updater-release.mjs', 'check-signing'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      TAURI_SIGNING_PRIVATE_KEY: 'DO_NOT_LOG_THIS_KEY', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'configured=false\n');
  assert.match(fs.readFileSync(summary, 'utf8'), /UNCONFIGURED: signed automatic updates are not published/);
  assert.match(result.stdout, /No signed build, latest\.json or updater upload will be produced/);
  assert.doesNotMatch(result.stdout + result.stderr + fs.readFileSync(summary, 'utf8'), /DO_NOT_LOG_THIS_KEY/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const installerName = 'Konofix-Chat-0.6.0-Windows-x64-updater.exe';
const testKey = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');
const keyId = Buffer.from('0102030405060708', 'hex');
const encodedKey = pair => Buffer.from(`untrusted comment: generated test public key\n${Buffer.concat([
  Buffer.from('Ed'), keyId, Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'),
]).toString('base64')}\n`).toString('base64');
const encodeSignature = (bytes, pair = testKey, comment = 'timestamp:123\tfile:test.exe\tversion:0.6.0') => {
  const rawSignature = sign(null, createHash('blake2b512').update(bytes).digest(), pair.privateKey);
  const global = sign(null, Buffer.concat([rawSignature, Buffer.from(comment)]), pair.privateKey);
  return Buffer.from(`untrusted comment: generated test signature\n${Buffer.concat([Buffer.from('ED'), keyId, rawSignature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
};
const executable = Buffer.from('test-signed-executable');
const signature = encodeSignature(executable);
const publicKey = encodedKey(testKey);
verifyUpdaterSignature(executable, signature, publicKey, '0.6.0');
assert.throws(() => verifyUpdaterSignature(executable, signature, encodedKey(otherKey), '0.6.0'), /executable signature does not verify/,
  'A different actual key must fail even when it uses the same key ID');
assert.throws(() => verifyUpdaterSignature(Buffer.from('tampered executable'), signature, publicKey, '0.6.0'), /executable signature does not verify/);
assert.throws(() => verifyUpdaterSignature(executable, encodeSignature(executable, otherKey), publicKey, '0.6.0'), /executable signature does not verify/);
const tamperedComment = Buffer.from(Buffer.from(signature, 'base64').toString().replace('timestamp:123', 'timestamp:456')).toString('base64');
assert.throws(() => verifyUpdaterSignature(executable, tamperedComment, publicKey, '0.6.0'), /trusted-comment signature does not verify/);
assert.throws(() => verifyUpdaterSignature(executable, signature, publicKey, '0.6.1'), /Signed updater version mismatch/);
assert.throws(() => verifyUpdaterSignature(executable, `${signature}!`, publicKey, '0.6.0'), /canonical base64/);
const mutateSignatureRecord = mutate => {
  const lines = Buffer.from(signature, 'base64').toString().split('\n');
  const record = Buffer.from(lines[1], 'base64');
  mutate(record);
  lines[1] = record.toString('base64');
  return Buffer.from(lines.join('\n')).toString('base64');
};
assert.throws(() => verifyUpdaterSignature(executable, mutateSignatureRecord(record => { record[2] ^= 1; }), publicKey, '0.6.0'), /key ID differs/);
assert.throws(() => verifyUpdaterSignature(executable, mutateSignatureRecord(record => { record[1] = 0x64; }), publicKey, '0.6.0'), /prehash mode/);
assert.throws(() => verifyUpdaterSignature(executable, mutateSignatureRecord(record => { record[12] ^= 1; }), publicKey, '0.6.0'), /executable signature does not verify/);

// Independent known-answer vector from minisign-verify 0.3.0's public API example.
const knownPublicKey = Buffer.from('untrusted comment: public test vector\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n').toString('base64');
const knownSignature = Buffer.from('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n').toString('base64');
verifyUpdaterSignature(Buffer.from('test'), knownSignature, knownPublicKey, '0.6.0');
const fileBytes = new Map([
  [installerName, executable],
  [`${installerName}.sig`, Buffer.from(signature)],
  ['latest.json', Buffer.from(JSON.stringify({ version: '0.6.0', platforms: { 'windows-x86_64': {
    signature, url: `https://github.com/Swir/Konofix/releases/download/v0.6.0/${installerName}`,
  } } }))],
]);
const makePlan = () => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys()], name => fileBytes.get(name), publicKey);
assert.throws(() => prepareUpdaterPlan('0.6.0-5', 'v0.6.0-5', [], () => Buffer.alloc(0)), /stable package version/);
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.1', [], () => Buffer.alloc(0)), /tag must match/);
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys(), 'unsigned.exe'], name => fileBytes.get(name)), /Unexpected or missing/);
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys()], name =>
  name.endsWith('.sig') ? Buffer.from('different signature') : fileBytes.get(name)), /signature does not match/);
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys()], name =>
  name.endsWith('.sig') ? Buffer.alloc(0) : fileBytes.get(name)), /Empty updater asset/);
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys()], name =>
  name === 'latest.json' ? Buffer.from(fileBytes.get(name).toString().replace('github.com/Swir', 'example.com/Swir')) : fileBytes.get(name)), /exact signed executable/);
const plan = makePlan();
assert.throws(() => prepareUpdaterPlan('0.6.0', 'v0.6.0', [...fileBytes.keys()], name => fileBytes.get(name), encodedKey(otherKey)), /executable signature does not verify/,
  'Wrong-key signed artifacts must fail before a publication plan or any API request exists');
const toAsset = file => ({ name: file.name, state: 'uploaded', size: file.size, digest: `sha256:${file.sha256}` });
function fakeApi(initial = [], releasePatch = {}) {
  const state = { assets: structuredClone(initial), writes: [] };
  const api = async (method, endpoint, bytes) => {
    if (method === 'GET' && endpoint === '/releases/tags/v0.6.0') {
      return { id: 1, tag_name: 'v0.6.0', draft: false, prerelease: false, ...releasePatch };
    }
    if (method === 'GET' && endpoint === '/releases/1/assets?per_page=100') return structuredClone(state.assets);
    assert.equal(method, 'UPLOAD', 'Updater publication must never PATCH, DELETE or overwrite');
    const name = decodeURIComponent(endpoint.split('?name=')[1]);
    assert(!state.assets.some(asset => asset.name === name), 'Duplicate upload attempted');
    const file = plan.files.find(item => item.name === name);
    assert.deepEqual(bytes, file.bytes);
    state.writes.push(name);
    const asset = toAsset(file);
    state.assets.push(asset);
    return asset;
  };
  return { state, api };
}
const manualInstaller = { name: 'Konofix-Chat-0.6.0-setup.exe', state: 'uploaded', size: 999, digest: 'sha256:manual' };
const fresh = fakeApi([manualInstaller]);
await publishUpdater(plan, fresh.api);
assert.deepEqual(fresh.state.writes, [installerName, `${installerName}.sig`, 'latest.json'], 'Discovery manifest must be published last');
assert.deepEqual(fresh.state.assets[0], manualInstaller, 'Manual release installer must remain untouched');
await publishUpdater(plan, fresh.api);
assert.equal(fresh.state.writes.length, 3, 'An identical retry must not upload or replace assets');

for (const conflict of [{ ...toAsset(plan.files[2]), digest: 'sha256:different' },
  { ...toAsset(plan.files[0]), size: 123 }, { ...toAsset(plan.files[0]), state: 'new' },
  { ...toAsset(plan.files[0]), digest: null }]) {
  const attempt = fakeApi([conflict]);
  await assert.rejects(publishUpdater(plan, attempt.api), /different updater asset|Incomplete existing/);
  assert.deepEqual(attempt.state.writes, [], 'All collisions must be checked before uploading any bytes');
}
for (const releasePatch of [{ draft: true }, { prerelease: true }]) {
  const attempt = fakeApi([], releasePatch);
  await assert.rejects(publishUpdater(plan, attempt.api), /published release|prerelease/);
  assert.deepEqual(attempt.state.writes, []);
}
const duplicate = fakeApi([toAsset(plan.files[0]), toAsset(plan.files[0])]);
await assert.rejects(publishUpdater(plan, duplicate.api), /Duplicate updater asset/);
assert.deepEqual(duplicate.state.writes, []);
const corruptUpload = fakeApi();
await assert.rejects(publishUpdater(plan, async (...args) => {
  const result = await corruptUpload.api(...args);
  return args[0] === 'UPLOAD' ? { ...result, digest: 'sha256:wrong' } : result;
}), /different updater asset/);
assert.deepEqual(corruptUpload.state.writes, [installerName], 'An unverified package must never publish its discovery manifest');

console.log('Stable updater test passed: Tauri v2 artifacts, explicit unconfigured signing, immutable publication, stable-only policy and user consent.');
