import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function validatePool(payload, { requirePublic = false } = {}) {
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'bootstrap pool must be an object');
  assert.equal(payload.schema, 1, 'bootstrap pool schema must be 1');
  assert(Array.isArray(payload.seeds), 'bootstrap pool seeds must be an array');
  assert(payload.seeds.length <= 16, 'bootstrap pool may contain at most 16 seeds');
  const seen = new Set();
  for (const raw of payload.seeds) {
    assert.equal(typeof raw, 'string', 'every bootstrap seed must be a string');
    const seed = raw.trim();
    assert.equal(seed, raw, 'bootstrap seed must not contain surrounding whitespace');
    assert(seed.startsWith('/'), 'bootstrap seed must be a multiaddr');
    assert(seed.includes('/p2p/'), 'bootstrap seed must contain a terminal Peer ID');
    assert(!seen.has(seed), 'bootstrap pool must not contain duplicates');
    seen.add(seed);
  }
  if (requirePublic) assert(payload.seeds.length > 0, 'release-grade Internet discovery requires at least one verified public bootstrap seed');
  return payload.seeds;
}

export function readPool(filePath, options) {
  const bytes = fs.readFileSync(filePath, 'utf8');
  return validatePool(JSON.parse(bytes), options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const requirePublic = process.argv.includes('--require-public');
  const file = path.resolve('src-tauri/bootstrap-pool.json');
  const seeds = readPool(file, { requirePublic });
  console.log(`Bootstrap pool structure PASS: ${seeds.length} seed(s)${requirePublic ? ', public seed required' : ''}.`);
}
