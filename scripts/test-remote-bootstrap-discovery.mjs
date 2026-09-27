import assert from 'node:assert/strict';
import {
  DEFAULT_REMOTE_BOOTSTRAP_URL,
  DEFAULT_TIMEOUT_MS,
  loadRemoteBootstraps,
  mergeBootstrapSources,
  normalizeBootstrapList,
  parseBootstrapPoolManifest,
} from '../src/bootstrap-discovery.ts';

assert.equal(
  DEFAULT_REMOTE_BOOTSTRAP_URL,
  'https://raw.githubusercontent.com/Swir/Konofix/main/src-tauri/bootstrap-pool.json',
);
assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 2500);

assert.deepEqual(
  normalizeBootstrapList([
    ' /dns/node-a.example/tcp/45555/p2p/12D3KooWAlpha ',
    '/dns/node-a.example/tcp/45555/p2p/12D3KooWAlpha',
    123,
    'https://not-a-multiaddr.example/',
    '/dns/node-b.example/udp/45555/quic-v1/p2p/12D3KooWBravo',
  ]),
  [
    '/dns/node-a.example/tcp/45555/p2p/12D3KooWAlpha',
    '/dns/node-b.example/udp/45555/quic-v1/p2p/12D3KooWBravo',
  ],
);

assert.deepEqual(parseBootstrapPoolManifest({ schema: 2, seeds: ['/dns/a/p2p/x'] }), []);
assert.deepEqual(parseBootstrapPoolManifest({ schema: 1, seeds: 'not-an-array' }), []);

assert.deepEqual(
  mergeBootstrapSources(
    ['/dns/remote/tcp/45555/p2p/remote'],
    ['/dns/custom/tcp/45555/p2p/custom', '/dns/remote/tcp/45555/p2p/remote'],
  ),
  [
    '/dns/remote/tcp/45555/p2p/remote',
    '/dns/custom/tcp/45555/p2p/custom',
  ],
);

const good = await loadRemoteBootstraps(async (_input, init) => {
  assert.equal(init?.cache, 'no-store');
  assert.ok(init?.signal);
  return {
    ok: true,
    json: async () => ({
      schema: 1,
      seeds: ['/dns/live.example/tcp/45555/p2p/12D3KooWLive'],
    }),
  };
});
assert.deepEqual(good, ['/dns/live.example/tcp/45555/p2p/12D3KooWLive']);

assert.deepEqual(
  await loadRemoteBootstraps(async () => ({ ok: false, json: async () => ({}) })),
  [],
);
assert.deepEqual(
  await loadRemoteBootstraps(async () => { throw new Error('offline'); }),
  [],
);

console.log('Remote bootstrap discovery tests passed.');
