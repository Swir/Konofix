const TEST_MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

function abortError(): DOMException {
  return new DOMException('Audio test cancelled.', 'AbortError');
}

export async function testSpeakers(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  const context = new AudioContext();
  try {
    await context.resume();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.72);
    gain.connect(context.destination);

    const first = context.createOscillator();
    const second = context.createOscillator();
    first.type = 'sine';
    second.type = 'triangle';
    first.frequency.setValueAtTime(523.25, context.currentTime);
    second.frequency.setValueAtTime(783.99, context.currentTime + 0.18);
    first.connect(gain);
    second.connect(gain);
    first.start();
    second.start(context.currentTime + 0.18);
    first.stop(context.currentTime + 0.72);
    second.stop(context.currentTime + 0.72);

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 780);
      signal?.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  } finally {
    await context.close();
  }
}

export async function testMicrophone(
  onLevel: (level: number) => void,
  signal?: AbortSignal,
  durationMs = 4_000,
): Promise<number> {
  if (signal?.aborted) throw abortError();
  const stream = await navigator.mediaDevices.getUserMedia(TEST_MICROPHONE_CONSTRAINTS);
  let context: AudioContext | undefined;
  let frame = 0;
  let peak = 0;
  try {
    context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const read = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      peak = Math.max(peak, level);
      onLevel(level);
      frame = window.requestAnimationFrame(read);
    };
    read();

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, durationMs);
      signal?.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
    return peak;
  } finally {
    if (frame) window.cancelAnimationFrame(frame);
    stream.getTracks().forEach(track => track.stop());
    if (context) await context.close();
    onLevel(0);
  }
}
