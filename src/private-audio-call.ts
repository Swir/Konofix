import {
  AudioCaptureController,
  AudioMediaError,
  normalizeAudioMediaError,
  WebRtcAudioPeer,
  type AudioInputDevice,
  type WebRtcAudioPeerCallbacks,
} from './audio-media-engine';
import {
  VoiceSessionStore,
  privateVoiceScope,
  type VoiceSession,
} from './audio-call-state';

export type DirectVoiceScope =
  | { kind: 'private' }
  | { kind: 'room'; room_id: string };

export type DirectVoiceAction =
  | 'invite'
  | 'accept'
  | 'reject'
  | 'end'
  | 'offer'
  | 'answer'
  | 'ice_candidate'
  | 'state';

export type DirectVoiceSignal = {
  id: string;
  session_id: string;
  peer_id: string;
  target_peer_id: string;
  nick: string;
  nick_color?: string;
  scope: DirectVoiceScope;
  action: DirectVoiceAction;
  sdp?: string | null;
  candidate?: string | null;
  room_intent?: 'listen' | 'speak' | null;
  muted?: boolean | null;
  timestamp: number;
};

export type SendVoiceSignal = {
  peerId: string;
  sessionId: string;
  scope: DirectVoiceScope;
  action: DirectVoiceAction;
  sdp?: string | null;
  candidate?: string | null;
  roomIntent?: 'listen' | 'speak' | null;
  muted?: boolean | null;
};

export type VoiceSignaler = {
  send(signal: SendVoiceSignal): Promise<unknown>;
};

export type PrivateAudioCallEvents = {
  onSession?: (session: VoiceSession) => void;
  onIncomingCall?: (signal: DirectVoiceSignal) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onMediaError?: (error: AudioMediaError) => void;
};

type CaptureLike = Pick<
  AudioCaptureController,
  'start' | 'stop' | 'setMuted' | 'switchInput' | 'currentStream' | 'listInputDevices'
>;

type PeerLike = Pick<
  WebRtcAudioPeer,
  'createOffer' | 'acceptOffer' | 'acceptAnswer' | 'addIceCandidate' | 'setLocalStream' | 'setMuted' | 'restartIce' | 'close'
>;

type Runtime = {
  peerId: string;
  nick: string;
  sessionId: string;
  capture: CaptureLike | null;
  peer: PeerLike | null;
  remoteDescriptionReady: boolean;
  pendingIce: string[];
  offerer: boolean;
  restartPending: boolean;
};

const PRIVATE_SCOPE: DirectVoiceScope = { kind: 'private' };
const MAX_PENDING_ICE = 64;

function defaultSessionId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new AudioMediaError('unsupported', 'Secure random call identifiers are not available in this runtime.');
  }
  return crypto.randomUUID();
}

export class PrivateAudioCallController {
  readonly sessions: VoiceSessionStore;

  private readonly signaler: VoiceSignaler;
  private readonly events: PrivateAudioCallEvents;
  private readonly captureFactory: () => CaptureLike;
  private readonly peerFactory: (callbacks: WebRtcAudioPeerCallbacks) => PeerLike;
  private readonly sessionIdFactory: () => string;
  private active: Runtime | null = null;

  constructor(
    signaler: VoiceSignaler,
    options: {
      sessions?: VoiceSessionStore;
      events?: PrivateAudioCallEvents;
      captureFactory?: () => CaptureLike;
      peerFactory?: (callbacks: WebRtcAudioPeerCallbacks) => PeerLike;
      sessionIdFactory?: () => string;
      rtcConfig?: RTCConfiguration;
    } = {},
  ) {
    this.signaler = signaler;
    this.sessions = options.sessions ?? new VoiceSessionStore();
    this.events = options.events ?? {};
    this.captureFactory = options.captureFactory ?? (() => new AudioCaptureController());
    const rtcConfig = options.rtcConfig ?? { iceServers: [] };
    this.peerFactory = options.peerFactory ?? (callbacks => new WebRtcAudioPeer(rtcConfig, callbacks));
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionId;
  }

  activeSession(): VoiceSession | undefined {
    return this.active ? this.sessions.session(privateVoiceScope(this.active.peerId)) : undefined;
  }

  async listInputDevices(requestPermission = false): Promise<AudioInputDevice[]> {
    const capture = this.active?.capture ?? this.captureFactory();
    const temporary = capture !== this.active?.capture;
    try {
      return await capture.listInputDevices(requestPermission);
    } finally {
      if (temporary) capture.stop();
    }
  }

  async startPrivateCall(peerId: string, nick = peerId): Promise<VoiceSession> {
    this.requireIdle();
    const sessionId = this.sessionIdFactory();
    const scope = privateVoiceScope(peerId);
    const session = this.sessions.begin(sessionId, scope, 'calling');
    this.active = {
      peerId: peerId.trim(),
      nick,
      sessionId,
      capture: null,
      peer: null,
      remoteDescriptionReady: false,
      pendingIce: [],
      offerer: true,
      restartPending: false,
    };
    this.emit(session);
    try {
      await this.send('invite');
      return session;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async acceptPrivateCall(): Promise<VoiceSession> {
    const runtime = this.requireActive();
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (!session || session.phase !== 'ringing') throw new Error('No incoming private audio call is ringing.');

    try {
      const joining = this.sessions.transition(scope, 'joining');
      this.emit(joining);
      const capture = this.ensureCapture();
      const stream = await capture.start();
      this.ensurePeer();
      await this.active!.peer!.setLocalStream(stream);
      await this.send('accept');
      return joining;
    } catch (error) {
      await this.bestEffortSend('reject');
      this.fail(error);
      throw error;
    }
  }

  async rejectPrivateCall(): Promise<void> {
    const runtime = this.requireActive();
    await this.bestEffortSend('reject');
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (session && !['ended', 'error'].includes(session.phase)) this.emit(this.sessions.transition(scope, 'ended'));
    this.cleanup();
  }

  async endPrivateCall(): Promise<void> {
    if (!this.active) return;
    const runtime = this.active;
    await this.bestEffortSend('end');
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (session && !['ended', 'error'].includes(session.phase)) this.emit(this.sessions.transition(scope, 'ended'));
    this.cleanup();
  }

  async setMuted(muted: boolean): Promise<VoiceSession> {
    const runtime = this.requireActive();
    runtime.capture?.setMuted(muted);
    runtime.peer?.setMuted(muted);
    const session = this.sessions.setLocalMuted(privateVoiceScope(runtime.peerId), muted);
    this.emit(session);
    await this.send('state', { muted });
    return session;
  }

  async setDeafened(deafened: boolean): Promise<VoiceSession> {
    const runtime = this.requireActive();
    const session = this.sessions.setDeafened(privateVoiceScope(runtime.peerId), deafened);
    this.emit(session);
    return session;
  }

  async switchInput(deviceId: string): Promise<void> {
    const runtime = this.requireActive();
    const capture = this.ensureCapture();
    const stream = await capture.switchInput(deviceId);
    const peer = this.ensurePeer();
    await peer.setLocalStream(stream);
    peer.setMuted(this.sessions.session(privateVoiceScope(runtime.peerId))?.localMuted ?? false);
  }

  async handleSignal(signal: DirectVoiceSignal): Promise<boolean> {
    if (signal.scope.kind !== 'private') return false;
    if (signal.action === 'invite') return this.handleInvite(signal);

    const runtime = this.active;
    if (!runtime || runtime.peerId !== signal.peer_id || runtime.sessionId !== signal.session_id) return false;

    switch (signal.action) {
      case 'accept':
        await this.handleAccept();
        return true;
      case 'reject':
      case 'end':
        this.finishRemote();
        return true;
      case 'offer':
        await this.handleOffer(signal);
        return true;
      case 'answer':
        await this.handleAnswer(signal);
        return true;
      case 'ice_candidate':
        await this.handleIce(signal);
        return true;
      case 'state':
        this.handleState(signal);
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.cleanup();
    this.sessions.reset();
  }

  private async handleInvite(signal: DirectVoiceSignal): Promise<boolean> {
    if (!this.sessions.canReceivePrivateCall() || this.active) {
      await this.signaler.send({
        peerId: signal.peer_id,
        sessionId: signal.session_id,
        scope: PRIVATE_SCOPE,
        action: 'reject',
      }).catch(() => undefined);
      return false;
    }
    const scope = privateVoiceScope(signal.peer_id);
    const session = this.sessions.begin(signal.session_id, scope, 'ringing');
    this.active = {
      peerId: signal.peer_id,
      nick: signal.nick,
      sessionId: signal.session_id,
      capture: null,
      peer: null,
      remoteDescriptionReady: false,
      pendingIce: [],
      offerer: false,
      restartPending: false,
    };
    this.sessions.upsertParticipant(scope, {
      peerId: signal.peer_id,
      nick: signal.nick,
      muted: false,
      speaking: false,
    });
    this.emit(session);
    this.events.onIncomingCall?.(signal);
    return true;
  }

  private async handleAccept(): Promise<void> {
    const runtime = this.requireActive();
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (!session || session.phase !== 'calling') return;
    try {
      this.emit(this.sessions.transition(scope, 'joining'));
      const capture = this.ensureCapture();
      const stream = await capture.start();
      const peer = this.ensurePeer();
      const sdp = await peer.createOffer(stream);
      await this.send('offer', { sdp });
    } catch (error) {
      await this.bestEffortSend('end');
      this.fail(error);
      throw error;
    }
  }

  private async handleOffer(signal: DirectVoiceSignal): Promise<void> {
    if (!signal.sdp) return this.fail(new AudioMediaError('invalid_signal', 'Incoming audio offer is missing SDP.'));
    const runtime = this.requireActive();
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (!session || !['joining', 'reconnecting'].includes(session.phase)) return;
    try {
      const capture = this.ensureCapture();
      let stream = capture.currentStream();
      if (!stream) stream = await capture.start();
      const peer = this.ensurePeer();
      const answer = await peer.acceptOffer(signal.sdp, stream);
      runtime.remoteDescriptionReady = true;
      await this.flushIce();
      await this.send('answer', { sdp: answer });
    } catch (error) {
      await this.bestEffortSend('end');
      this.fail(error);
      throw error;
    }
  }

  private async handleAnswer(signal: DirectVoiceSignal): Promise<void> {
    if (!signal.sdp) return this.fail(new AudioMediaError('invalid_signal', 'Incoming audio answer is missing SDP.'));
    const runtime = this.requireActive();
    if (!runtime.peer) return this.fail(new AudioMediaError('invalid_signal', 'Incoming audio answer arrived before a peer connection was created.'));
    try {
      await runtime.peer.acceptAnswer(signal.sdp);
      runtime.remoteDescriptionReady = true;
      await this.flushIce();
    } catch (error) {
      await this.bestEffortSend('end');
      this.fail(error);
      throw error;
    }
  }

  private async handleIce(signal: DirectVoiceSignal): Promise<void> {
    const candidate = signal.candidate?.trim();
    if (!candidate) return;
    const runtime = this.requireActive();
    if (!runtime.peer || !runtime.remoteDescriptionReady) {
      if (runtime.pendingIce.length < MAX_PENDING_ICE) runtime.pendingIce.push(candidate);
      return;
    }
    try {
      await runtime.peer.addIceCandidate(candidate);
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
    }
  }

  private handleState(signal: DirectVoiceSignal): void {
    const runtime = this.requireActive();
    if (typeof signal.muted !== 'boolean') return;
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.upsertParticipant(scope, {
      peerId: runtime.peerId,
      nick: signal.nick || runtime.nick,
      muted: signal.muted,
      speaking: false,
    });
    this.emit(session);
  }

  private ensureCapture(): CaptureLike {
    const runtime = this.requireActive();
    runtime.capture ??= this.captureFactory();
    return runtime.capture;
  }

  private ensurePeer(): PeerLike {
    const runtime = this.requireActive();
    if (runtime.peer) return runtime.peer;
    runtime.peer = this.peerFactory({
      onIceCandidate: async candidate => {
        try {
          await this.send('ice_candidate', { candidate });
        } catch (error) {
          this.events.onMediaError?.(normalizeAudioMediaError(error));
        }
      },
      onRemoteStream: stream => this.events.onRemoteStream?.(stream),
      onConnectionState: state => this.handleConnectionState(state),
      onError: error => this.events.onMediaError?.(error),
    });
    return runtime.peer;
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    const runtime = this.active;
    if (!runtime) return;
    const scope = privateVoiceScope(runtime.peerId);
    const session = this.sessions.session(scope);
    if (!session) return;
    try {
      if (state === 'connected' && ['joining', 'reconnecting'].includes(session.phase)) {
        runtime.restartPending = false;
        this.emit(this.sessions.transition(scope, 'connected'));
      } else if (state === 'disconnected' && ['connected', 'reconnecting'].includes(session.phase)) {
        if (session.phase === 'connected') this.emit(this.sessions.transition(scope, 'reconnecting'));
        if (runtime.offerer && !runtime.restartPending) {
          runtime.restartPending = true;
          void this.restartConnection(runtime);
        }
      } else if (state === 'failed' && !['error', 'ended'].includes(session.phase)) {
        try {
          this.fail(new AudioMediaError('capture_failed', 'The WebRTC audio connection failed.'));
        } catch {
          // fail() already records the error, reports it and tears down media.
        }
      } else if (state === 'closed' && !['error', 'ended'].includes(session.phase)) {
        this.emit(this.sessions.transition(scope, 'ended'));
        this.cleanup();
      }
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
    }
  }

  private async restartConnection(runtime: Runtime): Promise<void> {
    if (this.active !== runtime || !runtime.peer) return;
    try {
      runtime.remoteDescriptionReady = false;
      runtime.peer.restartIce();
      const sdp = await runtime.peer.createOffer();
      if (this.active !== runtime) return;
      await this.send('offer', { sdp });
    } catch (error) {
      if (this.active !== runtime) return;
      try {
        this.fail(error);
      } catch {
        // fail() records the terminal error and releases media resources.
      }
    }
  }

  private async flushIce(): Promise<void> {
    const runtime = this.requireActive();
    if (!runtime.peer || !runtime.remoteDescriptionReady) return;
    const pending = runtime.pendingIce.splice(0);
    for (const candidate of pending) {
      try {
        await runtime.peer.addIceCandidate(candidate);
      } catch (error) {
        this.events.onMediaError?.(normalizeAudioMediaError(error));
      }
    }
  }

  private finishRemote(): void {
    if (!this.active) return;
    const scope = privateVoiceScope(this.active.peerId);
    const session = this.sessions.session(scope);
    if (session && !['ended', 'error'].includes(session.phase)) this.emit(this.sessions.transition(scope, 'ended'));
    this.cleanup();
  }

  private fail(error: unknown): never {
    const normalized = normalizeAudioMediaError(error);
    if (this.active) {
      const scope = privateVoiceScope(this.active.peerId);
      const session = this.sessions.session(scope);
      if (session && !['error', 'ended'].includes(session.phase)) {
        try { this.emit(this.sessions.transition(scope, 'error', Date.now(), normalized.message)); } catch {}
      }
    }
    this.events.onMediaError?.(normalized);
    this.cleanup();
    throw normalized;
  }

  private cleanup(): void {
    const runtime = this.active;
    this.active = null;
    runtime?.peer?.close();
    runtime?.capture?.stop();
  }

  private requireIdle(): void {
    if (this.active) throw new Error('Another private audio call is already active.');
  }

  private requireActive(): Runtime {
    if (!this.active) throw new Error('No private audio call is active.');
    return this.active;
  }

  private emit(session: VoiceSession): void {
    this.events.onSession?.(session);
  }

  private send(action: DirectVoiceAction, payload: Partial<SendVoiceSignal> = {}): Promise<unknown> {
    const runtime = this.requireActive();
    return this.signaler.send({
      peerId: runtime.peerId,
      sessionId: runtime.sessionId,
      scope: PRIVATE_SCOPE,
      action,
      sdp: payload.sdp ?? null,
      candidate: payload.candidate ?? null,
      roomIntent: null,
      muted: payload.muted ?? null,
    });
  }

  private async bestEffortSend(action: DirectVoiceAction): Promise<void> {
    try { await this.send(action); } catch {}
  }
}
