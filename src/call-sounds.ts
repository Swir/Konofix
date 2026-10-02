/** Local-only call feedback. Never connects to a microphone or an RTP sender. */
export type CallTone = 'outgoing' | 'incoming';
export type CallSoundState = { id: string; phase: string; deafened: boolean };
export type CallSoundPreferences = { incoming: boolean; outgoing: boolean; volume: number; quiet: boolean };
export type CallSoundStatus = 'idle' | 'playing' | 'blocked' | 'unavailable';

export const DEFAULT_CALL_SOUND_PREFERENCES: CallSoundPreferences = {
  incoming: true, outgoing: true, volume: 0.45, quiet: false,
};

export function boundedCallVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.45;
}

/** Original, bounded PCM: double ringback beep / soft four-note incoming chime. */
export function synthesizeCallTone(kind: CallTone, sampleRate: number): Float32Array<ArrayBuffer> {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('Unsupported call-tone sample rate.');
  }
  const samples = new Float32Array(Math.ceil(sampleRate * 3.6));
  const notes = kind === 'outgoing'
    ? [[0, 0.65, 440], [0.95, 0.65, 440]]
    : [[0, 0.2, 659.25], [0.24, 0.2, 783.99], [0.48, 0.28, 987.77], [0.82, 0.32, 783.99]];
  for (const [start, duration, frequency] of notes) {
    const count = Math.floor(duration * sampleRate);
    const offset = Math.floor(start * sampleRate);
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      const envelope = Math.max(0, Math.min(1, t / 0.012, (duration - t) / 0.035));
      const second = kind === 'outgoing' ? 480 : frequency * 2;
      samples[offset + i] = 0.12 * envelope * (
        Math.sin(2 * Math.PI * frequency * t) + 0.35 * Math.sin(2 * Math.PI * second * t)
      );
    }
  }
  return samples;
}

export class CallSoundPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private sourceKey = '';
  private call: CallSoundState | null = null;
  private previewTone: CallTone | null = null;
  private preferences = { ...DEFAULT_CALL_SOUND_PREFERENCES };
  private readonly buffers = new Map<CallTone, AudioBuffer>();
  private disposed = false;
  private status: CallSoundStatus = 'idle';

  constructor(
    private readonly factory: () => AudioContext = () => new AudioContext(),
    private readonly onStatus: (status: CallSoundStatus) => void = () => {},
  ) {}

  /** Called from a trusted pointer/key gesture, without capturing microphone audio. */
  unlock(): void {
    if (this.disposed || this.preferences.quiet || this.preferences.volume === 0) return;
    try {
      if (!this.context || this.context.state === 'closed') {
        this.stopSource();
        this.buffers.clear();
        this.context = this.factory();
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
        this.context.onstatechange = () => this.reconcile();
      }
      const context = this.context;
      if (context.state !== 'running') {
        // Do not await this in a call/accept handler: autoplay may keep it pending.
        void context.resume().then(() => {
          if (!this.disposed && this.context === context) this.reconcile();
        }).catch(() => {
          if (!this.disposed && this.context === context) this.setStatus('blocked');
        });
      }
      this.reconcile();
    } catch {
      this.stopSource();
      this.setStatus('unavailable');
    }
  }

  configure(preferences: CallSoundPreferences): void {
    this.preferences = { ...preferences, volume: boundedCallVolume(preferences.volume) };
    this.reconcile();
  }

  setCall(call: CallSoundState | null): void {
    // The session store mutates sessions in place; keep a snapshot, not its reference.
    this.call = call ? { id: call.id, phase: call.phase, deafened: call.deafened } : null;
    this.previewTone = null;
    this.reconcile();
  }

  preview(kind: CallTone): boolean {
    if (this.disposed || (this.call && !['ended', 'error'].includes(this.call.phase))) return false;
    if (!this.allowed(kind)) return false;
    this.stopSource();
    this.previewTone = kind;
    this.unlock();
    return true;
  }

  stopPreview(): void {
    if (!this.previewTone) return;
    this.previewTone = null;
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.call = null;
    this.previewTone = null;
    this.stopSource();
    this.buffers.clear();
    const context = this.context;
    this.context = null;
    this.gain?.disconnect();
    this.gain = null;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => {});
    }
    this.setStatus('idle');
  }

  private allowed(kind: CallTone): boolean {
    return !this.preferences.quiet && this.preferences.volume > 0 && this.preferences[kind];
  }

  private reconcile(): void {
    if (this.disposed) return;
    const kind = this.previewTone ?? (this.call?.phase === 'calling'
      ? 'outgoing' : this.call?.phase === 'ringing' ? 'incoming' : null);
    if (!kind || !this.allowed(kind) || this.call?.deafened) {
      this.previewTone = null;
      this.stopSource();
      this.setStatus('idle');
      return;
    }
    const context = this.context;
    if (!context || context.state !== 'running' || !this.gain) {
      this.setStatus('blocked');
      return;
    }
    try {
      this.gain.gain.setValueAtTime(this.preferences.volume, context.currentTime);
      const key = this.previewTone ? `preview:${kind}` : `${this.call!.id}:${kind}`;
      if (this.source && this.sourceKey === key) {
        this.setStatus('playing');
        return;
      }
      this.stopSource();
      let buffer = this.buffers.get(kind);
      if (!buffer) {
        const pcm = synthesizeCallTone(kind, context.sampleRate);
        buffer = context.createBuffer(1, pcm.length, context.sampleRate);
        buffer.copyToChannel(pcm, 0);
        this.buffers.set(kind, buffer);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = !this.previewTone;
      source.connect(this.gain);
      source.onended = () => {
        if (this.source !== source) return;
        this.previewTone = null;
        this.stopSource();
        this.setStatus('idle');
      };
      this.source = source;
      this.sourceKey = key;
      source.start();
      if (this.previewTone) source.stop(context.currentTime + 1.8);
      this.setStatus('playing');
    } catch {
      this.previewTone = null;
      this.stopSource();
      this.setStatus('unavailable');
    }
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null;
    this.sourceKey = '';
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* It may have already ended. */ }
    source.disconnect();
  }

  private setStatus(status: CallSoundStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
