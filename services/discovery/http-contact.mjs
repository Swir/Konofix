import { LIMITS, ParticipantDirectory, canonicalOrigin, publicIp, verifyLease, verifySnapshot } from './participant-directory.mjs';

const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* best effort */ } };
async function readBounded(body, max, signal) {
  if (!body || signal.aborted) { cancel(body); throw new Error('aborted_or_missing_body'); }
  const reader = body.getReader(), chunks = [];
  let size = 0;
  const stop = () => { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw new Error('aborted');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > max) throw new Error('size_limit');
      chunks.push(part.value.slice());
    }
    const out = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
    return out;
  } finally {
    signal.removeEventListener('abort', stop); stop();
    try { reader.releaseLock(); } catch { /* pending read already cancelled */ }
  }
}
async function deadline(work, timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(new Error('aborted')); };
    if (parentSignal?.aborted) onAbort();
    else parentSignal?.addEventListener('abort', onAbort, { once: true });
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1800) : 1800;
    timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, duration);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]); }
  finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', onAbort); controller.abort(); }
}
function json(status, value) {
  return new Response(JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
// Hosting adapter must supply the trusted observed address. This function does
// NOT trust X-Forwarded-For, CF-Connecting-IP or any other client-supplied header.
// The hosting boundary and shared-state adapter still need deployment qualification.
export function contactHandler(directory, { allowedOrigins = [] } = {}) {
  if (!(directory instanceof ParticipantDirectory)) throw new TypeError('directory_required');
  const handle = async (request, { observedIp } = {}) => {
    try {
      const url = new URL(request.url);
      if (url.origin !== directory.origin) return json(421, { error: 'wrong_origin' });
      if (request.method === 'GET' && url.pathname === '/v1/observe') {
        if (url.search) return json(400, { error: 'invalid_query' });
        return json(200, { schema: 1, origin: directory.origin, ip: publicIp(observedIp).ip });
      }
      if (request.method === 'GET' && url.pathname === '/v1/contacts') {
        if ([...url.searchParams.keys()].some(k => k !== 'exclude') || url.searchParams.getAll('exclude').length > 1) return json(400, { error: 'invalid_query' });
        const bytes = directory.snapshot(observedIp, { exclude: url.searchParams.get('exclude') ?? '' });
        return new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/contact' || url.search) return json(404, { error: 'not_found' });
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'json_required' });
      const record = await deadline(async signal => {
        const bytes = await readBounded(request.body, LIMITS.leaseBytes, signal);
        if (signal.aborted) throw new Error('aborted');
        return directory.register(bytes, observedIp, { signal });
      }, 1800, request.signal);
      return json(200, { accepted: true, expires_at: record.expires_at });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      const throttled = ['rate_limited', 'source_capacity', 'directory_capacity', 'busy'].includes(code);
      const timedOut = ['deadline', 'aborted'].includes(code);
      // Do not reflect parser or crypto exception text into a public response.
      return json(throttled ? 429 : timedOut ? 408 : 400,
        { error: throttled ? 'capacity_or_rate_limit' : timedOut ? 'request_timeout' : 'invalid_contact' });
    }
  };
  return withContactCors(handle, directory.origin, allowedOrigins);
}

// CORS is a browser read boundary, NOT peer authentication. Native callers can
// omit/spoof Origin; signed leases, trusted source IP and rate limits still apply.
// The hosting adapter explicitly supplies the packaged WebView origin(s).
function withContactCors(handle, serviceOrigin, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 8) throw new TypeError('invalid_cors_origins');
  const allowed = new Set();
  for (const origin of allowedOrigins) {
    if (typeof origin !== 'string' || origin.length > 256 || origin === 'null') throw new TypeError('invalid_cors_origin');
    const url = new URL(origin);
    if (origin !== 'tauri://localhost' &&
        (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)) throw new TypeError('invalid_cors_origin');
    if (allowed.has(origin)) throw new TypeError('duplicate_cors_origin');
    allowed.add(origin);
  }
  return async (request, context) => {
    const origin = request.headers.get('origin');
    if (origin === null) return handle(request, context);
    if (!allowed.has(origin)) { cancel(request.body); return json(403, { error: 'origin_not_allowed' }); }
    let response;
    if (request.method === 'OPTIONS') {
      cancel(request.body);
      const url = new URL(request.url);
      const method = request.headers.get('access-control-request-method');
      const rawHeaders = request.headers.get('access-control-request-headers') ?? '';
      const requestedHeaders = rawHeaders.toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      const permitted = method === 'POST' && url.pathname === '/v1/contact' && !url.search ||
        method === 'GET' && ['/v1/contacts', '/v1/observe'].includes(url.pathname);
      if (url.origin !== serviceOrigin || !permitted || rawHeaders.length > 256 ||
          requestedHeaders.some(name => !['content-type', 'accept'].includes(name))) {
        cancel(request.body); response = json(403, { error: 'preflight_not_allowed' });
      } else {
        response = new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': method,
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Cache-Control': 'no-store',
        } });
      }
    } else response = await handle(request, context);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.append('Vary', request.method === 'OPTIONS'
      ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' : 'Origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export async function observeContactSource(origin, { fetchImpl = fetch, timeoutMs = 1800,
  signal: parentSignal } = {}) {
  canonicalOrigin(origin);
  return deadline(async signal => {
    const response = await fetchImpl(`${origin}/v1/observe`, {
      headers: { Accept: 'application/json' }, credentials: 'omit',
      redirect: 'error', cache: 'no-store', signal,
    });
    if (!response.ok) { cancel(response.body); throw new Error(`observation_http_${response.status}`); }
    const raw = await readBounded(response.body, LIMITS.observationBytes, signal);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new Error('invalid_observation'); }
    if (!value || Object.keys(value).length !== 3 || value.schema !== 1 ||
        value.origin !== origin || typeof value.ip !== 'string') throw new Error('invalid_observation');
    return publicIp(value.ip).ip;
  }, timeoutMs, parentSignal);
}

// Caller supplies an explicitly approved HTTPS origin. No provider, token,
// account, endpoint or default registry is embedded in the application here.
export async function exchangeContact(origin, { registration = null, fetchImpl = fetch,
  now = Date.now, timeoutMs = 1800, signal: parentSignal } = {}) {
  canonicalOrigin(origin);
  // Own immutable input before the first await; keep private key material native.
  const bytes = registration === null ? null : registration instanceof Uint8Array ? registration.slice() : null;
  if (registration !== null && (!bytes || bytes.length > LIMITS.leaseBytes)) throw new Error('invalid_registration');
  return deadline(async signal => {
    let ownId = '';
    if (bytes) {
      const own = await verifyLease(bytes, { origin, now: now() });
      if (signal.aborted) throw new Error('aborted');
      ownId = own.peer_id;
      const response = await fetchImpl(`${origin}/v1/contact`, { method: 'POST', body: bytes,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
      cancel(response.body);
      if (signal.aborted) throw new Error('aborted');
      if (!response.ok) throw new Error(`registration_http_${response.status}`);
    }
    if (signal.aborted) throw new Error('aborted');
    const response = await fetchImpl(`${origin}/v1/contacts${ownId ? `?exclude=${encodeURIComponent(ownId)}` : ''}`,
      { headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
    if (!response.ok) { cancel(response.body); throw new Error(`discovery_http_${response.status}`); }
    const snapshot = await readBounded(response.body, LIMITS.snapshotBytes, signal);
    const contacts = await verifySnapshot(snapshot, { origin, now: now() });
    if (signal.aborted) throw new Error('aborted');
    const completedAt = now();
    if (!Number.isSafeInteger(completedAt) || contacts.some(record => record.expires_at <= completedAt)) throw new Error('expired_during_verification');
    return contacts; // No connection, relay reservation or runtime success implied.
  }, timeoutMs, parentSignal);
}
