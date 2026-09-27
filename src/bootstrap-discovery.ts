const DEFAULT_REMOTE_BOOTSTRAP_URL =
  'https://raw.githubusercontent.com/Swir/Konofix/main/src-tauri/bootstrap-pool.json';
const MAX_REMOTE_BOOTSTRAPS = 16;
const DEFAULT_TIMEOUT_MS = 1800;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'>>;

export function normalizeBootstrapList(values: unknown, max = MAX_REMOTE_BOOTSTRAPS): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    // Full multiaddr/Peer-ID validation stays in the Rust backend. This cheap
    // guard keeps obviously unrelated remote-manifest data out of start_network.
    if (!value.startsWith('/') || !value.includes('/p2p/')) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function parseBootstrapPoolManifest(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const manifest = payload as { schema?: unknown; seeds?: unknown };
  if (manifest.schema !== 1) return [];
  return normalizeBootstrapList(manifest.seeds);
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

export async function loadRemoteBootstraps(
  fetchImpl: FetchLike = fetch,
  url = DEFAULT_REMOTE_BOOTSTRAP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    return parseBootstrapPoolManifest(await response.json());
  } catch {
    // Remote bootstrap metadata is an availability aid, not a hard dependency.
    // Build-owned seeds, saved custom seeds, remembered peers and LAN mDNS still
    // work when GitHub/raw HTTPS is unavailable.
    return [];
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export { DEFAULT_REMOTE_BOOTSTRAP_URL, DEFAULT_TIMEOUT_MS };
