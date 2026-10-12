import type { VoiceSignal, WorldVoiceState } from './world-relay';

const WORLD_TURN_MS = 60_000;
const MAX_GROUP_SESSIONS = 32;
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 4,
};
const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

type Session = {
  id: string;
  peerId: string;
  scope: string;
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  closed: boolean;
};

export type GroupVoiceSnapshot = {
  world: WorldVoiceState[];
  speaker?: WorldVoiceState;
  localWorld?: WorldVoiceState;
  canStartWorld: boolean;
  secondsLeft: number;
  roomScope?: string;
  roomActive: boolean;
  roomPeers: number;
  error?: string;
};

type Callbacks = {
  sendSignal(peerId: string, signal: VoiceSignal): void;
  publishWorld(state: Omit<WorldVoiceState, 'peer_id' | 'nick' | 'nick_color'>): void;
  peers(): string[];
  onRemoteStream(scope: string, peerId: string, stream: MediaStream | null): void;
  onState(snapshot: GroupVoiceSnapshot): void;
};

export class GroupVoice {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionByPeerScope = new Map<string, string>();
  private readonly earlyIce = new Map<string, { peerId: string; candidates: RTCIceCandidateInit[] }>();
  private readonly worldStates = new Map<string, WorldVoiceState>();
  private readonly worldSeen = new Map<string, number>();
  private callbacks?: Callbacks;
  private localPeerId = '';
  private localNick = '';
  private localNickColor = '#35d07f';
  private localWorld?: WorldVoiceState;
  private roomScope?: string;
  private localStream?: MediaStream;
  private ticker?: number;
  private error?: string;

  start(localPeerId: string, nick: string, nickColor: string, callbacks: Callbacks): void {
    this.stop();
    this.localPeerId = localPeerId;
    this.localNick = nick;
    this.localNickColor = nickColor;
    this.callbacks = callbacks;
    this.ticker = window.setInterval(() => this.tick(), 250);
    this.emit();
  }

  stop(): void {
    if (this.localWorld) this.publishIdle(this.localWorld);
    if (this.roomScope) this.broadcast({
      connection_id: crypto.randomUUID(), action: 'leave', scope: this.roomScope,
    });
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = undefined;
    for (const session of [...this.sessions.values()]) this.closeSession(session);
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
    this.roomScope = undefined;
    this.localWorld = undefined;
    this.worldStates.clear();
    this.worldSeen.clear();
    this.earlyIce.clear();
    this.error = undefined;
    this.callbacks = undefined;
  }

  snapshot(): GroupVoiceSnapshot {
    const world = this.orderedWorld();
    const speaker = world[0]?.status === 'speaking' ? world[0] : undefined;
    return {
      world,
      speaker,
      localWorld: this.localWorld,
      canStartWorld: Boolean(this.localWorld?.status === 'queued' && world[0]?.peer_id === this.localPeerId && !speaker),
      secondsLeft: speaker?.speaking_until ? Math.max(0, Math.ceil((speaker.speaking_until - Date.now()) / 1_000)) : 0,
      roomScope: this.roomScope,
      roomActive: Boolean(this.roomScope && this.localStream),
      roomPeers: [...this.sessions.values()].filter(session => session.scope === this.roomScope).length,
      error: this.error,
    };
  }

  async requestWorldTurn(): Promise<void> {
    if (this.localWorld) return;
    this.error = undefined;
    const joinedAt = Date.now();
    const state: WorldVoiceState = {
      peer_id: this.localPeerId,
      nick: this.localNick,
      nick_color: this.localNickColor,
      status: 'queued',
      request_id: crypto.randomUUID(),
      joined_at: joinedAt,
    };
    this.localWorld = state;
    this.worldStates.set(this.localPeerId, state);
    this.worldSeen.set(this.localPeerId, Date.now());
    this.callbacks?.publishWorld(this.publicState(state));
    this.emit();
    if (this.snapshot().canStartWorld) await this.startWorldTurn();
  }

  async startWorldTurn(): Promise<void> {
    const queued = this.localWorld;
    if (!queued || queued.status !== 'queued' || !this.snapshot().canStartWorld) return;
    this.error = undefined;
    try {
      const stream = await this.captureMicrophone();
      if (!this.localWorld || this.localWorld.request_id !== queued.request_id) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stopLocalStream();
      this.localStream = stream;
      const speaking: WorldVoiceState = {
        ...queued,
        status: 'speaking',
        speaking_until: Date.now() + WORLD_TURN_MS,
      };
      this.localWorld = speaking;
      this.worldStates.set(this.localPeerId, speaking);
      this.worldSeen.set(this.localPeerId, Date.now());
      this.callbacks?.publishWorld(this.publicState(speaking));
      this.emit();
      window.setTimeout(() => {
        if (this.localWorld?.status !== 'speaking') return;
        for (const peerId of this.callbacks?.peers() ?? []) {
          void this.ensureWorldSpeakerSession(peerId).catch(error => {
            this.error = String(error);
            this.emit();
          });
        }
      }, 250);
    } catch (error) {
      this.stopWorldSessions();
      this.stopLocalStream();
      if (this.localWorld?.request_id === queued.request_id) {
        this.localWorld = { ...queued, status: 'queued', speaking_until: undefined };
        this.worldStates.set(this.localPeerId, this.localWorld);
      }
      this.error = String(error);
      this.emit();
    }
  }

  leaveWorld(): void {
    const current = this.localWorld;
    if (!current) return;
    this.publishIdle(current);
    this.localWorld = undefined;
    this.worldStates.delete(this.localPeerId);
    this.worldSeen.delete(this.localPeerId);
    this.stopWorldSessions();
    this.stopLocalStream();
    this.emit();
  }

  async joinRoom(scope: string): Promise<void> {
    if (scope === 'world') throw new Error('WORLD uses the timed speaking queue.');
    if (this.roomScope === scope && this.localStream) return;
    this.leaveRoom();
    this.error = undefined;
    try {
      this.localStream = await this.captureMicrophone();
      this.roomScope = scope;
      this.broadcast({ connection_id: crypto.randomUUID(), action: 'join', scope, reply: false });
      this.emit();
    } catch (error) {
      this.error = String(error);
      this.emit();
    }
  }

  leaveRoom(): void {
    const scope = this.roomScope;
    if (!scope) return;
    this.broadcast({ connection_id: crypto.randomUUID(), action: 'leave', scope });
    for (const session of [...this.sessions.values()]) {
      if (session.scope === scope) this.closeSession(session);
    }
    this.roomScope = undefined;
    this.stopLocalStream();
    this.emit();
  }

  updateWorldState(state: WorldVoiceState): void {
    if (state.peer_id === this.localPeerId) return;
    if (state.status === 'idle') {
      this.worldStates.delete(state.peer_id);
      this.worldSeen.delete(state.peer_id);
    } else {
      this.worldStates.set(state.peer_id, state);
      this.worldSeen.set(state.peer_id, Date.now());
    }
    this.emit();
  }

  peerOnline(peerId: string): void {
    if (this.roomScope && this.localStream) {
      this.callbacks?.sendSignal(peerId, {
        connection_id: crypto.randomUUID(), action: 'join', scope: this.roomScope, reply: false,
      });
    }
    if (this.localWorld?.status === 'speaking') {
      window.setTimeout(() => {
        void this.ensureWorldSpeakerSession(peerId).catch(error => {
          this.error = String(error);
          this.emit();
        });
      }, 250);
    }
  }

  peerOffline(peerId: string): void {
    this.worldStates.delete(peerId);
    this.worldSeen.delete(peerId);
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) this.closeSession(session);
    }
    this.emit();
  }

  async handleSignal(peerId: string, signal: VoiceSignal): Promise<void> {
    if (signal.action === 'join') {
      if (!this.roomScope || signal.scope !== this.roomScope || !this.localStream) return;
      if (!signal.reply) this.callbacks?.sendSignal(peerId, {
        connection_id: crypto.randomUUID(), action: 'join', scope: signal.scope, reply: true,
      });
      if (this.localPeerId.localeCompare(peerId) < 0) await this.ensureRoomSession(peerId, signal.scope);
      return;
    }
    if (signal.action === 'leave' || signal.action === 'hangup') {
      for (const session of [...this.sessions.values()]) {
        if (session.peerId === peerId && session.scope === signal.scope) this.closeSession(session);
      }
      return;
    }
    let session = this.sessions.get(signal.connection_id);
    if (signal.action === 'ice' && signal.candidate && !session) {
      const queued = this.earlyIce.get(signal.connection_id);
      if (queued && queued.peerId !== peerId) return;
      const candidates = queued?.candidates ?? [];
      if (candidates.length >= 32 || this.earlyIce.size >= MAX_GROUP_SESSIONS) return;
      candidates.push({ candidate: signal.candidate, sdpMid: signal.sdp_mid, sdpMLineIndex: signal.sdp_mline_index });
      this.earlyIce.set(signal.connection_id, { peerId, candidates });
      return;
    }
    if (signal.action === 'offer') {
      if (!signal.sdp || !this.mayReceiveOffer(peerId, signal.scope)) return;
      if (!session) session = this.createSession(signal.connection_id, peerId, signal.scope, signal.scope !== 'world');
      if (session.peerId !== peerId || session.scope !== signal.scope) return;
      await session.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await this.flushIce(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      this.callbacks?.sendSignal(peerId, {
        connection_id: session.id, action: 'answer', scope: session.scope, sdp: answer.sdp ?? '',
      });
      return;
    }
    if (!session || session.peerId !== peerId || session.scope !== signal.scope) return;
    if (signal.action === 'answer' && signal.sdp) {
      await session.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.flushIce(session);
    } else if (signal.action === 'ice' && signal.candidate) {
      const candidate = { candidate: signal.candidate, sdpMid: signal.sdp_mid, sdpMLineIndex: signal.sdp_mline_index };
      if (session.pc.remoteDescription) await session.pc.addIceCandidate(candidate);
      else session.pendingIce.push(candidate);
    }
  }

  private mayReceiveOffer(peerId: string, scope: string): boolean {
    if (scope === 'world') return this.snapshot().speaker?.peer_id === peerId;
    return this.roomScope === scope && Boolean(this.localStream);
  }

  private async ensureWorldSpeakerSession(peerId: string): Promise<void> {
    if (!this.localStream || this.localWorld?.status !== 'speaking' || peerId === this.localPeerId) return;
    await this.ensureSession(peerId, 'world', true);
  }

  private async ensureRoomSession(peerId: string, scope: string): Promise<void> {
    if (!this.localStream || this.roomScope !== scope || peerId === this.localPeerId) return;
    await this.ensureSession(peerId, scope, true);
  }

  private async ensureSession(peerId: string, scope: string, initiator: boolean): Promise<void> {
    const key = `${scope}\u0000${peerId}`;
    if (this.sessionByPeerScope.has(key)) return;
    const session = this.createSession(crypto.randomUUID(), peerId, scope, initiator);
    if (!initiator) return;
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    this.callbacks?.sendSignal(peerId, {
      connection_id: session.id, action: 'offer', scope, sdp: offer.sdp ?? '',
    });
  }

  private createSession(id: string, peerId: string, scope: string, addLocalAudio: boolean): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    if (this.sessions.size >= MAX_GROUP_SESSIONS) throw new Error('Too many active group voice connections.');
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const early = this.earlyIce.get(id);
    if (early?.peerId === peerId) this.earlyIce.delete(id);
    const session: Session = {
      id, peerId, scope, pc,
      pendingIce: early?.peerId === peerId ? early.candidates : [],
      closed: false,
    };
    this.sessions.set(id, session);
    this.sessionByPeerScope.set(`${scope}\u0000${peerId}`, id);
    if (addLocalAudio) this.localStream?.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    pc.onicecandidate = event => {
      if (!event.candidate || session.closed) return;
      const candidate = event.candidate.toJSON();
      this.callbacks?.sendSignal(peerId, {
        connection_id: id,
        action: 'ice',
        scope,
        candidate: candidate.candidate,
        sdp_mid: candidate.sdpMid,
        sdp_mline_index: candidate.sdpMLineIndex,
      });
    };
    pc.ontrack = event => {
      this.callbacks?.onRemoteStream(scope, peerId, event.streams[0] ?? new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = () => {
      if (session.closed) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closeSession(session);
    };
    return session;
  }

  private async flushIce(session: Session): Promise<void> {
    for (const candidate of session.pendingIce.splice(0)) await session.pc.addIceCandidate(candidate);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    session.pc.close();
    this.sessions.delete(session.id);
    this.sessionByPeerScope.delete(`${session.scope}\u0000${session.peerId}`);
    this.callbacks?.onRemoteStream(session.scope, session.peerId, null);
  }

  private orderedWorld(): WorldVoiceState[] {
    const now = Date.now();
    for (const [peerId, state] of this.worldStates) {
      if (state.status === 'idle'
        || (state.status === 'speaking' && (state.speaking_until ?? 0) <= now)
        || (peerId !== this.localPeerId && now - (this.worldSeen.get(peerId) ?? 0) > 75_000)) {
        this.worldStates.delete(peerId);
        this.worldSeen.delete(peerId);
      }
    }
    return [...this.worldStates.values()].sort((a, b) => a.joined_at - b.joined_at || a.peer_id.localeCompare(b.peer_id));
  }

  private tick(): void {
    if (this.localWorld?.status === 'speaking'
      && (this.localWorld.speaking_until ?? 0) <= Date.now()) this.leaveWorld();
    else {
      const speakerId = this.snapshot().speaker?.peer_id;
      for (const session of [...this.sessions.values()]) {
        if (session.scope === 'world' && session.peerId !== speakerId) this.closeSession(session);
      }
      this.emit();
    }
  }

  private publicState(state: WorldVoiceState): Omit<WorldVoiceState, 'peer_id' | 'nick' | 'nick_color'> {
    return {
      status: state.status,
      request_id: state.request_id,
      joined_at: state.joined_at,
      speaking_until: state.speaking_until,
    };
  }

  private publishIdle(state: WorldVoiceState): void {
    this.callbacks?.publishWorld({
      status: 'idle', request_id: state.request_id, joined_at: state.joined_at,
    });
  }

  private broadcast(signal: VoiceSignal): void {
    for (const peerId of this.callbacks?.peers() ?? []) {
      try { this.callbacks?.sendSignal(peerId, signal); } catch {}
    }
  }

  private stopWorldSessions(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.scope === 'world') {
        try { this.callbacks?.sendSignal(session.peerId, { connection_id: session.id, action: 'hangup', scope: 'world' }); } catch {}
        this.closeSession(session);
      }
    }
  }

  private stopLocalStream(): void {
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
  }

  private async captureMicrophone(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0 || tracks.every(track => track.readyState === 'ended')) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('Nie udało się uruchomić aktywnego mikrofonu.');
    }
    tracks.forEach(track => { track.enabled = true; });
    return stream;
  }

  private emit(): void {
    this.callbacks?.onState(this.snapshot());
  }
}
