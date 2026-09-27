import assert from 'node:assert/strict';
import { validatePool } from './check-public-bootstrap-pool.mjs';

assert.deepEqual(validatePool({ schema: 1, seeds: [] }), []);
assert.throws(() => validatePool({ schema: 1, seeds: [] }, { requirePublic: true }), /requires at least one/);
const a='/dns/node.example.com/tcp/45555/p2p/12D3KooWExample';
assert.deepEqual(validatePool({ schema: 1, seeds: [a] }, { requirePublic: true }), [a]);
for (const bad of [
  null,
  [],
  { schema: 2, seeds: [] },
  { schema: 1, seeds: 'x' },
  { schema: 1, seeds: [' x'] },
  { schema: 1, seeds: ['https://example.com'] },
  { schema: 1, seeds: ['/dns/node.example.com/tcp/45555'] },
  { schema: 1, seeds: [a, a] },
]) assert.throws(() => validatePool(bad));
console.log('Public bootstrap pool gate tests passed.');
