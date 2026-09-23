import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repository = 'Swir/Konofix';
const candidate = '31298cc732c97ff90230c3743cd1c3be17f40b6c';
const artifactId = 10715141390;
const candidateWorkflowRun = '35770163117';
const artifactDigest = '6b24e71f93e3a2ba58c834dea8b06cbb7d9e5627616a7ffc2e6b8682d664c3f6';
const tag = 'v0.5.1';
const version = '0.5.1';
const releaseName = 'Konofix Chat 0.5.1 — Stable';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertContext(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, 'refs/heads/release/0.5.1-stable-publish');
  assert(env.GH_TOKEN, 'Workflow token is required');
}

async function api(method, endpoint, body, { allowMissing = false, binary = false, upload = false } = {}) {
  const host = upload ? 'uploads.github.com' : 'api.github.com';
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = upload ? 'application/octet-stream' : 'application/json';
  const response = await fetch(`https://${host}/repos/${repository}${endpoint}`, {
    method: upload ? 'POST' : method,
    headers,
    body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (allowMissing && response.status === 404) return null;
  assert(response.ok, `GitHub ${method} ${endpoint} returned HTTP ${response.status}`);
  if (binary) return Buffer.from(await response.arrayBuffer());
  if (response.status === 204) return null;
  return response.json();
}

function latestSuccessfulCheck(checks, name) {
  const matching = checks.filter((check) => check.name === name && check.head_sha === candidate && check.app?.slug === 'github-actions');
  matching.sort((a, b) => b.id - a.id);
  assert(matching.length > 0, `Missing exact-candidate ${name} check`);
  assert.equal(matching[0].status, 'completed', `${name} is not complete`);
  assert.equal(matching[0].conclusion, 'success', `${name} did not pass`);
}

function verifiedFile(filePath, expectedDigest, expectedBytes) {
  const bytes = fs.readFileSync(filePath);
  if (expectedBytes !== undefined) assert.equal(bytes.length, expectedBytes, `Wrong size: ${filePath}`);
  assert.equal(sha256(bytes), expectedDigest, `Wrong SHA-256: ${filePath}`);
  return bytes;
}

async function main() {
  assertContext(process.env);

  const checks = await api('GET', `/commits/${candidate}/check-runs?per_page=100`);
  for (const name of ['check-windows', 'node-linux', 'audit']) latestSuccessfulCheck(checks.check_runs, name);

  const artifact = await api('GET', `/actions/artifacts/${artifactId}`);
  assert.equal(artifact.expired, false, 'Qualified Windows artifact expired');
  assert.equal(artifact.workflow_run?.head_sha, candidate, 'Artifact belongs to a different source commit');
  assert.equal(artifact.digest, `sha256:${artifactDigest}`, 'Artifact API digest changed');

  const outer = await api('GET', `/actions/artifacts/${artifactId}/zip`, undefined, { binary: true });
  assert.equal(sha256(outer), artifactDigest, 'Downloaded artifact ZIP digest mismatch');

  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'konofix-stable-'));
  const outerPath = path.join(temp, 'actions-artifact.zip');
  const expanded = path.join(temp, 'expanded');
  fs.writeFileSync(outerPath, outer);
  fs.mkdirSync(expanded);
  execFileSync('unzip', ['-q', outerPath, '-d', expanded], { stdio: 'inherit' });

  const infoPath = path.join(expanded, 'artifact', 'BUILD_INFO.json');
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(info.version, version);
  assert.equal(info.commit, candidate);
  assert.equal(String(info.workflow_run), candidateWorkflowRun);

  const nsisMeta = info.installers.find((x) => x.path === 'bundle/nsis/Konofix Chat_0.5.1_x64-setup.exe');
  const msiMeta = info.installers.find((x) => x.path === 'bundle/msi/Konofix Chat_0.5.1_x64_en-US.msi');
  assert(nsisMeta && msiMeta, 'Sealed installer metadata is incomplete');

  const installerBytes = verifiedFile(path.join(expanded, 'artifact', ...nsisMeta.path.split('/')), nsisMeta.sha256, nsisMeta.bytes);
  const msiBytes = verifiedFile(path.join(expanded, 'artifact', ...msiMeta.path.split('/')), msiMeta.sha256, msiMeta.bytes);
  const canonicalZipName = `Konofix-Chat-${version}-Windows-${candidate}.zip`;
  const canonicalZipPath = path.join(expanded, canonicalZipName);
  const canonicalChecksumPath = `${canonicalZipPath}.sha256`;
  const canonicalZipBytes = fs.readFileSync(canonicalZipPath);
  const canonicalZipDigest = sha256(canonicalZipBytes);
  const checksumLine = fs.readFileSync(canonicalChecksumPath, 'utf8').trim();
  assert.equal(checksumLine, `${canonicalZipDigest}  ${canonicalZipName}`, 'Canonical Windows ZIP checksum mismatch');

  const assets = [
    { name: 'BUILD_INFO.json', bytes: fs.readFileSync(infoPath) },
    { name: 'Konofix-Chat-0.5.1-x64-Setup.exe', bytes: installerBytes },
    { name: 'Konofix-Chat-0.5.1-x64-Setup.exe.sha256', bytes: Buffer.from(`${nsisMeta.sha256}  Konofix-Chat-0.5.1-x64-Setup.exe\n`) },
    { name: 'Konofix-Chat-0.5.1-x64.msi', bytes: msiBytes },
    { name: 'Konofix-Chat-0.5.1-x64.msi.sha256', bytes: Buffer.from(`${msiMeta.sha256}  Konofix-Chat-0.5.1-x64.msi\n`) },
    { name: canonicalZipName, bytes: canonicalZipBytes },
    { name: `${canonicalZipName}.sha256`, bytes: fs.readFileSync(canonicalChecksumPath) },
  ].map((asset) => ({ ...asset, sha256: sha256(asset.bytes) }));

  const body = `## Konofix Chat 0.5.1

Stable Windows release promoted from the exact build tested by the project owner.

### Highlights
- receiver-side WORLD/room transfer status from requesting/connecting through live incoming P2P progress and completion,
- private 1:1 incoming-message modal with **Open / Ignore** session behavior,
- setting to allow or block new private conversations with fail-closed authenticated direct-channel rejection,
- preserved direct private file attachments, room-scoped file offers, password rooms, duplicate-nickname incumbent protection, emoji/colors, WORLD file/image sharing, SHA-256, no-clobber, cancel/limits and safe rendering,
- version metadata aligned across npm/package-lock, Rust/Cargo.lock, Tauri and node-linux with 7 locales and English fallback.

### Qualification
- Exact source: \`${candidate}\`
- Windows CI: green
- Linux Node CI: green
- RustSec: green
- User-led Windows validation: passed
- Installer SHA-256: \`${nsisMeta.sha256}\`

Global Beta evidence remains **56/67 = 83.6%**; the remaining real-network/load/failover roadmap gates are tracked separately and are not claimed complete by this release.`;

  let release = await api('GET', `/releases/tags/${tag}`, undefined, { allowMissing: true });
  const existingRef = await api('GET', `/git/ref/tags/${tag}`, undefined, { allowMissing: true });

  if (release && !release.draft) {
    assert.equal(release.prerelease, false, 'Existing v0.5.1 is not stable');
    assert(existingRef, 'Stable release exists without tag ref');
    assert.equal(existingRef.object.sha, candidate, 'Existing stable tag points to another commit');
    console.log(`Stable release already exists and is preserved: ${release.html_url}`);
    return;
  }
  assert(!existingRef, 'Ref v0.5.1 already exists without a published stable release');

  if (!release) {
    release = await api('POST', '/releases', {
      tag_name: tag,
      target_commitish: candidate,
      name: releaseName,
      body,
      draft: true,
      prerelease: false,
      make_latest: 'true',
    });
  } else {
    assert.equal(release.target_commitish, candidate, 'Existing draft belongs to another commit');
    assert.equal(release.prerelease, false, 'Existing draft is unexpectedly marked prerelease');
  }

  const existingAssets = await api('GET', `/releases/${release.id}/assets?per_page=100`);
  assert(existingAssets.every((a) => assets.some((x) => x.name === a.name)), 'Unexpected asset in stable draft');
  for (const asset of assets) {
    const matches = existingAssets.filter((a) => a.name === asset.name);
    assert(matches.length <= 1, `Duplicate release asset: ${asset.name}`);
    const uploaded = matches[0] ?? await api('POST', `/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, asset.bytes, { upload: true });
    assert.equal(uploaded.name, asset.name);
    assert.equal(uploaded.state, 'uploaded');
    assert.equal(uploaded.size, asset.bytes.length);
    if (uploaded.digest) assert.equal(uploaded.digest, `sha256:${asset.sha256}`);
  }

  const finalAssets = await api('GET', `/releases/${release.id}/assets?per_page=100`);
  assert.equal(finalAssets.length, assets.length, 'Stable release asset count mismatch');
  for (const asset of assets) {
    const uploaded = finalAssets.find((a) => a.name === asset.name);
    assert(uploaded, `Missing uploaded asset: ${asset.name}`);
    assert.equal(uploaded.size, asset.bytes.length);
    if (uploaded.digest) assert.equal(uploaded.digest, `sha256:${asset.sha256}`);
  }

  await api('PATCH', `/releases/${release.id}`, { body, draft: false, prerelease: false, make_latest: 'true' });
  const published = await api('GET', `/releases/${release.id}`);
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, false);
  const ref = await api('GET', `/git/ref/tags/${tag}`);
  assert.equal(ref.object.sha, candidate, 'Stable tag does not point to the tested commit');
  console.log(`Published stable release: ${published.html_url}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
