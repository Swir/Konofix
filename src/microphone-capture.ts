import { t } from './i18n.ts';

const PREFERRED_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

const BASIC_CONSTRAINTS: MediaStreamConstraints = { audio: true, video: false };
const RELEASE_SETTLE_MS = 160;
const ACTIVE_HANDOFF_WAIT_MS = 600;
const TRANSIENT_RETRY_DELAYS_MS = [160, 360] as const;

export type MicrophoneCaptureScope = object;

type CaptureState = {
  activeStreams: Set<MediaStream>;
  releaseWaiters: Set<() => void>;
  lastReleaseAt: number;
  captureTail: Promise<void>;
};

const DEFAULT_CAPTURE_SCOPE: MicrophoneCaptureScope = {};
const scopeStates = new WeakMap<MicrophoneCaptureScope, CaptureState>();
const streamStates = new WeakMap<MediaStream, CaptureState>();

type CaptureOptions = {
  /** Separate application instance for deterministic multi-peer tests. Omit in the real app. */
  scope?: MicrophoneCaptureScope;
  /** Release a stale stream owned by the caller before retrying a transient device error. */
  releaseOwnedStreams?: () => void;
};

function newCaptureState(): CaptureState {
  return {
    activeStreams: new Set(),
    releaseWaiters: new Set(),
    lastReleaseAt: 0,
    captureTail: Promise.resolve(),
  };
}

function captureState(scope = DEFAULT_CAPTURE_SCOPE): CaptureState {
  const existing = scopeStates.get(scope);
  if (existing) return existing;
  const state = newCaptureState();
  scopeStates.set(scope, state);
  return state;
}

export function createMicrophoneCaptureScope(): MicrophoneCaptureScope {
  const scope = {};
  scopeStates.set(scope, newCaptureState());
  return scope;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : '';
}

function isTransientDeviceError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

function pruneEndedStreams(state: CaptureState): void {
  for (const stream of state.activeStreams) {
    const tracks = stream.getTracks();
    if (tracks.length === 0 || tracks.every(track => track.readyState === 'ended')) {
      state.activeStreams.delete(stream);
      streamStates.delete(stream);
    }
  }
}

function signalRelease(state: CaptureState): void {
  state.lastReleaseAt = Date.now();
  for (const resolve of [...state.releaseWaiters]) resolve();
  state.releaseWaiters.clear();
}

function unregisterWhenEnded(stream: MediaStream, state: CaptureState): void {
  const check = () => {
    if (stream.getTracks().every(track => track.readyState === 'ended') && state.activeStreams.delete(stream)) {
      streamStates.delete(stream);
      signalRelease(state);
    }
  };
  for (const track of stream.getTracks()) track.addEventListener?.('ended', check, { once: true });
}

async function waitForActiveHandoff(state: CaptureState): Promise<void> {
  pruneEndedStreams(state);
  if (state.activeStreams.size === 0) return;
  await new Promise<void>(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      state.releaseWaiters.delete(finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ACTIVE_HANDOFF_WAIT_MS);
    state.releaseWaiters.add(finish);
  });
  pruneEndedStreams(state);
  if (state.activeStreams.size > 0) throw new Error(t('audio.microphoneBusy'));
}

async function waitForReleaseBarrier(state: CaptureState): Promise<void> {
  const remaining = RELEASE_SETTLE_MS - (Date.now() - state.lastReleaseAt);
  if (remaining > 0) await delay(remaining);
}

async function serialized<T>(state: CaptureState, task: () => Promise<T>): Promise<T> {
  const previous = state.captureTail;
  let unlock!: () => void;
  state.captureTail = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  // Let the previous caller validate its media epoch and release a late stream
  // before the next queued browser request starts.
  await delay(0);
  try {
    return await task();
  } finally {
    unlock();
  }
}

function localizedCaptureError(error: unknown): Error | undefined {
  const name = errorName(error);
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new Error(t('audio.microphonePermission'));
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error(t('audio.microphoneMissing'));
  }
  if (isTransientDeviceError(error)) return new Error(t('audio.microphoneBusy'));
  return undefined;
}

function activeAudioStream(stream: MediaStream): boolean {
  const tracks = stream.getAudioTracks();
  return tracks.length > 0 && tracks.some(track => track.readyState !== 'ended');
}

/**
 * Acquire the single Windows microphone without racing another Konofix mode.
 * WebView2 may keep a just-stopped source busy briefly, so captures are
 * serialized and observe a short release barrier before retrying.
 */
export async function captureMicrophone(options: CaptureOptions = {}): Promise<MediaStream> {
  const state = captureState(options.scope);
  return serialized(state, async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('audio.microphoneMissing'));
    await waitForActiveHandoff(state);
    await waitForReleaseBarrier(state);

    let constraints = PREFERRED_CONSTRAINTS;
    let transientAttempt = 0;
    let usedBasicConstraints = false;
    while (true) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        const name = errorName(error);
        if (name === 'OverconstrainedError' && !usedBasicConstraints) {
          constraints = BASIC_CONSTRAINTS;
          usedBasicConstraints = true;
          continue;
        }
        if (isTransientDeviceError(error) && transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          options.releaseOwnedStreams?.();
          await delay(TRANSIENT_RETRY_DELAYS_MS[transientAttempt]);
          transientAttempt += 1;
          constraints = BASIC_CONSTRAINTS;
          usedBasicConstraints = true;
          continue;
        }
        throw localizedCaptureError(error) ?? error;
      }

      state.activeStreams.add(stream);
      streamStates.set(stream, state);
      unregisterWhenEnded(stream, state);
      if (!activeAudioStream(stream)) {
        releaseMicrophoneStream(stream);
        const inactive = new DOMException('Microphone returned no live audio track.', 'NotReadableError');
        if (transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          options.releaseOwnedStreams?.();
          await delay(TRANSIENT_RETRY_DELAYS_MS[transientAttempt]);
          transientAttempt += 1;
          constraints = BASIC_CONSTRAINTS;
          usedBasicConstraints = true;
          continue;
        }
        throw localizedCaptureError(inactive)!;
      }

      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      return stream;
    }
  });
}

/** Stop and unregister a local capture so the next mode observes the release barrier. */
export function releaseMicrophoneStream(stream?: MediaStream): void {
  if (!stream) return;
  const tracks = stream.getTracks();
  const state = streamStates.get(stream);
  const wasTracked = state?.activeStreams.delete(stream) ?? false;
  streamStates.delete(stream);
  const hadLiveTrack = tracks.some(track => track.readyState !== 'ended');
  for (const track of tracks) track.stop();
  if (state && (wasTracked || hadLiveTrack)) signalRelease(state);
}
