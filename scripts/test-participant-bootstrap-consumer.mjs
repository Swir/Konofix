import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hex, peerIdFromPublicKey, signingBytes } from '../services/discovery/participant-directory.mjs';

const source = process.env.KONOFIX_DISCOVERY_SOURCE
  ? pathToFileURL(process.env.KONOFIX_DISCOVERY_SOURCE).href
  : new URL('../src/bootstrap-discovery.ts', import.meta.url).href;
const { loadRemoteBootstraps, DEFAULT_REMOTE_BOOTSTRAP_URL: POOL, CONTACT_CACHE_KEY } = await import(source);
// Injected HTTP only. Neither these origins nor IPs are deployed/tested peers.
const A = 'https://first-contact-a.invalid', B = 'https://first-contact-b.invalid';
const epoch = 1_800_000_000_000;
const S = '/dns/static.example/tcp/45555/p2p/12D3KooWStatic';
const memory = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
};
const json = value => new Response(JSON.stringify(value));
const manifest = (origins = [A], seeds = []) => ({ schema: 1, seeds, contact_origins: origins });
const snapshot = (origin, contacts) => json({ schema: 1, origin, contacts });
const opts = store => ({ store, now: () => epoch });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function signed(origin = A, changes = {}) {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const public_key = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const record = { schema: 1, origin, protocol: '/konofix/control/1.0.0', public_key,
    peer_id: peerIdFromPublicKey(public_key), ip: '8.8.4.4', tcp_port: 45555,
    quic_port: 45555, issued_at: epoch, expires_at: epoch + 120000, sequence: 1, ...changes };
  record.signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, signingBytes(record)));
  return record;
}
const routes = record => [
  `/ip4/${record.ip}/tcp/${record.tcp_port}/p2p/${record.peer_id}`,
  `/ip4/${record.ip}/udp/${record.quic_port}/quic-v1/p2p/${record.peer_id}`,
];
function network(metadata, sources, calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(!init.method || init.method === 'GET', 'lookup never publishes client metadata');
    assert.equal(init.body, undefined);
    if (url === POOL) return json(metadata);
    const handle = sources[url];
    assert.ok(handle, `unexpected request: ${url}`);
    return handle(init);
  };
}

test('production resolver consumes a signed participant snapshot with no saved peers', async () => {
  const record = await signed(), calls = [];
  const fetchImpl = network(manifest(), { [`${A}/v1/contacts`]: () => snapshot(A, [record]) }, calls);
  assert.deepEqual(await loadRemoteBootstraps(fetchImpl, undefined, undefined, opts(memory())), routes(record));
  assert.deepEqual(calls, [POOL, `${A}/v1/contacts`]);
});

test('legacy and empty metadata cause no implicit external directory requests', async () => {
  for (const metadata of [{ schema: 1, seeds: [] }, { schema: 1, seeds: [S] }, manifest([])]) {
    const calls = [];
    assert.deepEqual(await loadRemoteBootstraps(network(metadata, {}, calls), undefined, undefined, opts(memory())), metadata.seeds);
    assert.deepEqual(calls, [POOL]);
  }
});

test('origin allowlist is bounded, canonical, HTTPS-only and rejects duplicates', async () => {
  for (const origins of [null, 'https://x.invalid', [A, A], [A, B, 'https://c.invalid'],
    ['http://a.invalid'], [A + '/'], [A + '/path'], [A + '?q=1'], ['https://user:pass@a.invalid'], [17]]) {
    const calls = [];
    assert.deepEqual(await loadRemoteBootstraps(network(manifest(origins), {}, calls), undefined, undefined, opts(memory())), []);
    assert.deepEqual(calls, [POOL]);
  }
});

test('each independent directory contributes within the existing 16-address budget', async () => {
  const first = await Promise.all(Array.from({ length: 9 }, () => signed(A)));
  const second = await Promise.all(Array.from({ length: 9 }, () => signed(B)));
  const result = await loadRemoteBootstraps(network(manifest([A, B]), {
    [`${A}/v1/contacts`]: () => snapshot(A, first), [`${B}/v1/contacts`]: () => snapshot(B, second),
  }), undefined, undefined, opts(memory()));
  assert.equal(result.length, 16);
  assert.deepEqual(result.slice(0, 4), [routes(first[0])[0], routes(second[0])[0], routes(first[0])[1], routes(second[0])[1]]);
});

test('static seed priority and manual-source capacity are preserved', async () => {
  const record = await signed();
  const result = await loadRemoteBootstraps(network(manifest([A], [S, ...routes(record)]), {
    [`${A}/v1/contacts`]: () => snapshot(A, [record]),
  }), undefined, undefined, opts(memory()));
  assert.deepEqual(result, [S, ...routes(record)]);
});

test('bad identity, signature, protocol, scope and private address never become dial hints', async () => {
  const good = await signed();
  const bad = [
    { ...good, signature: '00'.repeat(64) }, { ...good, peer_id: '12D3KooWForged' },
    await signed(A, { protocol: '/wrong/control' }), await signed(B),
    await signed(A, { ip: '192.168.1.2' }), { ...good, unexpected: true },
  ];
  for (const record of bad) {
    assert.deepEqual(await loadRemoteBootstraps(network(manifest(), {
      [`${A}/v1/contacts`]: () => snapshot(A, [record]),
    }), undefined, undefined, opts(memory())), []);
  }
});

test('invalid snapshot from one origin does not suppress a valid other source', async () => {
  const record = await signed(B);
  assert.deepEqual(await loadRemoteBootstraps(network(manifest([A, B]), {
    [`${A}/v1/contacts`]: () => json({ schema: 1, origin: A, contacts: [false] }),
    [`${B}/v1/contacts`]: () => snapshot(B, [record]),
  }), undefined, undefined, opts(memory())), routes(record));
});

test('static seeds survive an unavailable directory without registering the client', async () => {
  const calls = [];
  assert.deepEqual(await loadRemoteBootstraps(network(manifest([A], [S]), {
    [`${A}/v1/contacts`]: () => new Response('offline', { status: 503 }),
  }, calls), undefined, undefined, opts(memory())), [S]);
  assert.ok(calls.every(url => !url.endsWith('/v1/contact')));
});

test('global deadline retains completed contacts when another origin ignores abort', async () => {
  const record = await signed(A); let stalledSignal;
  const result = await loadRemoteBootstraps(network(manifest([A, B], [S]), {
    [`${A}/v1/contacts`]: () => snapshot(A, [record]),
    [`${B}/v1/contacts`]: init => { stalledSignal = init.signal; return new Promise(() => {}); },
  }), undefined, 100, opts(memory()));
  assert.deepEqual(result, [S, ...routes(record)]);
  assert.equal(stalledSignal.aborted, true);
});

test('late HTTPS completion after deadline cannot supply or persist participant contacts', async () => {
  const record = await signed(), store = memory(); let finish;
  const result = await loadRemoteBootstraps(network(manifest(), {
    [`${A}/v1/contacts`]: () => new Promise(resolve => { finish = resolve; }),
  }), undefined, 20, opts(store));
  assert.deepEqual(result, []);
  finish(snapshot(A, [record])); await sleep(10);
  assert.equal(store.getItem(CONTACT_CACHE_KEY), null);
});

test('short-lived signed contacts never enter or reappear from the static-seed cache', async () => {
  const record = await signed(), store = memory();
  assert.deepEqual(await loadRemoteBootstraps(network(manifest([A], [S]), {
    [`${A}/v1/contacts`]: () => snapshot(A, [record]),
  }), undefined, undefined, opts(store)), [S, ...routes(record)]);
  const cached = JSON.parse(store.getItem(CONTACT_CACHE_KEY));
  assert.deepEqual(cached.pool, { schema: 1, seeds: [S] });
  assert.ok(!JSON.stringify(cached).includes(record.peer_id));
  assert.deepEqual(await loadRemoteBootstraps(async () => { throw Error('offline'); }, undefined, undefined,
    { store, now: () => epoch + 121000 }), [S]);
});

test('expired and duplicate signed records reject the whole origin response', async () => {
  const good = await signed(), expired = await signed(A, { issued_at: epoch - 120000, expires_at: epoch });
  for (const records of [[good, good], [expired]]) {
    assert.deepEqual(await loadRemoteBootstraps(network(manifest(), {
      [`${A}/v1/contacts`]: () => snapshot(A, records),
    }), undefined, undefined, opts(memory())), []);
  }
});

test('freshness is rechecked at handoff after a slower directory completes', async () => {
  let now = epoch; const record = await signed(A, { expires_at: epoch + 100 });
  const result = await loadRemoteBootstraps(network(manifest([A, B]), {
    [`${A}/v1/contacts`]: () => snapshot(A, [record]),
    [`${B}/v1/contacts`]: async () => { await sleep(40); now = epoch + 101; return snapshot(B, []); },
  }), undefined, undefined, { store: memory(), now: () => now });
  assert.deepEqual(result, []);
});

test('directory withdrawal does not reuse endpoints from previous metadata or cache', async () => {
  const record = await signed(), store = memory();
  await loadRemoteBootstraps(network(manifest([A], [S]), {
    [`${A}/v1/contacts`]: () => snapshot(A, [record]),
  }), undefined, undefined, opts(store));
  const calls = [];
  assert.deepEqual(await loadRemoteBootstraps(network(manifest([]), {}, calls), undefined, undefined, opts(store)), []);
  assert.deepEqual(calls, [POOL]);
  assert.equal(store.getItem(CONTACT_CACHE_KEY), null);
});

test('oversized or invalid UTF-8 directory responses cannot supply contacts', async () => {
  for (const bytes of [new Uint8Array(65537), new Uint8Array([255])]) {
    assert.deepEqual(await loadRemoteBootstraps(network(manifest(), {
      [`${A}/v1/contacts`]: () => new Response(bytes),
    }), undefined, undefined, opts(memory())), []);
  }
});

test('blocked storage and stalled directory body cannot block static/manual operation', async () => {
  let cancelled = false;
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } };
  assert.deepEqual(await loadRemoteBootstraps(network(manifest([A], [S]), {
    [`${A}/v1/contacts`]: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  }), undefined, 20, opts(denied)), [S]);
  assert.equal(cancelled, true);
});
