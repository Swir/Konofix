export type CallToneMode = 'outgoing' | 'incoming';

type AudioContextFactory = () => AudioContext;

/**
 * Generates short local call-progress tones. No audio asset, network request or
 * server is involved. Keeping one warmed AudioContext also makes an incoming
 * ringtone reliable after the user has interacted with the desktop app.
 */
export class CallTonePlayer {
  private readonly createContext: AudioContextFactory;
  private context?: AudioContext;
  private mode?: CallToneMode;
  private readonly timers = new Set<number>();
  private readonly oscillators = new Set<OscillatorNode>();
  private remoteSource?: MediaStreamAudioSourceNode;
  private remoteRevision = 0;

  constructor(createContext: AudioContextFactory = () => new AudioContext()) {
    this.createContext = createContext;
  }

  async unlock(): Promise<void> {
    if (!this.context) this.context = this.createContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  start(mode: CallToneMode): void {
    if (this.mode === mode) return;
    this.stop();
    this.mode = mode;
    void this.unlock().then(() => {
      if (this.mode !== mode) return;
      if (mode === 'incoming') this.incomingCadence();
      else this.outgoingCadence();
    }).catch(() => {
      if (this.mode === mode) this.mode = undefined;
    });
  }

  stop(): void {
    this.mode = undefined;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const oscillator of this.oscillators) {
      try { oscillator.stop(); } catch {}
    }
    this.oscillators.clear();
  }

  activeMode(): CallToneMode | undefined { return this.mode; }

  async playRemoteAudio(stream: MediaStream): Promise<boolean> {
    const revision = ++this.remoteRevision;
    await this.unlock();
    if (revision !== this.remoteRevision) return false;
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('Audio output is unavailable.');
    this.remoteSource?.disconnect();
    const source = context.createMediaStreamSource(stream);
    source.connect(context.destination);
    this.remoteSource = source;
    return true;
  }

  stopRemoteAudio(): void {
    this.remoteRevision += 1;
    this.remoteSource?.disconnect();
    this.remoteSource = undefined;
  }

  private later(callback: () => void, delay: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private incomingCadence(): void {
    if (this.mode !== 'incoming') return;
    const melody: Array<[number[], number, number]> = [
      [[523.25, 1_046.5], 125, 0],
      [[659.25, 1_318.5], 125, 145],
      [[783.99, 1_567.98], 160, 290],
      [[1_046.5], 210, 465],
      [[783.99], 115, 735],
      [[1_174.66], 230, 870],
    ];
    const [first, ...rest] = melody;
    this.pulse(first[0], first[1], 0.035, 'triangle');
    for (const [frequencies, duration, delay] of rest) {
      this.later(() => {
        if (this.mode === 'incoming') this.pulse(frequencies, duration, 0.035, 'triangle');
      }, delay);
    }
    this.later(() => this.incomingCadence(), 3_400);
  }

  private outgoingCadence(): void {
    if (this.mode !== 'outgoing') return;
    this.pulse([392, 587.33], 260, 0.03, 'sine');
    this.later(() => {
      if (this.mode === 'outgoing') this.pulse([440, 659.25], 300, 0.03, 'sine');
    }, 360);
    this.later(() => this.outgoingCadence(), 3_200);
  }

  private pulse(
    frequencies: number[],
    durationMs: number,
    volume: number,
    type: OscillatorType,
  ): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    const end = now + durationMs / 1_000;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.025);
    gain.gain.setValueAtTime(volume, Math.max(now + 0.03, end - 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(context.destination);
    for (const frequency of frequencies) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.connect(gain);
      oscillator.addEventListener('ended', () => this.oscillators.delete(oscillator), { once: true });
      this.oscillators.add(oscillator);
      oscillator.start(now);
      oscillator.stop(end + 0.02);
    }
  }
}
