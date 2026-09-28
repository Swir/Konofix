import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, ParticipantDirectory, hex, peerIdFromPublicKey, publicIp,
  signingBytes, verifyLease, verifySnapshot, leaseAddresses } from '../services/discovery/participant-directory.mjs';
import { contactHandler, exchangeContact, observeContactSource } from '../services/discovery/http-contact.mjs';

// Controlled protocol/Request/Response fixtures ONLY. No DNS lookup, public
// registration, Internet socket, Windows app or libp2p application test occurs.
const origin = 'https://konofix-rendezvous.invalid';
const otherOrigin = 'https://backup-rendezvous.invalid';
const epoch = 1800000000000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const keys = await Promise.all(Array.from({ length: 3 }, () => crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])));
const publicKeys = await Promise.all(keys.map(async k => hex(await crypto.subtle.exportKey('raw', k.publicKey))));
async function lease(index = 0, overrides = {}) {
  const key = publicKeys[index];
  const record = { schema: 1, origin, protocol: '/konofix/control/1.0.0', public_key: key,
    peer_id: peerIdFromPublicKey(key), ip: index === 0 ? '8.8.8.8' : '1.1.1.1',
    tcp_port: 45555, quic_port: 45555, issued_at: epoch, expires_at: epoch + 60000,
    sequence: 1, ...overrides };
  record.signature = hex(await crypto.subtle.sign('Ed25519', keys[index].privateKey, signingBytes(record)));
  return record;
}
const verify = record => verifyLease(bytes(record), { origin, now: epoch });
function setup(options = {}) {
  let clock = epoch;
  const directory = new ParticipantDirectory({ origin, now: () => clock, ...options });
  return { directory, advance: n => { clock += n; }, now: () => clock };
}
function transport(directory, observedIp) {
  const handler = contactHandler(directory);
  return (url, init) => {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store'); assert.ok(!init.headers.Authorization);
    return handler(new Request(url, init), { observedIp });
  };
}

test('Ed25519 identities encode canonical libp2p protobuf/identity multihash', () => {
  const id = peerIdFromPublicKey(publicKeys[0]);
  assert.match(id, /^12D3KooW/);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = [...id].reduce((n, c) => n * 58n + BigInt(alphabet.indexOf(c)), 0n);
  const decoded = []; while (value) { decoded.unshift(Number(value & 255n)); value >>= 8n; }
  for (const c of id) { if (c !== '1') break; decoded.unshift(0); }
  assert.deepEqual(decoded.slice(0, 6), [0, 36, 8, 1, 18, 32]);
  assert.equal(hex(decoded.slice(6)), publicKeys[0]);
});
test('public-address policy rejects private, special, DNS and disguised literals', () => {
  for (const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.1.2','172.31.255.255',
    '192.168.1.2','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
    '008.8.8.8','8.8.8.8.1','example.com','::1','::','fe80::1','fc00::1','ff02::1',
    '::ffff:8.8.8.8','2001:db8::1','2001::1','2002::1','3fff::1','3fff:fff:ffff::1','2001:4860::1%eth0']) {
    assert.throws(() => publicIp(ip), undefined, ip);
  }
  for (const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888','2606:4700:4700::1111','3fff:1000::1']) assert.equal(publicIp(ip).ip, ip);
});
test('valid signed lease yields exactly pinned TCP and QUIC contact hints', async () => {
  const a = await lease(); assert.throws(() => leaseAddresses(a), /unverified_lease/);
  const record = await verify(a);
  assert.ok(Object.isFrozen(record));
  assert.deepEqual(leaseAddresses(record), [`/ip4/8.8.8.8/tcp/45555/p2p/${a.peer_id}`, `/ip4/8.8.8.8/udp/45555/quic-v1/p2p/${a.peer_id}`]);
  const v6 = await verify(await lease(0, { ip: '2001:4860:4860::8888', tcp_port: 0 }));
  assert.equal(leaseAddresses(v6).length, 1); assert.match(leaseAddresses(v6)[0], /^\/ip6\//);
});
test('unsigned, damaged, reassigned and unknown-field leases fail closed', async () => {
  const a = await lease();
  for (const bad of [{ ...a, tcp_port: 45556 }, { ...a, signature: '00'.repeat(64) },
    { ...a, public_key: publicKeys[1] }, { ...a, peer_id: peerIdFromPublicKey(publicKeys[1]) },
    { ...a, nickname: 'not-directory-data' }, { ...a, signature: a.signature.toUpperCase() }]) await assert.rejects(verify(bad));
});
test('source and protocol are signed and cannot be substituted', async () => {
  for (const overrides of [{ origin: otherOrigin }, { protocol: '/other/protocol' }, { schema: 2 }]) await assert.rejects(verify(await lease(0, overrides)));
});
test('lifetime, sequence, port and JSON number types are strict', async () => {
  for (const overrides of [{ issued_at: epoch + LIMITS.skewMs + 1 }, { expires_at: epoch },
    { expires_at: epoch + LIMITS.ttlMs + 1 }, { issued_at: String(epoch) }, { sequence: 0 },
    { sequence: 1.5 }, { sequence: '1' }, { tcp_port: -1 }, { quic_port: 65536 },
    { tcp_port: 0, quic_port: 0 }, { tcp_port: '45555' }, { ip: '192.168.1.2' }]) await assert.rejects(verify(await lease(0, overrides)));
});
test('size, strict UTF-8, unknown shape and missing signature are rejected', async () => {
  for (const raw of [new Uint8Array([255]), new Uint8Array(LIMITS.leaseBytes + 1), bytes(null), bytes([]), bytes({})])
    await assert.rejects(verifyLease(raw, { origin, now: epoch }));
  const a = await lease(); delete a.signature; await assert.rejects(verify(a));
});
test('trusted source observation ignores forwarding headers', async () => {
  const { directory } = setup();
  const handler = contactHandler(directory);
  const response = await handler(new Request(`${origin}/v1/observe`, {
    headers: { 'X-Forwarded-For': '9.9.9.9', 'CF-Connecting-IP': '9.9.9.9' },
  }), { observedIp: '8.8.8.8' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { schema: 1, origin, ip: '8.8.8.8' });
});

test('fresh client learns trusted public source before registration', async () => {
  const { directory } = setup();
  const fetchImpl = transport(directory, '8.8.8.8');
  assert.equal(await observeContactSource(origin, { fetchImpl }), '8.8.8.8');
});

test('source observation rejects malformed and non-public replies', async () => {
  for (const payload of [
    { schema: 1, origin: otherOrigin, ip: '8.8.8.8' },
    { schema: 1, origin, ip: '192.168.1.2' },
    { schema: 1, origin, ip: '8.8.8.8', extra: true },
  ]) {
    await assert.rejects(observeContactSource(origin, {
      fetchImpl: async () => new Response(JSON.stringify(payload)),
    }));
  }
});

test('registration cannot publish another ingress IP', async () => {
  const { directory } = setup(); const a = await lease();
  await assert.rejects(directory.register(bytes(a), '1.1.1.1'), /source_ip_mismatch/);
  assert.equal((await verifySnapshot(directory.snapshot('1.1.1.1'), { origin, now: epoch })).length, 0);
});
test('two fresh protocol clients register and discover each other without saved contacts', async () => {
  const { directory, now } = setup(); const a = await lease(0), b = await lease(1);
  const fetchA = transport(directory, a.ip), fetchB = transport(directory, b.ip);
  assert.deepEqual(await exchangeContact(origin, { registration: bytes(a), fetchImpl: fetchA, now }), []);
  const seenByB = await exchangeContact(origin, { registration: bytes(b), fetchImpl: fetchB, now });
  const seenByA = await exchangeContact(origin, { registration: bytes(a), fetchImpl: fetchA, now });
  assert.deepEqual(seenByB.map(p => p.peer_id), [a.peer_id]); assert.deepEqual(seenByA.map(p => p.peer_id), [b.peer_id]);
  assert.ok(!('internet_pass' in seenByA[0]));
});
test('replay is idempotent without extending the signed expiry', async () => {
  const { directory, advance } = setup(); const a = await lease();
  await directory.register(bytes(a), a.ip); advance(5000);
  assert.equal((await directory.register(bytes(a), a.ip)).expires_at, a.expires_at);
  const newer = await lease(0, { sequence: 2, issued_at: epoch + 5000, expires_at: epoch + 65000 });
  await directory.register(bytes(newer), a.ip);
  await assert.rejects(directory.register(bytes(a), a.ip), /stale_sequence/);
});
test('all previous participants expiring leaves an honest empty directory; new clients repopulate it', async () => {
  const { directory, advance, now } = setup(); const a = await lease();
  await directory.register(bytes(a), a.ip); advance(60000);
  assert.equal((await verifySnapshot(directory.snapshot(a.ip), { origin, now: now() })).length, 0);
  await assert.rejects(directory.register(bytes(a), a.ip), /invalid_lifetime/);
  const next = await lease(1, { issued_at: now(), expires_at: now() + 60000 });
  await directory.register(bytes(next), next.ip);
  assert.equal((await verifySnapshot(directory.snapshot(a.ip), { origin, now: now() }))[0].peer_id, next.peer_id);
});
test('service restart has no retained participant claims and does not fabricate contacts', async () => {
  const first = setup(), restarted = setup(); const a = await lease();
  await first.directory.register(bytes(a), a.ip);
  assert.equal((await verifySnapshot(restarted.directory.snapshot(a.ip), { origin, now: epoch })).length, 0);
  await restarted.directory.register(bytes(a), a.ip);
  assert.equal((await verifySnapshot(restarted.directory.snapshot(a.ip), { origin, now: epoch })).length, 1);
});
test('alternate directory uses separately signed origin-bound registrations', async () => {
  const backup = setup({ origin: otherOrigin }); const a = await lease();
  await assert.rejects(backup.directory.register(bytes(a), a.ip), /wrong_scope/);
  const registered = await lease(0, { origin: otherOrigin });
  await backup.directory.register(bytes(registered), registered.ip);
  const contacts = await exchangeContact(otherOrigin, { fetchImpl: transport(backup.directory, '1.1.1.1'), now: backup.now });
  assert.equal(contacts[0].peer_id, a.peer_id);
});
test('directory capacity is bounded and expiry releases space', async () => {
  const { directory, advance, now } = setup({ capacity: 1 }); const a = await lease(), b = await lease(1);
  await directory.register(bytes(a), a.ip);
  await assert.rejects(directory.register(bytes(b), b.ip), /directory_capacity/);
  advance(60000); const newB = await lease(1, { issued_at: now(), expires_at: now() + 60000 });
  await directory.register(bytes(newB), newB.ip);
});
test('source rate limits bound malformed requests as well as accepted traffic', async () => {
  const { directory, advance } = setup();
  for (let n = 0; n < LIMITS.requestsPerMinute; n++) await assert.rejects(directory.register(bytes({}), '8.8.8.8'));
  assert.throws(() => directory.snapshot('8.8.8.8'), /rate_limited/);
  advance(60000); assert.ok(directory.snapshot('8.8.8.8').length);
});
test('snapshot tampering, duplicates, over-cap and malformed shape are rejected', async () => {
  const a = await lease(); const good = { schema: 1, origin, contacts: [a] };
  for (const bad of [{ ...good, contacts: [{ ...a, tcp_port: 42 }] }, { ...good, contacts: [a, a] },
    { ...good, contacts: Array(LIMITS.contacts + 1).fill(a) }, { ...good, token: 'forbidden' }, { ...good, origin: otherOrigin }])
    await assert.rejects(verifySnapshot(bytes(bad), { origin, now: epoch }));
});
test('owned byte snapshot cannot be mutated while signature verification awaits', async () => {
  const a = await lease(); const input = bytes(a);
  const pending = verifyLease(input, { origin, now: epoch }); input.fill(0);
  assert.equal((await pending).peer_id, a.peer_id);
});
test('expiry is rechecked after crypto before a registration is committed', async () => {
  const clock = setup(); const a = await lease();
  const subtle = { importKey: (...args) => crypto.subtle.importKey(...args), verify: async (...args) => {
    const ok = await crypto.subtle.verify(...args); clock.advance(60000); return ok;
  } };
  const directory = new ParticipantDirectory({ origin, now: clock.now, subtle });
  await assert.rejects(directory.register(bytes(a), a.ip), /invalid_lifetime/);
  assert.equal((await verifySnapshot(directory.snapshot(a.ip), { origin, now: clock.now() })).length, 0);
});
test('cancelled verification cannot commit a late registration', async () => {
  const controller = new AbortController(); const a = await lease();
  const subtle = { importKey: (...args) => crypto.subtle.importKey(...args), verify: async (...args) => {
    const ok = await crypto.subtle.verify(...args); controller.abort(); return ok;
  } };
  const { directory } = setup({ subtle });
  await assert.rejects(directory.register(bytes(a), a.ip, { signal: controller.signal }), /aborted/);
  assert.equal((await verifySnapshot(directory.snapshot(a.ip), { origin, now: epoch })).length, 0);
});
test('HTTP ingress ignores spoofed forwarding headers', async () => {
  const { directory } = setup(); const a = await lease();
  const response = await contactHandler(directory)(new Request(`${origin}/v1/contact`, { method: 'POST', body: bytes(a),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': a.ip, 'CF-Connecting-IP': a.ip } }), { observedIp: '1.1.1.1' });
  assert.equal(response.status, 400);
});
test('HTTP adapter bounds actual body bytes and rejects wrong routes or MIME', async () => {
  const { directory } = setup(); const handle = contactHandler(directory);
  const response = await handle(new Request(`${origin}/v1/contact`, { method: 'POST', body: 'x'.repeat(LIMITS.leaseBytes + 1),
    headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }), { observedIp: '8.8.8.8' });
  assert.equal(response.status, 400);
  assert.equal((await handle(new Request(`${origin}/v1/contact`, { method: 'POST', body: '{}' }), { observedIp: '8.8.8.8' })).status, 415);
  assert.equal((await handle(new Request(`${origin}/chat`), { observedIp: '8.8.8.8' })).status, 404);
});
test('client distinguishes absent service from an authenticated empty snapshot', async () => {
  await assert.rejects(exchangeContact(origin, { fetchImpl: async () => { throw Error('offline'); } }), /offline/);
  await assert.rejects(exchangeContact(origin, { fetchImpl: async () => new Response('unavailable', { status: 503 }) }), /discovery_http_503/);
  assert.deepEqual(await exchangeContact(origin, { now: () => epoch, fetchImpl: async () => new Response(bytes({ schema: 1, origin, contacts: [] })) }), []);
});
test('client whole-request deadline covers fetch adapters ignoring abort', async () => {
  let signal;
  await assert.rejects(exchangeContact(origin, { timeoutMs: 15, fetchImpl: (_url, init) => {
    signal = init.signal; return new Promise(() => {});
  } }), /deadline/);
  assert.ok(signal.aborted);
});
test('client whole-request deadline covers stalled streams and cancels the reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(exchangeContact(origin, { timeoutMs: 15, fetchImpl: async () => new Response(body) }), /deadline|aborted/);
  assert.ok(cancelled);
});
test('client bounds actual response bytes despite false content length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(LIMITS.snapshotBytes + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(exchangeContact(origin, { fetchImpl: async () => new Response(body, { headers: { 'content-length': '1' } }) }), /size_limit/);
  assert.ok(cancelled);
});
test('pre-cancelled client request performs no fetch and insecure origins are rejected', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(exchangeContact(origin, { signal: controller.signal, fetchImpl: async () => { calls++; } }), /aborted/);
  for (const bad of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/'])
    await assert.rejects(exchangeContact(bad));
  assert.equal(calls, 0);
});
test('concurrent verification is bounded and releases capacity after completion', async () => {
  const a = await lease(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const subtle = { importKey: (...args) => crypto.subtle.importKey(...args), verify: async (...args) => {
    await gate; return crypto.subtle.verify(...args);
  } };
  const { directory } = setup({ subtle });
  const pending = Array.from({ length: LIMITS.inFlight }, () => directory.register(bytes(a), a.ip));
  await assert.rejects(directory.register(bytes(a), a.ip), /busy/);
  release(); await Promise.all(pending);
  assert.equal((await directory.register(bytes(a), a.ip)).peer_id, a.peer_id);
});
test('bounded contact selection rotates instead of permanently hiding later participants', async () => {
  const { directory, advance } = setup(); const expected = [];
  for (let i = 0; i < 3; i++) { const p = await lease(i); expected.push(p.peer_id); await directory.register(bytes(p), p.ip); }
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const selected = JSON.parse(new TextDecoder().decode(directory.snapshot('8.8.8.8', { limit: 1 })));
    assert.equal(selected.contacts.length, 1); seen.add(selected.contacts[0].peer_id); advance(5000);
  }
  assert.deepEqual([...seen].sort(), expected.sort());
});
