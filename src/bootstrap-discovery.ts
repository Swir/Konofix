import { exchangeContact } from '../services/discovery/http-contact.mjs';
import { canonicalOrigin, leaseAddresses, type VerifiedContact } from '../services/discovery/participant-directory.mjs';

const DEFAULT_REMOTE_BOOTSTRAP_URL =
  'https://raw.githubusercontent.com/Swir/Konofix/main/src-tauri/bootstrap-pool.json';
const MAX_REMOTE_BOOTSTRAPS = 16;
const MAX_CONTACT_ORIGINS = 2;
const MAX_POOL_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 1800;
const CONTACT_CACHE_KEY = 'konofix.discovery-contacts.v1';
const CONTACT_CACHE_TTL_MS = 15 * 60 * 1000;
let loadRevision = 0;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'headers' | 'body'>>;
type ContactStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RecoveryOptions = { store?: ContactStore | null; now?: () => number };

function browserStore(): ContactStore | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function normalizeBootstrapList(values: unknown, max = MAX_REMOTE_BOOTSTRAPS): string[] {
  if (!Array.isArray(values) || !Number.isInteger(max) || max <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values.slice(0, MAX_REMOTE_BOOTSTRAPS * 4)) {
    if (typeof raw !== 'string' || raw.length > 2048) continue;
    const value = raw.trim();
    // A bounded shape check only. Rust still parses the complete multiaddr and
    // Peer ID, and libp2p authenticates the peer. A contact is not reachability.
    if (!value.startsWith('/') || /\s/.test(value) || !/\/p2p\/[^/]+$/.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= Math.min(max, MAX_REMOTE_BOOTSTRAPS)) break;
  }
  return out;
}

function readManifest(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const manifest = payload as { schema?: unknown; seeds?: unknown };
  if (manifest.schema !== 1 || !Array.isArray(manifest.seeds) || manifest.seeds.length > MAX_REMOTE_BOOTSTRAPS) return null;
  const seeds = normalizeBootstrapList(manifest.seeds);
  // Malformed/duplicate entries invalidate the remote snapshot, not the saved
  // custom contacts or the running P2P network. Empty is a valid withdrawal.
  return seeds.length === manifest.seeds.length ? seeds : null;
}

type BootstrapMetadata = { seeds: string[]; contactOrigins: string[] };

function readMetadata(payload: unknown): BootstrapMetadata | null {
  const seeds = readManifest(payload);
  if (seeds === null) return null;
  const raw = (payload as { contact_origins?: unknown }).contact_origins;
  if (raw === undefined) return { seeds, contactOrigins: [] };
  if (!Array.isArray(raw) || raw.length > MAX_CONTACT_ORIGINS) return null;
  try {
    const contactOrigins = raw.map(origin => canonicalOrigin(origin));
    if (new Set(contactOrigins).size !== contactOrigins.length) return null;
    return { seeds, contactOrigins };
  } catch { return null; }
}

export function parseBootstrapPoolManifest(payload: unknown): string[] {
  return readManifest(payload) ?? [];
}

export function mergeBootstrapSources(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const value = raw.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function readCachedContacts(raw: string | null, url: string, now: number): string[] {
  try {
    if (!raw || raw.length > MAX_POOL_BYTES || !Number.isSafeInteger(now)) return [];
    const entry = JSON.parse(raw);
    if (!entry || entry.schema !== 1 || entry.source !== url ||
        !Number.isSafeInteger(entry.saved_at) || entry.saved_at < 0 || entry.saved_at > now ||
        entry.expires_at !== entry.saved_at + CONTACT_CACHE_TTL_MS || now >= entry.expires_at) return [];
    return readManifest(entry.pool) ?? [];
  } catch { return []; }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => {}); } catch { /* best effort */ }
}

async function readBoundedPool(response: Pick<Response, 'ok' | 'headers' | 'body'>, signal: AbortSignal): Promise<BootstrapMetadata | null> {
  const declared = response.headers.get('content-length');
  if (!response.ok || signal.aborted || !response.body ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_POOL_BYTES))) {
    cancelBody(response.body);
    return null;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let text = '';
  try {
    while (!signal.aborted) {
      const part = await reader.read();
      if (signal.aborted) return null;
      if (part.done) {
        text += decoder.decode();
        return readMetadata(JSON.parse(text));
      }
      received += part.value.byteLength;
      if (received > MAX_POOL_BYTES) return null;
      text += decoder.decode(part.value, { stream: true });
    }
    return null;
  } finally {
    // Cancellation must not itself hold up login if a WebView stream stalls.
    signal.removeEventListener('abort', cancelReader);
    cancelReader();
    try { reader.releaseLock(); } catch { /* pending read; abort also requested */ }
  }
}

export async function loadRemoteBootstraps(
  fetchImpl: FetchLike = fetch,
  url = DEFAULT_REMOTE_BOOTSTRAP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: RecoveryOptions = {},
): Promise<string[]> {
  const revision = ++loadRevision;
  const store = options.store === undefined ? browserStore() : options.store;
  const now = options.now ?? Date.now;
  let cached: string | null = null;
  try { cached = store?.getItem(CONTACT_CACHE_KEY) ?? null; } catch { /* storage can be denied */ }
  const controller = new AbortController();
  const delay = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = globalThis.setTimeout(() => {
      controller.abort();
      resolve(null);
    }, delay);
  });
  let liveSeeds: string[] | null = null;
  const discovered: VerifiedContact[][] = [];
  const currentContacts = (): string[] => {
    const at = now();
    const groups = Number.isSafeInteger(at) && at >= 0
      ? discovered.map(records => records.filter(record =>
        record.expires_at > at && record.issued_at <= at + 10000).flatMap(leaseAddresses))
      : [];
    // Alternate origins so one directory cannot consume the whole hint budget.
    const interleaved: string[] = [];
    const longest = Math.max(0, ...groups.map(group => group.length));
    for (let i = 0; i < longest; i++) {
      for (const group of groups) if (i < group.length) interleaved.push(group[i]);
    }
    return mergeBootstrapSources(liveSeeds ?? [], interleaved).slice(0, MAX_REMOTE_BOOTSTRAPS);
  };
  const request = (async () => {
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store', credentials: 'omit', redirect: 'error',
        signal: controller.signal, headers: { Accept: 'application/json' },
      });
      const metadata = await readBoundedPool(response, controller.signal);
      if (metadata === null || controller.signal.aborted) return null;
      liveSeeds = metadata.seeds;
      if (revision === loadRevision) {
        try {
          const savedAt = now();
          // The legacy cache contains only operator-managed seeds. Signed
          // 120-second participant leases must NEVER enter this 15-minute cache.
          if (liveSeeds.length === 0) store?.removeItem(CONTACT_CACHE_KEY);
          else if (Number.isSafeInteger(savedAt) && savedAt >= 0) store?.setItem(CONTACT_CACHE_KEY, JSON.stringify({
            schema: 1, source: url, saved_at: savedAt,
            expires_at: savedAt + CONTACT_CACHE_TTL_MS, pool: { schema: 1, seeds: liveSeeds },
          }));
        } catch { /* live contacts remain usable when browser storage is denied */ }
      }
      // Only an operator-reviewed origin list in the canonical HTTPS metadata
      // activates this read-only path. No provider or client credential is added.
      await Promise.all(metadata.contactOrigins.map(async (origin, index) => {
        discovered[index] = [];
        try {
          const records = await exchangeContact(origin, {
            fetchImpl, now, timeoutMs: delay, signal: controller.signal,
          });
          if (!controller.signal.aborted) discovered[index] = records;
        } catch { /* independent origins and static/manual routes remain usable */ }
      }));
      return currentContacts();
    } catch { return null; }
  })();
  try {
    // Abort alone is insufficient for an adapter/body that does not settle.
    // This race bounds the whole request including body reads, not just headers.
    await Promise.race([request, timeout]);
    // Keep already verified results when another source stalls; recheck leases
    // at the actual handoff boundary, not only when their HTTPS response arrived.
    return liveSeeds === null ? readCachedContacts(cached, url, now()) : currentContacts();
  } finally {
    globalThis.clearTimeout(timer);
    controller.abort();
  }
}

export { DEFAULT_REMOTE_BOOTSTRAP_URL, DEFAULT_TIMEOUT_MS, CONTACT_CACHE_KEY, CONTACT_CACHE_TTL_MS, MAX_POOL_BYTES };
