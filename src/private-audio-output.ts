type PlaybackListener = (peerId: string, blocked: boolean) => void;

type OutputOptions = {
  createAudio?: () => HTMLAudioElement;
  appendAudio?: (audio: HTMLAudioElement) => void;
  onPlaybackState?: PlaybackListener;
};

type ActiveOutput = {
  peerId: string;
  stream: MediaStream;
  audio: HTMLAudioElement;
  blocked: boolean;
  playing: boolean;
};

/** A native media sink for the single active private call, independent of ringtone output. */
export class PrivateAudioOutput {
  private current?: ActiveOutput;
  private readonly createAudio: () => HTMLAudioElement;
  private readonly appendAudio: (audio: HTMLAudioElement) => void;
  private readonly onPlaybackState?: PlaybackListener;

  constructor(options: OutputOptions = {}) {
    this.createAudio = options.createAudio ?? (() => document.createElement('audio'));
    this.appendAudio = options.appendAudio ?? (audio => { document.body.appendChild(audio); });
    this.onPlaybackState = options.onPlaybackState;
  }

  attach(peerId: string, stream: MediaStream | null): void {
    if (!stream) {
      this.stop(peerId);
      return;
    }
    if (this.current?.peerId === peerId && this.current.stream === stream) return;
    this.stop();
    const audio = this.createAudio();
    audio.id = 'konofixRemoteAudio';
    audio.dataset.peerId = peerId;
    audio.autoplay = true;
    audio.volume = 1;
    audio.muted = false;
    audio.hidden = true;
    audio.setAttribute('playsinline', '');
    audio.srcObject = stream;
    const output: ActiveOutput = { peerId, stream, audio, blocked: false, playing: false };
    this.current = output;
    this.appendAudio(audio);
    void this.play(output);
  }

  isBlocked(peerId: string): boolean {
    return this.current?.peerId === peerId && this.current.blocked;
  }

  retry(): void {
    const output = this.current;
    if (output?.blocked && !output.playing) void this.play(output);
  }

  stop(peerId?: string): void {
    const output = this.current;
    if (!output || (peerId !== undefined && output.peerId !== peerId)) return;
    // Invalidate pending play() promises before detaching their media element.
    this.current = undefined;
    output.audio.pause();
    output.audio.srcObject = null;
    output.audio.remove();
  }

  private async play(output: ActiveOutput): Promise<void> {
    output.playing = true;
    let blocked = false;
    try {
      await output.audio.play();
    } catch {
      blocked = true;
    }
    output.playing = false;
    if (this.current !== output) return;
    output.blocked = blocked;
    this.onPlaybackState?.(output.peerId, blocked);
  }
}
