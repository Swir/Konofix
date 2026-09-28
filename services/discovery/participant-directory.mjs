// Contact-lease protocol. Startup lookup is wired; registration/deployment are not.
// Only signed, short-lived contact hints live here. No chat/file/audio payloads.
const DOMAIN = 'konofix/participant-contact/1';
const PROTOCOL = '/konofix/control/1.0.0';
export const LIMITS = Object.freeze({ leaseBytes: 2048, observationBytes: 1024, snapshotBytes: 64 * 1024,
  ttlMs: 120000, skewMs: 10000, contacts: 16, entries: 512,
  sourceEntries: 128, requestsPerMinute: 120, sourceBuckets: 2048, inFlight: 16 });
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();
const verifiedRecords = new WeakSet();
const fields = ['schema', 'origin', 'protocol', 'public_key', 'peer_id', 'ip',
  'tcp_port', 'quic_port', 'issued_at', 'expires_at', 'sequence', 'signature'];
const fail = code => { throw new Error(code); };
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
export const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
function unhex(text, bytes) {
  if (typeof text !== 'string' || text.length !== bytes * 2 || !/^[0-9a-f]+$/.test(text)) fail('invalid_hex');
  return Uint8Array.from(text.match(/../g), s => Number.parseInt(s, 16));
}
export function canonicalOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) fail('invalid_origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail('invalid_origin');
  return value;
}
export function peerIdFromPublicKey(rawHex) {
  // libp2p Ed25519 public-key protobuf (36 bytes), identity multihash, base58btc.
  const bytes = Uint8Array.from([0, 36, 8, 1, 18, 32, ...unhex(rawHex, 32)]);
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
function inV4(n, base, prefix) {
  const scale = 2 ** (32 - prefix);
  return Math.floor(n / scale) === Math.floor(base / scale);
}
function v4Number(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || +p > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}
export function publicIp(value) {
  if (typeof value !== 'string' || value.length > 45) fail('invalid_ip');
  const n = v4Number(value);
  if (n !== null) {
    for (const [base, prefix] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10],
      ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24],
      ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15],
      ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3]]) {
      if (inV4(n, v4Number(base), prefix)) fail('non_public_ip');
    }
    return { family: 'ip4', ip: value };
  }
  // Conservative direct-IPv6 policy. DNS, zones, IPv4-mapped/transition and
  // special-purpose ranges are not advertised by this candidate.
  if (!/^[0-9a-f:]+$/.test(value)) fail('invalid_ip');
  let canonical;
  try { canonical = new URL(`https://[${value}]/`).hostname.slice(1, -1); }
  catch { fail('invalid_ip'); }
  if (canonical !== value) fail('noncanonical_ip');
  const [left, right] = value.split('::');
  let words;
  if (right !== undefined) {
    const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
    words = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  } else words = left.split(':');
  const number = words.reduce((a, w) => (a << 16n) + BigInt(`0x${w}`), 0n);
  if ((number >> 125n) !== 1n || (number >> 96n) === 0x20010db8n ||
      (number >> 105n) === (0x20010000000000000000000000000000n >> 105n) ||
      (number >> 112n) === 0x2002n || (number >> 108n) === 0x3fff0n) fail('non_public_ip');
  return { family: 'ip6', ip: value };
}
export function signingBytes(record) {
  // Fixed array order and domain separator; do not sign arbitrary JSON objects.
  return encoder.encode(JSON.stringify([DOMAIN, record.schema, record.origin, record.protocol,
    record.public_key, record.peer_id, record.ip, record.tcp_port, record.quic_port,
    record.issued_at, record.expires_at, record.sequence]));
}
function parseBytes(bytes, max) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > max) fail('size_limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function checkShape(record, origin, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== fields.length || fields.some(k => !Object.hasOwn(record, k))) fail('invalid_shape');
  if (record.schema !== 1 || record.protocol !== PROTOCOL || record.origin !== canonicalOrigin(origin)) fail('wrong_scope');
  if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || !integer(record.issued_at, 0, now + LIMITS.skewMs) ||
      !integer(record.expires_at, now + 1, Number.MAX_SAFE_INTEGER) ||
      record.expires_at <= record.issued_at || record.expires_at - record.issued_at > LIMITS.ttlMs ||
      !integer(record.sequence, 1, Number.MAX_SAFE_INTEGER)) fail('invalid_lifetime');
  if (!integer(record.tcp_port, 0, 65535) || !integer(record.quic_port, 0, 65535) ||
      (record.tcp_port === 0 && record.quic_port === 0)) fail('invalid_ports');
  publicIp(record.ip);
  if (record.peer_id !== peerIdFromPublicKey(record.public_key)) fail('wrong_peer_id');
  unhex(record.signature, 64);
}
export async function verifyLease(bytes, { origin, now = Date.now(), subtle = globalThis.crypto.subtle }) {
  // Parsing own bounded bytes prevents mutable-object races across crypto awaits.
  const record = parseBytes(bytes, LIMITS.leaseBytes);
  checkShape(record, origin, now);
  const key = await subtle.importKey('raw', unhex(record.public_key, 32), { name: 'Ed25519' }, false, ['verify']);
  if (!await subtle.verify('Ed25519', key, unhex(record.signature, 64), signingBytes(record))) fail('bad_signature');
  Object.freeze(record); verifiedRecords.add(record);
  return record;
}
export function leaseAddresses(record) {
  if (!verifiedRecords.has(record)) fail('unverified_lease');
  const { family, ip } = publicIp(record.ip);
  const prefix = `/${family}/${ip}`;
  return [record.tcp_port ? `${prefix}/tcp/${record.tcp_port}/p2p/${record.peer_id}` : null,
    record.quic_port ? `${prefix}/udp/${record.quic_port}/quic-v1/p2p/${record.peer_id}` : null].filter(Boolean);
}
export async function verifySnapshot(bytes, { origin, now = Date.now(), subtle = globalThis.crypto.subtle }) {
  const snapshot = parseBytes(bytes, LIMITS.snapshotBytes);
  if (!snapshot || snapshot.schema !== 1 || snapshot.origin !== origin || !Array.isArray(snapshot.contacts) ||
      snapshot.contacts.length > LIMITS.contacts || Object.keys(snapshot).length !== 3) fail('invalid_snapshot');
  const result = [], seen = new Set();
  for (const raw of snapshot.contacts) {
    const record = await verifyLease(encoder.encode(JSON.stringify(raw)), { origin, now, subtle });
    if (seen.has(record.peer_id)) fail('duplicate_peer');
    seen.add(record.peer_id); result.push(record);
  }
  return result; // Authenticated contact HINTS, never Internet/application PASS.
}
export class ParticipantDirectory {
  #records = new Map();
  #sources = new Map();
  #inFlight = 0;
  constructor({ origin, now = Date.now, subtle = globalThis.crypto.subtle, capacity = LIMITS.entries } = {}) {
    this.origin = canonicalOrigin(origin);
    if (!integer(capacity, 1, LIMITS.entries)) fail('invalid_capacity');
    this.capacity = capacity; this.now = now; this.subtle = subtle;
  }
  #prune(now) {
    for (const [id, item] of this.#records) if (item.record.expires_at <= now) this.#records.delete(id);
    for (const [ip, item] of this.#sources) if (item.until <= now) this.#sources.delete(ip);
  }
  #admit(sourceIp, now) {
    publicIp(sourceIp);
    this.#prune(now);
    let bucket = this.#sources.get(sourceIp);
    if (!bucket) {
      if (this.#sources.size >= LIMITS.sourceBuckets) fail('source_capacity');
      bucket = { until: now + 60000, count: 0 }; this.#sources.set(sourceIp, bucket);
    }
    if (++bucket.count > LIMITS.requestsPerMinute) fail('rate_limited');
  }
  async register(bytes, sourceIp, { signal } = {}) {
    // sourceIp MUST come from the authenticated hosting ingress/socket, not a
    // client-controlled header, JSON field, or query string.
    if (signal?.aborted) fail('aborted');
    this.#admit(sourceIp, this.now());
    if (this.#inFlight >= LIMITS.inFlight) fail('busy');
    this.#inFlight++;
    try {
      const record = await verifyLease(bytes, { origin: this.origin, now: this.now(), subtle: this.subtle });
      if (signal?.aborted) fail('aborted');
      if (record.ip !== sourceIp) fail('source_ip_mismatch');
      const now = this.now();
      checkShape(record, this.origin, now); // Recheck expiry after asynchronous crypto.
      this.#prune(now);
      const old = this.#records.get(record.peer_id)?.record;
      if (old && record.sequence <= old.sequence) {
        if (record.signature === old.signature) return old; // Idempotent, expiry NOT extended.
        fail('stale_sequence');
      }
      if (!old && this.#records.size >= this.capacity) fail('directory_capacity');
      const sameSource = [...this.#records.values()].filter(item => item.sourceIp === sourceIp).length;
      if (this.#records.get(record.peer_id)?.sourceIp !== sourceIp && sameSource >= LIMITS.sourceEntries) fail('source_capacity');
      this.#records.set(record.peer_id, { record, sourceIp });
      return record;
    } finally { this.#inFlight--; }
  }
  snapshot(sourceIp, { exclude = '', limit = LIMITS.contacts } = {}) {
    this.#admit(sourceIp, this.now());
    if (!integer(limit, 1, LIMITS.contacts) || typeof exclude !== 'string' || exclude.length > 64) fail('invalid_query');
    // Bounded rotation prevents the first entries from permanently hiding all later peers.
    const all = [...this.#records.values()].map(item => item.record).filter(record => record.peer_id !== exclude);
    const start = all.length ? Math.floor(this.now() / 5000) % all.length : 0;
    const contacts = [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
    return encoder.encode(JSON.stringify({ schema: 1, origin: this.origin, contacts }));
  }
}
