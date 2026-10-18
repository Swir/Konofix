/**
 * Direct encrypted WebRTC routes. The former anonymous Open Relay hostname was
 * retired and now resolves to documentation/discard addresses, so retaining it
 * only delayed ICE while pretending that a TURN fallback existed. Do not add a
 * shared anonymous TURN service here. Optional per-session TURN below requires
 * expiring credentials and the settings UI checks relay allocation first.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 1,
  iceTransportPolicy: 'all',
};

/** Credentials stay in memory; changing them only affects new connections. */
export type TurnSettings = { urls: string[]; username: string; credential: string; expiresAt: number; relayOnly: boolean };
let turn: TurnSettings | undefined;
export function validateTurn(value: TurnSettings, now = Date.now()): TurnSettings {
  if (!Array.isArray(value.urls) || value.urls.length < 1 || value.urls.length > 4
    || value.urls.some(url => typeof url !== 'string' || url.length > 512
      || !/^turns?:[a-z0-9.-]+(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url))) {
    throw new Error('Use turn:host:port or turns:host:port?transport=tcp (maximum 4).');
  }
  if (!value.username.trim() || value.username.length > 256 || !value.credential || value.credential.length > 2048
    || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 24 * 3600_000) {
    throw new Error('TURN requires credentials valid for no more than 24 hours.');
  }
  return { ...value, urls: [...value.urls], relayOnly: value.relayOnly === true };
}
export function configureTurn(value?: TurnSettings): void { turn = value ? validateTurn(value) : undefined; }
export function turnConfigured(): boolean { return Boolean(turn && turn.expiresAt > Date.now()); }
export function rtcConfiguration(): RTCConfiguration {
  if (turn?.relayOnly && !turnConfigured()) throw new Error('TURN credentials expired. Renew them or explicitly disable relay-only mode.');
  if (!turnConfigured()) return structuredClone(RTC_CONFIG);
  return { ...RTC_CONFIG, iceTransportPolicy: turn!.relayOnly ? 'relay' : 'all', iceServers: [
    ...RTC_CONFIG.iceServers!, { urls: [...turn!.urls], username: turn!.username, credential: turn!.credential },
  ] };
}
/** Relay allocation is not proof of an end-to-end media route. */
export async function probeRelay(settings: TurnSettings, signal?: AbortSignal): Promise<boolean> {
  const valid = validateTurn(settings);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: valid.urls, username: valid.username, credential: valid.credential }], iceTransportPolicy: 'relay' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (ok: boolean) => void = () => {};
  const abort = () => finish(false);
  try {
    const result = new Promise<boolean>(resolve => {
      finish = resolve;
      timer = setTimeout(() => resolve(false), 12_000);
      signal?.addEventListener('abort', abort, { once: true });
      pc.onicecandidate = event => { if (event.candidate?.type === 'relay') resolve(true); };
    });
    if (signal?.aborted) return false;
    pc.createDataChannel('relay-check');
    await pc.setLocalDescription(await pc.createOffer());
    return await result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); pc.close(); }
}
