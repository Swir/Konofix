import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticipantDirectory } from '../services/discovery/participant-directory.mjs';
import { contactHandler } from '../services/discovery/http-contact.mjs';

// Header/handler fixtures, not a packaged WebView or Internet deployment.
const SERVICE = 'https://contact.invalid', APP = 'http://tauri.localhost';
const directory = () => new ParticipantDirectory({ origin: SERVICE });
const context = { observedIp: '8.8.4.4' };
const request = (path, init = {}) => new Request(SERVICE + path, init);

test('lookup CORS allows only the exact configured packaged-app origin without credentials', async () => {
  const handle = contactHandler(directory(), { allowedOrigins: [APP] });
  const response = await handle(request('/v1/contacts', { headers: { Origin: APP } }), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), APP);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.match(response.headers.get('vary'), /Origin/);
  assert.deepEqual(await response.json(), { schema: 1, origin: SERVICE, contacts: [] });
});

test('unconfigured browser access is denied while native no-Origin lookup is unchanged', async () => {
  const handle = contactHandler(directory());
  assert.equal((await handle(request('/v1/contacts', { headers: { Origin: APP } }), context)).status, 403);
  const response = await handle(request('/v1/contacts'), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('null, lookalike, suffix, wrong-scheme and wrong-port origins are not reflected', async () => {
  const handle = contactHandler(directory(), { allowedOrigins: [APP] });
  for (const origin of ['null', APP + '.evil.invalid', APP + ':81', 'https://tauri.localhost', 'https://untrusted.invalid']) {
    const response = await handle(request('/v1/contacts', { headers: { Origin: origin } }), context);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('JSON registration preflight is allowed without performing a registration', async () => {
  const d = directory(); let registrations = 0;
  d.register = () => { registrations++; throw Error('must not run'); };
  const handle = contactHandler(d, { allowedOrigins: [APP] });
  const response = await handle(request('/v1/contact', { method: 'OPTIONS', headers: {
    Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } }), context);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), APP);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
  assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/);
  assert.equal(registrations, 0);
});

test('preflight rejects unsupported methods, endpoints, service origins and credential headers', async () => {
  const handle = contactHandler(directory(), { allowedOrigins: [APP] });
  for (const [url, method, headers] of [
    [SERVICE + '/v1/contact', 'DELETE', 'content-type'],
    [SERVICE + '/unrelated', 'POST', 'content-type'],
    [SERVICE + '/v1/contact?q=1', 'POST', 'content-type'],
    [SERVICE + '/v1/contact', 'POST', 'authorization'],
    [SERVICE + '/v1/contact', 'POST', 'x-forwarded-for'],
    ['https://other.invalid/v1/contact', 'POST', 'content-type'],
    [SERVICE + '/v1/contact', 'POST', 'x'.repeat(257)],
  ]) {
    const response = await handle(new Request(url, { method: 'OPTIONS', headers: {
      Origin: APP, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers,
    } }), context);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-methods'), null);
  }
});

test('invalid contact errors remain readable by the allowed app, without bypassing verification', async () => {
  const handle = contactHandler(directory(), { allowedOrigins: [APP] });
  const response = await handle(request('/v1/contact', { method: 'POST', headers: {
    Origin: APP, 'Content-Type': 'application/json',
  }, body: '{}' }), context);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), APP);
  assert.deepEqual(await response.json(), { error: 'invalid_contact' });
});

test('CORS does not change trusted-ingress address observation or trust forwarded headers', async () => {
  const handle = contactHandler(directory(), { allowedOrigins: [APP] });
  const response = await handle(request('/v1/observe', { headers: { Origin: APP, 'X-Forwarded-For': '1.1.1.1' } }), context);
  assert.equal((await response.json()).ip, context.observedIp);
});

test('CORS configuration is copied, bounded and rejects wildcard or malformed origins', async () => {
  for (const origins of ['*', ['*'], ['null'], [APP, APP], [APP + '/'], [null], Array(9).fill(APP)]) {
    assert.throws(() => contactHandler(directory(), { allowedOrigins: origins }));
  }
  const origins = [APP], handle = contactHandler(directory(), { allowedOrigins: origins });
  origins.push('https://not-approved.invalid');
  assert.equal((await handle(request('/v1/contacts', { headers: { Origin: origins[1] } }), context)).status, 403);
});
