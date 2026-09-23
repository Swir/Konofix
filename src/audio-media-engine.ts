export type AudioMediaErrorCode =
  | 'unsupported'
  | 'permission_denied'
  | 'device_missing'
  | 'device_busy'
  | 'constraint_failed'
  | 'capture_failed'
  | 'invalid_signal';

export class AudioMediaError extends Error {
  readonly code: AudioMediaErrorCode;

  constructor(code: AudioMediaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioMediaError';
    this.code = code;
  }
}

export type AudioInputDevice = {
  deviceId: string;
  groupId: string;
  label: string;
  isDefault: boolean;
};

export type AudioCaptureOptions = {
  deviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

type MediaDevicesLike = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;

type SenderLike = {
  track: MediaStreamTrack | null;
  replaceTrack(track: MediaStreamTrack | null): Promise<void>;
};

type PeerConnectionLike = {
  connectionState: RTCPeerConnectionState;
  localDescription: RTCSessionDescription | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => unknown) | null;
  ontrack: ((event: RTCTrackEvent) => unknown) | null;
  onconnectionstatechange: (() => unknown) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): SenderLike;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  close(): void;
  restartIce?: () => void;
};

export type WebRtcAudioPeerCallbacks = {
  onIceCandidate?: (candidate: string) => void | Promise<void>;
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onError?: (error: AudioMediaError) => void;
};

function mediaDevicesOrThrow(): MediaDevicesLike {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new AudioMediaError('unsupported', 'Audio capture is not supported by this runtime.');
  }
  return navigator.mediaDevices;
}

function peerConnectionOrThrow(config: RTCConfiguration): PeerConnectionLike {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new AudioMediaError('unsupported', 'WebRTC audio is not supported by this runtime.');
  }
  return new RTCPeerConnection(config) as unknown as PeerConnectionLike;
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name?: unknown }).name ?? '');
  }
  return '';
}

export function normalizeAudioMediaError(error: unknown): AudioMediaError {
  if (error instanceof AudioMediaError) return error;
  const name = errorName(error);
  const cause = error instanceof Error ? error : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new AudioMediaError('permission_denied', 'Microphone permission was denied.', { cause });
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new AudioMediaError('device_missing', 'No usable microphone was found.', { cause });
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new AudioMediaError('device_busy', 'The microphone is unavailable or already in use.', { cause });
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return new AudioMediaError('constraint_failed', 'The selected microphone cannot satisfy the requested audio settings.', { cause });
  }
  return new AudioMediaError('capture_failed', 'Unable to start or update the audio device.', { cause });
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach(track => track.stop());
}

export class AudioCaptureController {
  private readonly mediaDevices: MediaDevicesLike;
  private stream: MediaStream | null = null;

  constructor(mediaDevices?: MediaDevicesLike) {
    this.mediaDevices = mediaDevices ?? mediaDevicesOrThrow();
  }

  currentStream(): MediaStream | null {
    return this.stream;
  }

  async listInputDevices(requestPermission = false): Promise<AudioInputDevice[]> {
    let permissionStream: MediaStream | null = null;
    try {
      if (requestPermission) {
        permissionStream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      const devices = await this.mediaDevices.enumerateDevices();
      return devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({
          deviceId: device.deviceId,
          groupId: device.groupId,
          label: device.label || 'Microphone',
          isDefault: device.deviceId === 'default',
        }));
    } catch (error) {
      throw normalizeAudioMediaError(error);
    } finally {
      stopStream(permissionStream);
    }
  }

  async start(options: AudioCaptureOptions = {}): Promise<MediaStream> {
    const previous = this.stream;
    const previousMuted = Boolean(previous) && previous!.getAudioTracks().every(track => !track.enabled);
    const constraints: MediaTrackConstraints = {
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
    };
    if (options.deviceId) constraints.deviceId = { exact: options.deviceId };

    let next: MediaStream;
    try {
      next = await this.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (error) {
      throw normalizeAudioMediaError(error);
    }
    const tracks = next.getAudioTracks();
    if (!tracks.length) {
      stopStream(next);
      throw new AudioMediaError('device_missing', 'The selected capture source did not provide an audio track.');
    }
    tracks.forEach(track => { track.enabled = !previousMuted; });
    this.stream = next;
    stopStream(previous);
    return next;
  }

  async switchInput(deviceId: string): Promise<MediaStream> {
    const id = deviceId.trim();
    if (!id) throw new AudioMediaError('device_missing', 'A microphone must be selected before switching devices.');
    return this.start({ deviceId: id });
  }

  setMuted(muted: boolean): void {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }

  isMuted(): boolean {
    const tracks = this.stream?.getAudioTracks() ?? [];
    return tracks.length > 0 && tracks.every(track => !track.enabled);
  }

  stop(): void {
    stopStream(this.stream);
    this.stream = null;
  }
}

export function decodeIceCandidate(raw: string): RTCIceCandidateInit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AudioMediaError('invalid_signal', 'Received malformed ICE candidate data.', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AudioMediaError('invalid_signal', 'Received malformed ICE candidate data.');
  }
  const candidate = (parsed as { candidate?: unknown }).candidate;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new AudioMediaError('invalid_signal', 'Received ICE candidate data without a candidate string.');
  }
  const source = parsed as Record<string, unknown>;
  const result: RTCIceCandidateInit = { candidate };
  if (typeof source.sdpMid === 'string' || source.sdpMid === null) result.sdpMid = source.sdpMid as string | null;
  if (typeof source.sdpMLineIndex === 'number' || source.sdpMLineIndex === null) result.sdpMLineIndex = source.sdpMLineIndex as number | null;
  if (typeof source.usernameFragment === 'string' || source.usernameFragment === null) result.usernameFragment = source.usernameFragment as string | null;
  return result;
}

export class WebRtcAudioPeer {
  private readonly pc: PeerConnectionLike;
  private readonly callbacks: WebRtcAudioPeerCallbacks;
  private audioSender: SenderLike | null = null;
  private localStream: MediaStream | null = null;
  private closed = false;

  constructor(
    config: RTCConfiguration = { iceServers: [] },
    callbacks: WebRtcAudioPeerCallbacks = {},
    factory: (config: RTCConfiguration) => PeerConnectionLike = peerConnectionOrThrow,
  ) {
    this.callbacks = callbacks;
    this.pc = factory(config);
    this.pc.onicecandidate = event => {
      if (!event.candidate) return;
      this.dispatch(async () => {
        await this.callbacks.onIceCandidate?.(JSON.stringify(event.candidate!.toJSON()));
      });
    };
    this.pc.ontrack = event => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks.onRemoteStream?.(stream);
    };
    this.pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionState?.(this.pc.connectionState);
    };
  }

  connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  async setLocalStream(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new AudioMediaError('device_missing', 'Cannot attach a microphone stream without an audio track.');
    if (this.audioSender) {
      await this.audioSender.replaceTrack(track);
    } else {
      this.audioSender = this.pc.addTrack(track, stream);
    }
    this.localStream = stream;
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }

  async createOffer(stream?: MediaStream): Promise<string> {
    this.ensureOpen();
    if (stream) await this.setLocalStream(stream);
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
    await this.pc.setLocalDescription(offer);
    return this.requireSdp(this.pc.localDescription?.sdp ?? offer.sdp);
  }

  async acceptOffer(sdp: string, stream?: MediaStream): Promise<string> {
    this.ensureOpen();
    if (stream) await this.setLocalStream(stream);
    await this.pc.setRemoteDescription({ type: 'offer', sdp: this.requireSdp(sdp) });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.requireSdp(this.pc.localDescription?.sdp ?? answer.sdp);
  }

  async acceptAnswer(sdp: string): Promise<void> {
    this.ensureOpen();
    await this.pc.setRemoteDescription({ type: 'answer', sdp: this.requireSdp(sdp) });
  }

  async addIceCandidate(candidate: string): Promise<void> {
    this.ensureOpen();
    await this.pc.addIceCandidate(decodeIceCandidate(candidate));
  }

  restartIce(): void {
    this.ensureOpen();
    this.pc.restartIce?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new AudioMediaError('invalid_signal', 'The audio peer connection is already closed.');
  }

  private requireSdp(value: string | undefined): string {
    const sdp = value?.trim();
    if (!sdp) throw new AudioMediaError('invalid_signal', 'Received an empty WebRTC session description.');
    return sdp;
  }

  private dispatch(task: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(task)
      .catch(error => this.callbacks.onError?.(normalizeAudioMediaError(error)));
  }
}
