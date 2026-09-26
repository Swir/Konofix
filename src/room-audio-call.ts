import {
  AudioCaptureController,
  AudioMediaError,
  DEFAULT_AUDIO_RTC_CONFIG,
  normalizeAudioMediaError,
  WebRtcAudioPeer,
  type AudioInputDevice,
  type WebRtcAudioPeerCallbacks,
} from './audio-media-engine';
import {
  VoiceSessionStore,
  roomVoiceScope,
  type RoomVoiceIntent,
  type VoiceSession,
} from './audio-call-state';
import type {
  DirectVoiceAction,
  DirectVoiceSignal,
  DirectVoiceScope,
  VoiceSignaler,
} from './private-audio-call';

export type RoomVoicePeer = {
  peerId: string;
  nick: string;
};

export type RoomAudioCallEvents = {
  onSession?: (session: VoiceSession) => void;
  onRemoteStream?: (peerId: string, stream: MediaStream) => void;
  onParticipantLeft?: (peerId: string) => void;
  onMediaError?: (error: AudioMediaError) => void;
  onSignalingError?: (peerId: string, error: unknown) => void;
};

type CaptureLike = Pick<
  AudioCaptureController,
  'start' | 'stop' | 'setMuted' | 'switchInput' | 'currentStream' | 'listInputDevices'
>;

type PeerLike = Pick<
  WebRtcAudioPeer,
  'createOffer' | 'acceptOffer' | 'acceptAnswer' | 'addIceCandidate' | 'setLocalStream' | 'setMuted' | 'restartIce' | 'close'
>;

type PeerRuntime = {
  peerId: string;
  nick: string;
  sessionId: string;
  peer: PeerLike | null;
  remoteDescriptionReady: boolean;
  pendingIce: string[];
  offerer: boolean;
  restartPending: boolean;
  reconnecting: boolean;
};

type RoomRuntime = {
  roomId: string;
  roomSessionId: string;
  capture: CaptureLike | null;
  peers: Map<string, PeerRuntime>;
};

const MAX_PENDING_ICE_PER_PEER = 64;
const MAX_ROOM_VOICE_PEERS = 24;

function defaultSessionId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new AudioMediaError('unsupported', 'Secure random room voice identifiers are not available in this runtime.');
  }
  return crypto.randomUUID();
}

function cleanPeer(peer: RoomVoicePeer): RoomVoicePeer {
  const peerId = peer.peerId.trim();
  const nick = peer.nick.trim() || peerId;
  if (!peerId || peerId.length > 128) throw new Error('Invalid room voice peer ID.');
  return { peerId, nick };
}

function roomScope(roomId: string): DirectVoiceScope {
  return { kind: 'room', room_id: roomId };
}

export class RoomAudioCallController {
  readonly sessions: VoiceSessionStore;

  private readonly signaler: VoiceSignaler;
  private readonly events: RoomAudioCallEvents;
  private readonly captureFactory: () => CaptureLike;
  private readonly peerFactory: (callbacks: WebRtcAudioPeerCallbacks) => PeerLike;
  private readonly sessionIdFactory: () => string;
  private active: RoomRuntime | null = null;

  constructor(
    signaler: VoiceSignaler,
    options: {
      sessions?: VoiceSessionStore;
      events?: RoomAudioCallEvents;
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
    const rtcConfig = options.rtcConfig ?? DEFAULT_AUDIO_RTC_CONFIG;
    this.peerFactory = options.peerFactory ?? (callbacks => new WebRtcAudioPeer(rtcConfig, callbacks));
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionId;
  }

  activeSession(): VoiceSession | undefined {
    if (!this.active) return undefined;
    return this.sessions.session(roomVoiceScope(this.active.roomId));
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

  async joinRoom(
    roomId: string,
    peers: readonly RoomVoicePeer[],
    intent: Exclude<RoomVoiceIntent, 'none'> = 'listen',
  ): Promise<VoiceSession> {
    if (this.active) throw new Error('A room voice session is already active.');
    if (!this.sessions.canJoinRoomVoice()) throw new Error('Room voice is disabled.');

    const scope = roomVoiceScope(roomId);
    const roomSessionId = this.sessionIdFactory();
    this.active = {
      roomId: scope.roomId,
      roomSessionId,
      capture: null,
      peers: new Map(),
    };

    let session = this.sessions.begin(roomSessionId, scope, 'joining');
    session = this.sessions.setRoomIntent(scope, intent);
    this.emit(session);

    try {
      if (intent === 'speak') {
        const capture = this.ensureCapture();
        await capture.start();
        capture.setMuted(false);
      }

      const unique = new Map<string, RoomVoicePeer>();
      for (const raw of peers) {
        const peer = cleanPeer(raw);
        if (!unique.has(peer.peerId)) unique.set(peer.peerId, peer);
        if (unique.size >= MAX_ROOM_VOICE_PEERS) break;
      }
      for (const peer of unique.values()) {
        await this.invitePeer(peer).catch(error => {
          this.events.onSignalingError?.(peer.peerId, error);
          this.removePeer(peer.peerId);
        });
      }

      if (this.active.peers.size === 0) {
        session = this.sessions.transition(scope, 'connected');
        this.emit(session);
      }
      return this.sessions.session(scope)!;
    } catch (error) {
      this.cleanupRoom();
      if (this.sessions.session(scope) && !['ended', 'error'].includes(this.sessions.session(scope)!.phase)) {
        const normalized = normalizeAudioMediaError(error);
        this.emit(this.sessions.transition(scope, 'error', Date.now(), normalized.message));
        this.events.onMediaError?.(normalized);
      }
      throw error;
    }
  }

  async syncPeers(peers: readonly RoomVoicePeer[]): Promise<void> {
    const runtime = this.requireActive();
    const wanted = new Map<string, RoomVoicePeer>();
    for (const raw of peers) {
      const peer = cleanPeer(raw);
      if (!wanted.has(peer.peerId)) wanted.set(peer.peerId, peer);
      if (wanted.size >= MAX_ROOM_VOICE_PEERS) break;
    }

    const departureNotifications: Promise<void>[] = [];
    for (const peerId of [...runtime.peers.keys()]) {
      if (wanted.has(peerId)) continue;
      const peerRuntime = runtime.peers.get(peerId)!;
      this.removePeer(peerId);
      departureNotifications.push(this.bestEffortSend(peerId, peerRuntime.sessionId, 'end'));
    }
    for (const peer of wanted.values()) {
      if (runtime.peers.has(peer.peerId)) continue;
      await this.invitePeer(peer).catch(error => {
        this.events.onSignalingError?.(peer.peerId, error);
        this.removePeer(peer.peerId);
      });
    }
    await Promise.allSettled(departureNotifications);
  }

  async setIntent(intent: Exclude<RoomVoiceIntent, 'none'>): Promise<VoiceSession> {
    const runtime = this.requireActive();
    const scope = roomVoiceScope(runtime.roomId);
    let session = this.sessions.setRoomIntent(scope, intent);

    if (intent === 'speak') {
      try {
        const capture = this.ensureCapture();
        let stream = capture.currentStream();
        if (!stream) stream = await capture.start();
        capture.setMuted(session.localMuted);
        for (const peerRuntime of runtime.peers.values()) {
          if (!peerRuntime.peer) continue;
          await peerRuntime.peer.setLocalStream(stream);
          peerRuntime.peer.setMuted(session.localMuted);
          if (peerRuntime.remoteDescriptionReady) {
            const offer = await peerRuntime.peer.createOffer();
            await this.send(peerRuntime, 'offer', { sdp: offer });
          }
        }
      } catch (error) {
        session = this.sessions.setRoomIntent(scope, 'listen');
        runtime.capture?.stop();
        const normalized = normalizeAudioMediaError(error);
        this.events.onMediaError?.(normalized);
        this.emit(session);
        throw normalized;
      }
    } else {
      runtime.capture?.stop();
      for (const peerRuntime of runtime.peers.values()) peerRuntime.peer?.setMuted(true);
    }

    session = this.sessions.session(scope)!;
    this.emit(session);
    await this.broadcastState(session);
    return session;
  }

  async setMuted(muted: boolean): Promise<VoiceSession> {
    const runtime = this.requireActive();
    const scope = roomVoiceScope(runtime.roomId);
    const current = this.sessions.session(scope);
    if (!current) throw new Error('Unknown room voice session.');
    if (current.roomIntent !== 'speak' && !muted) {
      throw new Error('Choose want-to-speak before enabling the microphone.');
    }
    const effectiveMuted = current.roomIntent === 'speak' ? muted : true;
    runtime.capture?.setMuted(effectiveMuted);
    for (const peerRuntime of runtime.peers.values()) peerRuntime.peer?.setMuted(effectiveMuted);
    const session = this.sessions.setLocalMuted(scope, effectiveMuted);
    this.emit(session);
    await this.broadcastState(session);
    return session;
  }

  async setDeafened(deafened: boolean): Promise<VoiceSession> {
    const runtime = this.requireActive();
    const session = this.sessions.setDeafened(roomVoiceScope(runtime.roomId), deafened);
    this.emit(session);
    return session;
  }

  async switchInput(deviceId: string): Promise<void> {
    const runtime = this.requireActive();
    const scope = roomVoiceScope(runtime.roomId);
    const session = this.sessions.session(scope);
    if (!session || session.roomIntent !== 'speak') {
      throw new Error('Microphone selection is available only while you want to speak.');
    }
    const capture = this.ensureCapture();
    const stream = await capture.switchInput(deviceId);
    capture.setMuted(session.localMuted);
    for (const peerRuntime of runtime.peers.values()) {
      if (!peerRuntime.peer) continue;
      await peerRuntime.peer.setLocalStream(stream);
      peerRuntime.peer.setMuted(session.localMuted);
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.active) return;
    const runtime = this.active;
    const scope = roomVoiceScope(runtime.roomId);
    const notifications = [...runtime.peers.values()].map(peer =>
      this.signaler.send({
        peerId: peer.peerId,
        sessionId: peer.sessionId,
        scope: roomScope(runtime.roomId),
        action: 'end',
      }).catch(() => undefined),
    );
    const session = this.sessions.session(scope);
    if (session && !['ended', 'error'].includes(session.phase)) {
      this.emit(this.sessions.transition(scope, 'ended'));
    }
    this.cleanupRoom();
    await Promise.allSettled(notifications);
  }

  async handleSignal(signal: DirectVoiceSignal): Promise<boolean> {
    if (signal.scope.kind !== 'room') return false;
    if (signal.action === 'invite') return this.handleInvite(signal);

    const runtime = this.active;
    if (!runtime || runtime.roomId !== signal.scope.room_id) return false;
    const peerRuntime = runtime.peers.get(signal.peer_id);
    if (!peerRuntime || peerRuntime.sessionId !== signal.session_id) return false;

    switch (signal.action) {
      case 'accept':
        await this.handleAccept(peerRuntime);
        return true;
      case 'reject':
      case 'end':
        this.removePeer(signal.peer_id);
        return true;
      case 'offer':
        await this.handleOffer(peerRuntime, signal);
        return true;
      case 'answer':
        await this.handleAnswer(peerRuntime, signal);
        return true;
      case 'ice_candidate':
        await this.handleIce(peerRuntime, signal);
        return true;
      case 'state':
        this.handleState(signal);
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.cleanupRoom();
    this.sessions.reset();
  }

  private async invitePeer(peer: RoomVoicePeer): Promise<void> {
    const runtime = this.requireActive();
    if (runtime.peers.has(peer.peerId)) return;
    const peerRuntime: PeerRuntime = {
      ...peer,
      sessionId: this.sessionIdFactory(),
      peer: null,
      remoteDescriptionReady: false,
      pendingIce: [],
      offerer: true,
      restartPending: false,
      reconnecting: false,
    };
    runtime.peers.set(peer.peerId, peerRuntime);
    const session = this.sessions.session(roomVoiceScope(runtime.roomId));
    this.sessions.upsertParticipant(roomVoiceScope(runtime.roomId), {
      peerId: peer.peerId,
      nick: peer.nick,
      muted: true,
      speaking: false,
    });
    this.emit(this.sessions.session(roomVoiceScope(runtime.roomId))!);
    await this.send(peerRuntime, 'invite', {
      roomIntent: session?.roomIntent === 'speak' ? 'speak' : 'listen',
    });
  }

  private async handleInvite(signal: DirectVoiceSignal): Promise<boolean> {
    const roomId = signal.scope.kind === 'room' ? signal.scope.room_id : '';
    const runtime = this.active;
    if (!runtime || runtime.roomId !== roomId || !this.sessions.canJoinRoomVoice()) {
      await this.signaler.send({
        peerId: signal.peer_id,
        sessionId: signal.session_id,
        scope: roomScope(roomId),
        action: 'reject',
      }).catch(() => undefined);
      return false;
    }

    const existing = runtime.peers.get(signal.peer_id);
    if (existing) {
      if (existing.sessionId === signal.session_id) return true;
      if (existing.sessionId.localeCompare(signal.session_id) < 0) {
        await this.signaler.send({
          peerId: signal.peer_id,
          sessionId: signal.session_id,
          scope: roomScope(roomId),
          action: 'reject',
        }).catch(() => undefined);
        return false;
      }
      this.removePeer(signal.peer_id);
    }

    const peerRuntime: PeerRuntime = {
      peerId: signal.peer_id,
      nick: signal.nick || signal.peer_id,
      sessionId: signal.session_id,
      peer: null,
      remoteDescriptionReady: false,
      pendingIce: [],
      offerer: false,
      restartPending: false,
      reconnecting: false,
    };
    runtime.peers.set(peerRuntime.peerId, peerRuntime);
    const incomingMuted = signal.room_intent !== 'speak';
    this.sessions.upsertParticipant(roomVoiceScope(roomId), {
      peerId: peerRuntime.peerId,
      nick: peerRuntime.nick,
      muted: incomingMuted,
      speaking: signal.room_intent === 'speak' && !incomingMuted,
    });
    this.emit(this.sessions.session(roomVoiceScope(roomId))!);

    await this.send(peerRuntime, 'accept');
    const session = this.sessions.session(roomVoiceScope(roomId));
    if (session) await this.send(peerRuntime, 'state', this.statePayload(session));
    return true;
  }

  private async handleAccept(peerRuntime: PeerRuntime): Promise<void> {
    const runtime = this.requireActive();
    const session = this.sessions.session(roomVoiceScope(runtime.roomId));
    if (!session) return;
    try {
      const peer = this.ensurePeer(peerRuntime);
      const stream = session.roomIntent === 'speak' ? this.ensureCapture().currentStream() ?? undefined : undefined;
      const sdp = await peer.createOffer(stream ?? undefined);
      await this.send(peerRuntime, 'offer', { sdp });
      await this.send(peerRuntime, 'state', this.statePayload(session));
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
      this.removePeer(peerRuntime.peerId);
    }
  }

  private async handleOffer(peerRuntime: PeerRuntime, signal: DirectVoiceSignal): Promise<void> {
    const sdp = signal.sdp?.trim();
    if (!sdp) {
      this.events.onMediaError?.(new AudioMediaError('invalid_signal', 'Incoming room audio offer is missing SDP.'));
      return;
    }
    const runtime = this.requireActive();
    const session = this.sessions.session(roomVoiceScope(runtime.roomId));
    if (!session) return;
    try {
      let stream: MediaStream | undefined;
      if (session.roomIntent === 'speak') {
        const capture = this.ensureCapture();
        stream = capture.currentStream() ?? await capture.start();
        capture.setMuted(session.localMuted);
      }
      const peer = this.ensurePeer(peerRuntime);
      peerRuntime.remoteDescriptionReady = false;
      const answer = await peer.acceptOffer(sdp, stream);
      peerRuntime.remoteDescriptionReady = true;
      await this.flushIce(peerRuntime);
      await this.send(peerRuntime, 'answer', { sdp: answer });
      await this.send(peerRuntime, 'state', this.statePayload(session));
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
      this.removePeer(peerRuntime.peerId);
    }
  }

  private async handleAnswer(peerRuntime: PeerRuntime, signal: DirectVoiceSignal): Promise<void> {
    const sdp = signal.sdp?.trim();
    if (!sdp || !peerRuntime.peer) {
      this.events.onMediaError?.(new AudioMediaError('invalid_signal', 'Incoming room audio answer is invalid.'));
      return;
    }
    try {
      await peerRuntime.peer.acceptAnswer(sdp);
      peerRuntime.remoteDescriptionReady = true;
      await this.flushIce(peerRuntime);
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
      this.removePeer(peerRuntime.peerId);
    }
  }

  private async handleIce(peerRuntime: PeerRuntime, signal: DirectVoiceSignal): Promise<void> {
    const candidate = signal.candidate?.trim();
    if (!candidate) return;
    if (!peerRuntime.peer || !peerRuntime.remoteDescriptionReady) {
      if (peerRuntime.pendingIce.length < MAX_PENDING_ICE_PER_PEER) peerRuntime.pendingIce.push(candidate);
      return;
    }
    try {
      await peerRuntime.peer.addIceCandidate(candidate);
    } catch (error) {
      this.events.onMediaError?.(normalizeAudioMediaError(error));
    }
  }

  private handleState(signal: DirectVoiceSignal): void {
    const runtime = this.requireActive();
    const scope = roomVoiceScope(runtime.roomId);
    const existing = this.sessions.session(scope)?.participants.get(signal.peer_id);
    const muted = typeof signal.muted === 'boolean' ? signal.muted : existing?.muted ?? true;
    const speaking = signal.room_intent === 'speak' && !muted;
    const session = this.sessions.upsertParticipant(scope, {
      peerId: signal.peer_id,
      nick: signal.nick || existing?.nick || signal.peer_id,
      muted,
      speaking,
    });
    this.emit(session);
  }

  private ensureCapture(): CaptureLike {
    const runtime = this.requireActive();
    runtime.capture ??= this.captureFactory();
    return runtime.capture;
  }

  private ensurePeer(peerRuntime: PeerRuntime): PeerLike {
    if (peerRuntime.peer) return peerRuntime.peer;
    peerRuntime.peer = this.peerFactory({
      onIceCandidate: async candidate => {
        try {
          await this.send(peerRuntime, 'ice_candidate', { candidate });
        } catch (error) {
          this.events.onSignalingError?.(peerRuntime.peerId, error);
        }
      },
      onRemoteStream: stream => this.events.onRemoteStream?.(peerRuntime.peerId, stream),
      onConnectionState: state => this.handleConnectionState(peerRuntime.peerId, state),
      onError: error => this.events.onMediaError?.(error),
    });
    return peerRuntime.peer;
  }

  private handleConnectionState(peerId: string, state: RTCPeerConnectionState): void {
    const runtime = this.active;
    if (!runtime) return;
    const peerRuntime = runtime.peers.get(peerId);
    if (!peerRuntime) return;
    const scope = roomVoiceScope(runtime.roomId);
    const session = this.sessions.session(scope);
    if (!session) return;

    if (state === 'connected') {
      peerRuntime.reconnecting = false;
      peerRuntime.restartPending = false;
      if (session.phase === 'joining' || (session.phase === 'reconnecting' && !this.hasReconnectingPeers(runtime))) {
        this.emit(this.sessions.transition(scope, 'connected'));
      }
    } else if (state === 'disconnected') {
      peerRuntime.reconnecting = true;
      if (session.phase === 'connected') this.emit(this.sessions.transition(scope, 'reconnecting'));
      if (peerRuntime.offerer && !peerRuntime.restartPending) {
        peerRuntime.restartPending = true;
        void this.restartPeerConnection(peerRuntime);
      }
    } else if (state === 'failed' || state === 'closed') {
      peerRuntime.reconnecting = false;
      peerRuntime.restartPending = false;
      this.removePeer(peerId);
      const current = this.sessions.session(scope);
      if (current?.phase === 'reconnecting' && !this.hasReconnectingPeers(runtime)) {
        this.emit(this.sessions.transition(scope, 'connected'));
      }
    }
  }

  private async restartPeerConnection(peerRuntime: PeerRuntime): Promise<void> {
    const runtime = this.active;
    if (!runtime || runtime.peers.get(peerRuntime.peerId) !== peerRuntime || !peerRuntime.peer) return;
    try {
      peerRuntime.remoteDescriptionReady = false;
      peerRuntime.pendingIce.length = 0;
      peerRuntime.peer.restartIce();
      const sdp = await peerRuntime.peer.createOffer();
      if (this.active !== runtime || runtime.peers.get(peerRuntime.peerId) !== peerRuntime) return;
      await this.send(peerRuntime, 'offer', { sdp });
    } catch (error) {
      if (this.active !== runtime || runtime.peers.get(peerRuntime.peerId) !== peerRuntime) return;
      this.events.onMediaError?.(normalizeAudioMediaError(error));
      peerRuntime.reconnecting = false;
      peerRuntime.restartPending = false;
      this.removePeer(peerRuntime.peerId);
      const scope = roomVoiceScope(runtime.roomId);
      const current = this.sessions.session(scope);
      if (current?.phase === 'reconnecting' && !this.hasReconnectingPeers(runtime)) {
        this.emit(this.sessions.transition(scope, 'connected'));
      }
    }
  }

  private hasReconnectingPeers(runtime: RoomRuntime): boolean {
    return [...runtime.peers.values()].some(peer => peer.reconnecting);
  }

  private async flushIce(peerRuntime: PeerRuntime): Promise<void> {
    if (!peerRuntime.peer || !peerRuntime.remoteDescriptionReady) return;
    const pending = peerRuntime.pendingIce.splice(0);
    for (const candidate of pending) {
      try {
        await peerRuntime.peer.addIceCandidate(candidate);
      } catch (error) {
        this.events.onMediaError?.(normalizeAudioMediaError(error));
      }
    }
  }

  private async broadcastState(session: VoiceSession): Promise<void> {
    const runtime = this.requireActive();
    await Promise.allSettled(
      [...runtime.peers.values()].map(peer => this.send(peer, 'state', this.statePayload(session))),
    );
  }

  private statePayload(session: VoiceSession): {
    roomIntent: 'listen' | 'speak';
    muted: boolean;
  } {
    return {
      roomIntent: session.roomIntent === 'speak' ? 'speak' : 'listen',
      muted: session.roomIntent === 'speak' ? session.localMuted : true,
    };
  }

  private async send(
    peerRuntime: PeerRuntime,
    action: DirectVoiceAction,
    payload: {
      sdp?: string;
      candidate?: string;
      roomIntent?: 'listen' | 'speak';
      muted?: boolean;
    } = {},
  ): Promise<void> {
    const runtime = this.requireActive();
    await this.signaler.send({
      peerId: peerRuntime.peerId,
      sessionId: peerRuntime.sessionId,
      scope: roomScope(runtime.roomId),
      action,
      sdp: payload.sdp ?? null,
      candidate: payload.candidate ?? null,
      roomIntent: payload.roomIntent ?? null,
      muted: payload.muted ?? null,
    });
  }

  private async bestEffortSend(peerId: string, sessionId: string, action: DirectVoiceAction): Promise<void> {
    const runtime = this.active;
    if (!runtime) return;
    await this.signaler.send({
      peerId,
      sessionId,
      scope: roomScope(runtime.roomId),
      action,
    }).catch(() => undefined);
  }

  private removePeer(peerId: string): void {
    const runtime = this.active;
    if (!runtime) return;
    const peerRuntime = runtime.peers.get(peerId);
    if (!peerRuntime) return;
    peerRuntime.peer?.close();
    runtime.peers.delete(peerId);
    const scope = roomVoiceScope(runtime.roomId);
    if (this.sessions.session(scope)) {
      this.emit(this.sessions.removeParticipant(scope, peerId));
    }
    this.events.onParticipantLeft?.(peerId);
  }

  private cleanupRoom(): void {
    const runtime = this.active;
    if (!runtime) return;
    runtime.capture?.stop();
    for (const peerRuntime of runtime.peers.values()) peerRuntime.peer?.close();
    runtime.peers.clear();
    this.active = null;
  }

  private requireActive(): RoomRuntime {
    if (!this.active) throw new Error('No room voice session is active.');
    return this.active;
  }

  private emit(session: VoiceSession): void {
    this.events.onSession?.(session);
  }
}
