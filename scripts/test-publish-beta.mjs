import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertContext, assertChecks, assertPlan, publishBeta } from './publish-beta.mjs';

const commit = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Swir/Konofix', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, GITHUB_RUN_ID: '1234' };
assertContext(env);
for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['GITHUB_REPOSITORY', 'fork/Konofix'], ['GITHUB_REF', 'refs/pull/1/merge'], ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_SHA', 'main']]) {
  assert.throws(() => assertContext({ ...env, [key]: value }));
}
const checks = ['check-windows', 'node-linux', 'audit'].map((name, id) => ({ name, id, head_sha: commit, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }));
assertChecks(checks, commit);
assert.throws(() => assertChecks(checks.slice(1), commit));
assert.throws(() => assertChecks(checks, 'b'.repeat(40)));
assert.throws(() => assertChecks([...checks, { ...checks[0], id: 99, status: 'in_progress', conclusion: null }], commit));
assert.throws(() => assertChecks(checks.map((item) => ({ ...item, app: { slug: 'unknown-app' } })), commit));

const archive = `Konofix-Chat-0.4.2-Windows-${commit}.zip`;
const bytes = new Map(['BUILD_INFO.json', 'Konofix-Chat-0.4.2-beta.1-setup.exe', 'Konofix-Chat-0.4.2-beta.1-setup.exe.sha256', archive, `${archive}.sha256`].map((name) => [name, Buffer.from(name)]));
bytes.set('BUILD_INFO.json', Buffer.from(JSON.stringify({ commit, version: '0.4.2', workflow_run: '1234' })));
const read = (name) => bytes.get(name);
const plan = { tag: 'v0.4.2-beta.1', version: '0.4.2', commit, workflow_run: '1234', body: '<!-- KONOFIX-BETA-PREVIEW --> 55/67', files: [...bytes].map(([name, value]) => ({ name, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') })) };
assertPlan(plan, env, read);
assert.throws(() => assertPlan({ ...plan, commit: 'b'.repeat(40) }, env, read));
assert.throws(() => assertPlan({ ...plan, files: [...plan.files, plan.files[0]] }, env, read));
assert.throws(() => assertPlan(plan, env, () => Buffer.from('tampered')));

function service({ existing, tagCommit, failUpload, corruptDigest, seedAssets = [] } = {}) {
  const state = { release: existing, assets: [...seedAssets], calls: [], tagCommit };
  const api = async (method, endpoint, body) => {
    state.calls.push({ method, endpoint, body });
    if (method === 'GET' && endpoint.startsWith('/releases/tags/')) return state.release ?? null;
    if (method === 'GET' && endpoint.startsWith('/git/ref/')) return state.tagCommit ? { object: { sha: state.tagCommit } } : null;
    if (method === 'POST') {
      state.release = { id: 10, ...body, html_url: 'https://github.com/Swir/Konofix/releases/tag/v0.4.2-beta.1' };
      return state.release;
    }
    if (method === 'GET' && endpoint.includes('/assets?')) return state.assets;
    if (method === 'UPLOAD') {
      if (failUpload) throw new Error('Simulated upload failure');
      const asset = { name: decodeURIComponent(endpoint.split('name=')[1]), size: body.length, digest: `sha256:${corruptDigest ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex')}`, state: 'uploaded' };
      state.assets.push(asset);
      return asset;
    }
    if (method === 'PATCH') { Object.assign(state.release, body); state.tagCommit = commit; return state.release; }
    if (method === 'GET') return state.release;
    throw new Error('Unexpected API call');
  };
  return { state, api };
}
const good = service();
assert.equal((await publishBeta(plan, good.api, read)).skipped, false);
assert.equal(good.state.assets.length, 5);
const patchIndex = good.state.calls.findIndex((call) => call.method === 'PATCH');
assert(good.state.calls.slice(0, patchIndex).filter((call) => call.method === 'UPLOAD').length === 5);
assert.equal(good.state.calls.find((call) => call.method === 'POST').body.draft, true);
assert.equal(good.state.release.prerelease, true);
assert.equal(good.state.release.make_latest, 'false');

for (const options of [{ failUpload: true }, { corruptDigest: true }, { tagCommit: 'b'.repeat(40) }, { existing: { id: 10, draft: true, prerelease: true, target_commitish: 'b'.repeat(40) } }, { seedAssets: [{ name: 'unexpected.exe' }] }]) {
  const bad = service(options);
  await assert.rejects(() => publishBeta(plan, bad.api, read));
  assert(!bad.state.calls.some((call) => call.method === 'PATCH'), 'Invalid or incomplete assets must not be published');
}
const retry = service({ existing: { id: 10, draft: true, prerelease: true, target_commitish: commit }, seedAssets: good.state.assets });
await publishBeta(plan, retry.api, read);
assert(!retry.state.calls.some((call) => call.method === 'UPLOAD'), 'Identical draft assets should be resumed');
const immutable = service({ existing: { draft: false, prerelease: true, html_url: 'existing' } });
assert.equal((await publishBeta(plan, immutable.api, read)).skipped, true);
assert(!immutable.state.calls.some((call) => call.method !== 'GET'), 'Published releases must never be rewritten');
console.log('Beta publishing: trusted context, exact CI/build, draft upload verification, resume and immutable release tests PASS.');
