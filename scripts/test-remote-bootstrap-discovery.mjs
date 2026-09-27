import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const source = process.env.KONOFIX_DISCOVERY_SOURCE
  ? pathToFileURL(process.env.KONOFIX_DISCOVERY_SOURCE).href
  : new URL('../src/bootstrap-discovery.ts', import.meta.url).href;
const {
  DEFAULT_REMOTE_BOOTSTRAP_URL, DEFAULT_TIMEOUT_MS, CONTACT_CACHE_KEY,
  CONTACT_CACHE_TTL_MS, MAX_POOL_BYTES, loadRemoteBootstraps,
  mergeBootstrapSources, normalizeBootstrapList, parseBootstrapPoolManifest,
} = await import(source);

// Fixture addresses are NOT deployed peers or Internet evidence.
const A = '/dns/contact-a.example/tcp/45555/p2p/12D3KooWAlpha';
const B = '/dns/contact-b.example/udp/45555/quic-v1/p2p/12D3KooWBravo';
const epoch = 1_800_000_000_000;
const pool = seeds => ({ schema: 1, seeds });
const response = seeds => new Response(JSON.stringify(pool(seeds)));
const offline = async () => { throw new Error('offline'); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const memory = () => {
  const values = new Map();
  let writes = 0;
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes++; },
    removeItem: key => { values.delete(key); writes++; },
    get writes() { return writes; },
  };
};
const options = store => ({ store, now: () => epoch });
async function within(promise, timeout = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('discovery did not meet its hard deadline')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

test('canonical source and unchanged short timeout', () => {
  assert.equal(DEFAULT_REMOTE_BOOTSTRAP_URL, 'https://raw.githubusercontent.com/Swir/Konofix/main/src-tauri/bootstrap-pool.json');
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 2500);
});

test('normalization is bounded, rejects zero/invalid limits and preserves first occurrence', () => {
  assert.deepEqual(normalizeBootstrapList([` ${A} `, A, 123, 'https://not-a-multiaddr.example/', B]), [A, B]);
  for (const limit of [0, -1, 0.5, NaN, Infinity]) assert.deepEqual(normalizeBootstrapList([A], limit), []);
  assert.deepEqual(normalizeBootstrapList([A, B], 1), [A]);
  assert.deepEqual(normalizeBootstrapList([A + '/tcp/99', A + '\ninvalid', '/' + 'x'.repeat(4096) + '/p2p/x']), []);
});

test('malformed manifest is rejected as a whole, not partially accepted', () => {
  for (const bad of [null, [], { schema: 2, seeds: [A] }, { schema: 1, seeds: 'x' }, pool([A, A]), pool([A, false]), pool([A, 'https://x']), pool(Array(17).fill(A))]) {
    assert.deepEqual(parseBootstrapPoolManifest(bad), []);
  }
  assert.deepEqual(parseBootstrapPoolManifest(pool([A, B])), [A, B]);
  assert.deepEqual(parseBootstrapPoolManifest(pool([])), []);
});

test('custom contacts and source ordering are not rewritten', () => {
  assert.deepEqual(mergeBootstrapSources([A], [B, A]), [A, B]);
  assert.deepEqual(mergeBootstrapSources([], [' /ip4/192.168.1.2/tcp/45555/p2p/local ']), ['/ip4/192.168.1.2/tcp/45555/p2p/local']);
});

test('live response uses credential-free no-redirect HTTPS metadata and seals local cache', async () => {
  const store = memory();
  let signal;
  const result = await loadRemoteBootstraps(async (url, init) => {
    assert.equal(url, DEFAULT_REMOTE_BOOTSTRAP_URL);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    signal = init.signal;
    return response([A]);
  }, undefined, undefined, options(store));
  assert.deepEqual(result, [A]);
  assert.equal(signal.aborted, true);
  const entry = JSON.parse(store.getItem(CONTACT_CACHE_KEY));
  assert.deepEqual(entry, { schema: 1, source: DEFAULT_REMOTE_BOOTSTRAP_URL, saved_at: epoch,
    expires_at: epoch + CONTACT_CACHE_TTL_MS, pool: pool([A]) });
});

test('transient source failure recovers unexpired contacts without extending expiry', async () => {
  const store = memory();
  await loadRemoteBootstraps(async () => response([A]), undefined, undefined, options(store));
  const snapshot = store.getItem(CONTACT_CACHE_KEY);
  assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined, { store, now: () => epoch + 1000 }), [A]);
  assert.equal(store.getItem(CONTACT_CACHE_KEY), snapshot);
  assert.equal(store.writes, 1);
});

test('explicit empty source withdraws cached contacts and does not invent peers', async () => {
  const store = memory();
  await loadRemoteBootstraps(async () => response([A]), undefined, undefined, options(store));
  assert.deepEqual(await loadRemoteBootstraps(async () => response([]), undefined, undefined, options(store)), []);
  assert.equal(store.getItem(CONTACT_CACHE_KEY), null);
  assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined, options(store)), []);
});

test('cold start with empty pool and no remembered contacts stays empty', async () => {
  assert.deepEqual(await loadRemoteBootstraps(async () => response([]), undefined, undefined, options(memory())), []);
  assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined, options(memory())), []);
});

test('expired, future, wrong-source, oversized and malformed caches cannot supply contacts', async () => {
  const good = { schema: 1, source: DEFAULT_REMOTE_BOOTSTRAP_URL, saved_at: epoch,
    expires_at: epoch + CONTACT_CACHE_TTL_MS, pool: pool([A]) };
  for (const raw of [
    'broken', ' '.repeat(MAX_POOL_BYTES + 1), JSON.stringify(null),
    JSON.stringify({ ...good, source: 'https://other.example/pool' }),
    JSON.stringify({ ...good, saved_at: epoch + 1 }),
    JSON.stringify({ ...good, expires_at: epoch + CONTACT_CACHE_TTL_MS + 1 }),
    JSON.stringify({ ...good, saved_at: epoch - CONTACT_CACHE_TTL_MS, expires_at: epoch }),
    JSON.stringify({ ...good, saved_at: String(epoch) }),
    JSON.stringify({ ...good, pool: pool([A, 'invalid']) }),
  ]) {
    const store = memory(); store.setItem(CONTACT_CACHE_KEY, raw);
    assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined, options(store)), []);
  }
});

test('expiry is evaluated when falling back, not before the request', async () => {
  const store = memory();
  await loadRemoteBootstraps(async () => response([A]), undefined, undefined, options(store));
  assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined,
    { store, now: () => epoch + CONTACT_CACHE_TTL_MS }), []);
});

test('blocked browser storage cannot block live participant contacts', async () => {
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } };
  assert.deepEqual(await loadRemoteBootstraps(async () => response([A]), undefined, undefined, options(denied)), [A]);
  assert.deepEqual(await loadRemoteBootstraps(offline, undefined, undefined, options(denied)), []);
  assert.deepEqual(await loadRemoteBootstraps(async () => response([]), undefined, undefined, options(denied)), []);
});

test('hard deadline releases login even when fetch ignores abort', async () => {
  let signal;
  const fetchNeverSettles = async (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  assert.deepEqual(await within(loadRemoteBootstraps(fetchNeverSettles, undefined, 15, options(null))), []);
  assert.equal(signal.aborted, true);
});

test('hard deadline covers a stalled body and cancels its reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  assert.deepEqual(await within(loadRemoteBootstraps(async () => new Response(body), undefined, 15, options(null))), []);
  assert.equal(cancelled, true);
});

test('late response after timeout cannot install contacts or poison cache', async () => {
  const store = memory(); let finish;
  const pending = loadRemoteBootstraps(() => new Promise(resolve => { finish = resolve; }), undefined, 15, options(store));
  assert.deepEqual(await within(pending), []);
  finish(response([A])); await tick();
  assert.equal(store.getItem(CONTACT_CACHE_KEY), null);
  assert.equal(store.writes, 0);
});

test('obsolete concurrent result cannot overwrite a newer contact snapshot', async () => {
  const store = memory(); let finish;
  const older = loadRemoteBootstraps(() => new Promise(resolve => { finish = resolve; }), undefined, undefined, options(store));
  assert.deepEqual(await loadRemoteBootstraps(async () => response([B]), undefined, undefined, options(store)), [B]);
  finish(response([A])); assert.deepEqual(await older, [A]);
  assert.deepEqual(JSON.parse(store.getItem(CONTACT_CACHE_KEY)).pool, pool([B]));
});

test('declared oversized body is cancelled without parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const result = await loadRemoteBootstraps(async () => new Response(body, { headers: { 'content-length': String(MAX_POOL_BYTES + 1) } }), undefined, undefined, options(null));
  assert.deepEqual(result, []); assert.equal(cancelled, true);
});

test('streamed actual bytes are bounded even with a false short content-length', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(JSON.stringify({ ...pool([A]), padding: 'x'.repeat(MAX_POOL_BYTES) }));
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  assert.deepEqual(await loadRemoteBootstraps(async () => new Response(body, { headers: { 'content-length': '1' } }), undefined, undefined, options(null)), []);
  assert.equal(cancelled, true);
});

test('strict UTF-8 and JSON parsing reject damaged remote metadata', async () => {
  for (const bytes of [new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('{'), new TextEncoder().encode(JSON.stringify(pool([A, 'invalid'])))]) {
    assert.deepEqual(await loadRemoteBootstraps(async () => new Response(bytes), undefined, undefined, options(null)), []);
  }
});

test('UTF-8 split across network chunks still decodes correctly', async () => {
  const raw = new TextEncoder().encode(JSON.stringify({ ...pool([A]), note: '\u015bl\u0105sk' }));
  const body = new ReadableStream({ start(c) { for (const byte of raw) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await loadRemoteBootstraps(async () => new Response(body), undefined, undefined, options(null)), [A]);
});

test('HTTP failure and invalid body recover the previous bounded contact cache', async () => {
  const store = memory(); await loadRemoteBootstraps(async () => response([A]), undefined, undefined, options(store));
  const snapshot = store.getItem(CONTACT_CACHE_KEY);
  for (const make of [() => new Response('unavailable', { status: 503 }), () => new Response('not json')]) {
    assert.deepEqual(await loadRemoteBootstraps(async () => make(), undefined, undefined, options(store)), [A]);
    assert.equal(store.getItem(CONTACT_CACHE_KEY), snapshot);
  }
});
