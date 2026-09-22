import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'Swir/Konofix';
const tag = 'v0.4.4-beta.1';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function assertContext(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
}

export function assertChecks(checks, commit) {
  for (const name of ['check-windows', 'node-linux', 'audit']) {
    const matching = checks.filter((check) => check.name === name && check.head_sha === commit && check.app?.slug === 'github-actions');
    matching.sort((a, b) => b.id - a.id);
    assert(matching.length > 0, `Missing exact-commit ${name} check`);
    assert.equal(matching[0].status, 'completed', `${name} is not complete`);
    assert.equal(matching[0].conclusion, 'success', `${name} did not pass`);
  }
}

export function assertPlan(plan, env, readFile) {
  assert.equal(plan.tag, tag);
  assert.equal(plan.version, '0.4.4');
  assert.equal(plan.commit, env.GITHUB_SHA);
  assert.equal(plan.workflow_run, env.GITHUB_RUN_ID);
  assert(plan.body.includes('<!-- KONOFIX-BETA-PREVIEW -->'));
  assert(plan.body.includes('56/67'));
  const archive = `Konofix-Chat-0.4.4-Windows-${plan.commit}.zip`;
  const expected = ['BUILD_INFO.json', 'Konofix-Chat-0.4.4-beta.1-setup.exe', 'Konofix-Chat-0.4.4-beta.1-setup.exe.sha256', archive, `${archive}.sha256`].sort();
  assert.deepEqual(plan.files.map((file) => file.name).sort(), expected, 'Unexpected or duplicate release files');
  for (const file of plan.files) {
    const bytes = readFile(file.name);
    assert.equal(bytes.length, file.bytes, `Wrong size: ${file.name}`);
    assert.equal(sha256(bytes), file.sha256, `Wrong digest: ${file.name}`);
  }
  const info = JSON.parse(readFile('BUILD_INFO.json'));
  assert.equal(info.commit, plan.commit);
  assert.equal(info.workflow_run, plan.workflow_run);
  assert.equal(info.version, plan.version);
}

export function assertAsset(expected, actual) {
  assert.equal(actual.name, expected.name);
  assert.equal(actual.state, 'uploaded');
  assert.equal(actual.size, expected.bytes);
  assert.equal(actual.digest, `sha256:${expected.sha256}`, `Uploaded digest mismatch: ${expected.name}`);
}

// Create an unpublished draft first. Retries resume identical assets, never
// replace a published release, move a tag, or delete conflicting uploads.
export async function publishBeta(plan, api, readFile) {
  let release = await api('GET', `/releases/tags/${tag}`, undefined, true);
  if (release && !release.draft) {
    assert.equal(release.prerelease, true, 'Existing tag is not a prerelease');
    return { url: release.html_url, skipped: true };
  }
  if (!release) {
    const drafts = (await api('GET', '/releases?per_page=100')).filter((item) => item.tag_name === tag && item.draft);
    assert(drafts.length <= 1, 'Multiple beta drafts require manual inspection');
    release = drafts[0];
  }
  const ref = await api('GET', `/git/ref/tags/${tag}`, undefined, true);
  if (ref) assert.equal(ref.object.sha, plan.commit, 'Refusing to move an existing beta tag');
  if (release) {
    assert.equal(release.target_commitish, plan.commit, 'Existing draft belongs to another build');
    assert.equal(release.prerelease, true);
  } else {
    release = await api('POST', '/releases', { tag_name: tag, target_commitish: plan.commit, name: 'Konofix Chat 0.4.4 Beta 1 — Secure Chat Accessibility Preview', body: plan.body, draft: true, prerelease: true, make_latest: 'false' });
  }
  const assets = await api('GET', `/releases/${release.id}/assets?per_page=100`);
  assert(assets.every((asset) => plan.files.some((file) => file.name === asset.name)), 'Unexpected draft assets; manual inspection required');
  for (const file of plan.files) {
    const existing = assets.filter((asset) => asset.name === file.name);
    assert(existing.length <= 1, 'Duplicate draft asset');
    const uploaded = existing[0] ?? await api('UPLOAD', `/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, readFile(file.name));
    assertAsset(file, uploaded);
  }
  const finalAssets = await api('GET', `/releases/${release.id}/assets?per_page=100`);
  assert.equal(finalAssets.length, plan.files.length);
  for (const file of plan.files) assertAsset(file, finalAssets.find((asset) => asset.name === file.name));
  await api('PATCH', `/releases/${release.id}`, { body: plan.body, draft: false, prerelease: true, make_latest: 'false' });
  const published = await api('GET', `/releases/${release.id}`);
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, true);
  const publishedRef = await api('GET', `/git/ref/tags/${tag}`);
  assert.equal(publishedRef.object.sha, plan.commit);
  return { url: published.html_url, skipped: false };
}

async function main() {
  assertContext(process.env);
  assert(process.env.GH_TOKEN, 'Workflow token is required');
  const api = async (method, endpoint, body, allowMissing = false) => {
    const upload = method === 'UPLOAD';
    const response = await fetch(`https://${upload ? 'uploads' : 'api'}.github.com/repos/${repository}${endpoint}`, {
      method: upload ? 'POST' : method,
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(body === undefined ? {} : { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (allowMissing && response.status === 404) return null;
    assert(response.ok, `GitHub ${method} ${endpoint} returned HTTP ${response.status}`);
    return response.json();
  };
  const plan = JSON.parse(fs.readFileSync('beta-release/plan.json', 'utf8'));
  const readFile = (name) => fs.readFileSync(path.join('beta-release', name));
  assertPlan(plan, process.env, readFile);
  const checks = await api('GET', `/commits/${plan.commit}/check-runs?per_page=100`);
  assertChecks(checks.check_runs, plan.commit);
  const result = await publishBeta(plan, api, readFile);
  console.log(`${result.skipped ? 'Already published; preserved' : 'Published beta preview'}: ${result.url}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n[${result.skipped ? 'Existing beta (unchanged)' : 'Download beta preview'}](${result.url})\n\nGlobal Beta qualification remains 56/67 (83.6%); real-network gates remain open.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
