import type { VoiceSignal, WorldVoiceState } from './world-relay';
import { RTC_CONFIG } from './rtc-config.ts';
import { t } from './i18n.ts';

const WORLD_TURN_MS = 60_000;
const MAX_GROUP_SESSIONS = 32;
const PENDING_WORLD_OFFER_TTL_MS = 15_000;
const MAX_PENDING_WORLD_OFFERS = 32;
const WORLD_RELEASE_TOMBSTONE_MS = 75_000;
const MAX_RELEASED_WORLD_REQUESTS = 256;
const ROOM_MEMBERSHIP_TOMBSTONE_MS = 75_000;
const MAX_RELEASED_ROOM_MEMBERSHIPS = 256;
const ICE_GATHER_TIMEOUT_MS = 5_000;
const VOICE_CONNECT_TIMEOUT_MS = 25_000;
const VOICE_DISCONNECT_GRACE_MS = 8_000;
const OFFER_RETRY_DELAY_MS = 750;
const OFFER_RETRY_COUNT = 2;
const WORLD_CONTENTION_DELAY_MS = 1_250;
const ROOM_JOIN_BURST_INTERVALS_MS = [1_000, 2_000] as const;
const ROOM_JOIN_HEARTBEAT_MS = 30_000;
const SESSION_RECOVERY_BACKOFF_MS = [1_000, 4_000, 12_000] as const;
const MAX_SESSION_RECOVERY_STARTS_PER_TICK = 2;
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
  connectTimer?: number;
  disconnectTimer?: number;
  offerRetryTimer?: number;
  answerInFlight?: Promise<void>;
  recoveryGeneration?: string;
};

type SessionRecovery = {
  peerId: string;
  scope: string;
  generation: string;
  attempts: number;
  nextAt: number;
};

type PendingWorldOffer = {
  peerId: string;
  signal: VoiceSignal;
  receivedAt: number;
};

type RoomMembership = {
  id: string;
  epoch?: string;
  generation?: number;
};

async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete' || typeof pc.addEventListener !== 'function') return;
  await new Promise<void>(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onState);
    onState();
  });
}

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
  beforeMicrophoneCapture?(): void;
  onRemoteStream(scope: string, peerId: string, stream: MediaStream | null): void;
  onState(snapshot: GroupVoiceSnapshot): void;
};

export class GroupVoice {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionByPeerScope = new Map<string, string>();
  private readonly earlyIce = new Map<string, { peerId: string; candidates: RTCIceCandidateInit[] }>();
  private readonly pendingWorldOffers = new Map<string, PendingWorldOffer>();
  private readonly worldStates = new Map<string, WorldVoiceState>();
  private readonly worldSeen = new Map<string, number>();
  private readonly releasedWorldRequests = new Map<string, number>();
  private readonly remoteRoomMemberships = new Map<string, RoomMembership>();
  private readonly releasedRoomMemberships = new Map<string, number>();
  private readonly sessionRecoveries = new Map<string, SessionRecovery>();
  private callbacks?: Callbacks;
  private localPeerId = '';
  private localNick = '';
  private localNickColor = '#35d07f';
  private localWorld?: WorldVoiceState;
  private roomScope?: string;
  private roomMembershipId?: string;
  private roomMembershipEpoch = '';
  private roomMembershipGeneration = 0;
  private localStream?: MediaStream;
  private ticker?: number;
  private error?: string;
  private mediaEpoch = 0;
  private roomJoinPhase = 0;
  private nextRoomJoinAt = 0;
  private worldContentionUntil = 0;
  private worldStartInFlight?: string;
  private worldAutoStartEligible = false;

  start(localPeerId: string, nick: string, nickColor: string, callbacks: Callbacks): void {
    this.stop();
    this.localPeerId = localPeerId;
    this.localNick = nick;
    this.localNickColor = nickColor;
    this.roomMembershipEpoch = crypto.randomUUID();
    this.roomMembershipGeneration = 0;
    this.callbacks = callbacks;
    this.ticker = window.setInterval(() => this.tick(), 250);
    this.emit();
  }

  stop(): void {
    this.mediaEpoch += 1;
    if (this.localWorld) this.publishWorldRelease(this.localWorld);
    if (this.roomScope) this.broadcast({
      connection_id: crypto.randomUUID(), action: 'leave', scope: this.roomScope,
      ...this.localRoomMembershipSignal(),
    });
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = undefined;
    for (const session of [...this.sessions.values()]) this.closeSession(session);
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
    this.roomScope = undefined;
    this.roomMembershipId = undefined;
    this.localWorld = undefined;
    this.worldStates.clear();
    this.worldSeen.clear();
    this.releasedWorldRequests.clear();
    this.remoteRoomMemberships.clear();
    this.releasedRoomMemberships.clear();
    this.sessionRecoveries.clear();
    this.earlyIce.clear();
    this.pendingWorldOffers.clear();
    this.roomJoinPhase = 0;
    this.nextRoomJoinAt = 0;
    this.worldContentionUntil = 0;
    this.worldStartInFlight = undefined;
    this.worldAutoStartEligible = false;
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
    this.worldContentionUntil = Date.now() + WORLD_CONTENTION_DELAY_MS;
    this.worldAutoStartEligible = true;
    this.callbacks?.publishWorld(this.publicState(state));
    this.emit();
  }

  async startWorldTurn(): Promise<void> {
    const queued = this.localWorld;
    if (!queued
      || queued.status !== 'queued'
      || !this.snapshot().canStartWorld
      || Date.now() < this.worldContentionUntil
      || this.worldStartInFlight === queued.request_id) return;
    this.worldStartInFlight = queued.request_id;
    this.leaveRoom();
    const mediaEpoch = ++this.mediaEpoch;
    this.error = undefined;
    try {
      this.callbacks?.beforeMicrophoneCapture?.();
      const stream = await this.captureMicrophone();
      if (mediaEpoch !== this.mediaEpoch
        || !this.localWorld
        || this.localWorld.request_id !== queued.request_id
        || !this.snapshot().canStartWorld) {
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
      this.worldAutoStartEligible = false;
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
      if (mediaEpoch !== this.mediaEpoch) return;
      this.stopWorldSessions();
      this.stopLocalStream();
      if (this.localWorld?.request_id === queued.request_id) {
        this.localWorld = { ...queued, status: 'queued', speaking_until: undefined };
        this.worldStates.set(this.localPeerId, this.localWorld);
        this.worldAutoStartEligible = false;
      }
      this.error = String(error);
      this.emit();
    } finally {
      if (this.worldStartInFlight === queued.request_id) this.worldStartInFlight = undefined;
    }
  }

  leaveWorld(): void {
    const current = this.localWorld;
    if (!current) return;
    this.mediaEpoch += 1;
    this.publishWorldRelease(current);
    this.localWorld = undefined;
    this.worldContentionUntil = 0;
    this.worldStartInFlight = undefined;
    this.worldAutoStartEligible = false;
    this.worldStates.delete(this.localPeerId);
    this.worldSeen.delete(this.localPeerId);
    this.stopWorldSessions();
    this.clearSessionRecoveriesForScope('world');
    this.pendingWorldOffers.clear();
    this.stopLocalStream();
    this.emit();
  }

  async joinRoom(scope: string): Promise<void> {
    if (scope === 'world') throw new Error('WORLD uses the timed speaking queue.');
    if (this.roomScope === scope && this.localStream) return;
    this.leaveWorld();
    this.leaveRoom();
    const mediaEpoch = ++this.mediaEpoch;
    this.error = undefined;
    try {
      this.callbacks?.beforeMicrophoneCapture?.();
      const stream = await this.captureMicrophone();
      if (mediaEpoch !== this.mediaEpoch || this.localWorld) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stopLocalStream();
      this.localStream = stream;
      this.roomScope = scope;
      this.roomMembershipId = crypto.randomUUID();
      this.roomMembershipGeneration += 1;
      this.announceRoomMembership();
      this.roomJoinPhase = 0;
      this.nextRoomJoinAt = Date.now() + ROOM_JOIN_BURST_INTERVALS_MS[0];
      this.emit();
    } catch (error) {
      if (mediaEpoch !== this.mediaEpoch) return;
      this.error = String(error);
      this.emit();
    }
  }

  leaveRoom(): void {
    const scope = this.roomScope;
    if (!scope) return;
    this.mediaEpoch += 1;
    this.broadcast({
      connection_id: crypto.randomUUID(), action: 'leave', scope,
      ...this.localRoomMembershipSignal(),
    });
    for (const session of [...this.sessions.values()]) {
      if (session.scope === scope) this.closeSession(session);
    }
    this.clearSessionRecoveriesForScope(scope);
    this.roomScope = undefined;
    this.roomMembershipId = undefined;
    this.roomJoinPhase = 0;
    this.nextRoomJoinAt = 0;
    this.deleteRemoteRoomMembershipsForScope(scope);
    this.stopLocalStream();
    this.emit();
  }

  updateWorldState(state: WorldVoiceState): void {
    if (state.peer_id === this.localPeerId) return;
    this.pruneReleasedWorldRequests();
    const requestKey = this.worldOfferKey(state.peer_id, state.request_id);
    const current = this.worldStates.get(state.peer_id);
    if (state.status === 'idle') {
      this.rememberWorldRelease(state.peer_id, state.request_id);
      this.pendingWorldOffers.delete(requestKey);
      if (!current || current.request_id !== state.request_id) return;
      this.worldStates.delete(state.peer_id);
      this.worldSeen.delete(state.peer_id);
    } else {
      if (this.releasedWorldRequests.has(requestKey)) return;
      if (current?.request_id === state.request_id
        && current.status === 'speaking'
        && state.status === 'queued') return;
      if (current?.request_id !== state.request_id
        && current
        && state.joined_at <= current.joined_at) return;
      this.worldStates.set(state.peer_id, state);
      this.worldSeen.set(state.peer_id, Date.now());
    }
    this.emit();
    if (state.status === 'speaking') this.replayPendingWorldOffer(state);
  }

  peerOnline(peerId: string): void {
    if (this.roomScope && this.localStream) {
      this.callbacks?.sendSignal(peerId, {
        connection_id: crypto.randomUUID(), action: 'join', scope: this.roomScope,
        ...this.localRoomMembershipSignal(), reply: false,
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
    this.deletePendingWorldOffersForPeer(peerId);
    this.deleteReleasedWorldRequestsForPeer(peerId);
    this.deleteRoomMembershipsForPeer(peerId);
    this.clearSessionRecoveriesForPeer(peerId);
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) this.closeSession(session);
    }
    this.emit();
  }

  reportSignalError(error: unknown): void {
    this.error = String(error);
    this.emit();
  }

  async handleSignal(peerId: string, signal: VoiceSignal): Promise<void> {
    if (signal.action === 'world_release') {
      if (signal.request_id) {
        const requestKey = this.worldOfferKey(peerId, signal.request_id);
        this.rememberWorldRelease(peerId, signal.request_id);
        this.pendingWorldOffers.delete(requestKey);
      }
      const state = this.worldStates.get(peerId);
      if (state && state.request_id !== signal.request_id) return;
      this.worldStates.delete(peerId);
      this.worldSeen.delete(peerId);
      for (const session of [...this.sessions.values()]) {
        if (session.peerId === peerId && session.scope === 'world') this.closeSession(session);
      }
      this.emit();
      return;
    }
    if (signal.action === 'join') {
      if (!this.roomScope || signal.scope !== this.roomScope || !this.localStream) return;
      if (!this.acceptRoomMembership(peerId, signal.scope, signal)) return;
      if (!signal.reply) this.callbacks?.sendSignal(peerId, {
        connection_id: crypto.randomUUID(), action: 'join', scope: signal.scope,
        ...this.localRoomMembershipSignal(), reply: true,
      });
      if (this.localPeerId.localeCompare(peerId) < 0) await this.ensureRoomSession(peerId, signal.scope);
      return;
    }
    if (signal.action === 'leave') {
      if (signal.scope === 'world') return;
      const membershipKey = this.roomMembershipKey(peerId, signal.scope);
      const currentMembership = this.remoteRoomMemberships.get(membershipKey);
      const releasedMembership = this.roomMembershipFromSignal(signal);
      if (releasedMembership) {
        this.rememberRoomMembershipRelease(peerId, signal.scope, releasedMembership.id);
        if (!currentMembership || !this.sameRoomMembership(currentMembership, releasedMembership)) return;
        this.remoteRoomMemberships.delete(membershipKey);
      } else if (currentMembership) {
        // A legacy, unbound leave must not close a newer membership-aware join.
        return;
      }
      for (const session of [...this.sessions.values()]) {
        if (session.peerId === peerId && session.scope === signal.scope) this.closeSession(session);
      }
      this.clearSessionRecovery(peerId, signal.scope);
      return;
    }
    if (signal.action === 'hangup') {
      const session = this.sessions.get(signal.connection_id);
      if (session?.peerId === peerId && session.scope === signal.scope) {
        this.closeSession(session);
        this.scheduleSessionRecovery(session);
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
      if (!signal.sdp) return;
      if (signal.scope === 'world' && !this.mayReceiveWorldOffer(peerId, signal)) {
        this.deferWorldOffer(peerId, signal);
        return;
      }
      if (signal.scope !== 'world' && !this.mayReceiveOffer(signal.scope)) return;
      if (signal.scope !== 'world'
        && !this.acceptRoomMembership(peerId, signal.scope, signal)) return;
      if (!session) session = this.createSession(
        signal.connection_id,
        peerId,
        signal.scope,
        signal.scope !== 'world',
        this.localGenerationForScope(signal.scope),
      );
      if (session.peerId !== peerId || session.scope !== signal.scope) return;
      if (session.answerInFlight) {
        try { await session.answerInFlight; } catch { return; }
        if (!session.closed && session.pc.localDescription?.type === 'answer') {
          this.callbacks?.sendSignal(peerId, {
            connection_id: session.id,
            action: 'answer',
            scope: session.scope,
            sdp: session.pc.localDescription.sdp ?? '',
          });
        }
        return;
      }
      if (session.pc.remoteDescription?.type === 'offer'
        && session.pc.remoteDescription.sdp === signal.sdp
        && session.pc.localDescription?.type === 'answer') {
        this.callbacks?.sendSignal(peerId, {
          connection_id: session.id,
          action: 'answer',
          scope: session.scope,
          sdp: session.pc.localDescription.sdp ?? '',
        });
        return;
      }
      const answering = (async () => {
        await session.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp! });
        await this.flushIce(session);
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        await waitForIceGathering(session.pc);
        if (session.closed) return;
        this.callbacks?.sendSignal(peerId, {
          connection_id: session.id,
          action: 'answer',
          scope: session.scope,
          sdp: session.pc.localDescription?.sdp ?? answer.sdp ?? '',
        });
      })();
      session.answerInFlight = answering;
      try { await answering; } finally {
        if (session.answerInFlight === answering) session.answerInFlight = undefined;
      }
      return;
    }
    if (!session || session.peerId !== peerId || session.scope !== signal.scope) return;
    if (signal.action === 'answer' && signal.sdp) {
      if (session.pc.remoteDescription?.type === 'answer') return;
      await session.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
      session.offerRetryTimer = undefined;
      await this.flushIce(session);
    } else if (signal.action === 'ice' && signal.candidate) {
      const candidate = { candidate: signal.candidate, sdpMid: signal.sdp_mid, sdpMLineIndex: signal.sdp_mline_index };
      if (session.pc.remoteDescription) {
        try { await session.pc.addIceCandidate(candidate); } catch {}
      }
      else session.pendingIce.push(candidate);
    }
  }

  private mayReceiveOffer(scope: string): boolean {
    return this.roomScope === scope && Boolean(this.localStream);
  }

  private mayReceiveWorldOffer(peerId: string, signal: VoiceSignal): boolean {
    const speaker = this.snapshot().speaker;
    return Boolean(signal.request_id
      && speaker?.peer_id === peerId
      && speaker.request_id === signal.request_id);
  }

  private deferWorldOffer(peerId: string, signal: VoiceSignal): void {
    if (!signal.request_id || signal.request_id.length > 64) return;
    this.prunePendingWorldOffers();
    const key = this.worldOfferKey(peerId, signal.request_id);
    if (!this.pendingWorldOffers.has(key)
      && this.pendingWorldOffers.size >= MAX_PENDING_WORLD_OFFERS) {
      const oldest = [...this.pendingWorldOffers.entries()]
        .sort((a, b) => a[1].receivedAt - b[1].receivedAt)[0]?.[0];
      if (oldest) this.pendingWorldOffers.delete(oldest);
    }
    this.pendingWorldOffers.set(key, { peerId, signal, receivedAt: Date.now() });
  }

  private replayPendingWorldOffer(state: WorldVoiceState): void {
    this.prunePendingWorldOffers();
    const key = this.worldOfferKey(state.peer_id, state.request_id);
    const pending = this.pendingWorldOffers.get(key);
    if (!pending) return;
    this.deletePendingWorldOffersForPeer(state.peer_id);
    void this.handleSignal(pending.peerId, pending.signal).catch(error => {
      this.error = String(error);
      this.emit();
    });
  }

  private prunePendingWorldOffers(now = Date.now()): void {
    for (const [key, pending] of this.pendingWorldOffers) {
      if (now - pending.receivedAt > PENDING_WORLD_OFFER_TTL_MS) {
        this.pendingWorldOffers.delete(key);
      }
    }
  }

  private worldOfferKey(peerId: string, requestId: string): string {
    return `${peerId}\u0000${requestId}`;
  }

  private deletePendingWorldOffersForPeer(peerId: string): void {
    for (const [key, pending] of this.pendingWorldOffers) {
      if (pending.peerId === peerId) this.pendingWorldOffers.delete(key);
    }
  }

  private deleteReleasedWorldRequestsForPeer(peerId: string): void {
    const prefix = `${peerId}\u0000`;
    for (const key of this.releasedWorldRequests.keys()) {
      if (key.startsWith(prefix)) this.releasedWorldRequests.delete(key);
    }
  }

  private pruneReleasedWorldRequests(now = Date.now()): void {
    for (const [key, releasedAt] of this.releasedWorldRequests) {
      if (now - releasedAt > WORLD_RELEASE_TOMBSTONE_MS) this.releasedWorldRequests.delete(key);
    }
  }

  private rememberWorldRelease(peerId: string, requestId: string, now = Date.now()): void {
    this.pruneReleasedWorldRequests(now);
    this.releasedWorldRequests.set(this.worldOfferKey(peerId, requestId), now);
    while (this.releasedWorldRequests.size > MAX_RELEASED_WORLD_REQUESTS) {
      const oldest = [...this.releasedWorldRequests.entries()]
        .sort((a, b) => a[1] - b[1])[0]?.[0];
      if (!oldest) break;
      this.releasedWorldRequests.delete(oldest);
    }
  }

  private validMembershipId(value: string | undefined): value is string {
    return typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private localRoomMembershipSignal(): Pick<
  VoiceSignal,
  'request_id' | 'membership_epoch' | 'membership_generation'
  > {
    return {
      request_id: this.roomMembershipId,
      membership_epoch: this.roomMembershipEpoch || undefined,
      membership_generation: this.roomMembershipGeneration || undefined,
    };
  }

  private roomMembershipFromSignal(signal: VoiceSignal): RoomMembership | undefined {
    if (!this.validMembershipId(signal.request_id)) return undefined;
    if (this.validMembershipId(signal.membership_epoch)
      && Number.isSafeInteger(signal.membership_generation)
      && Number(signal.membership_generation) >= 1) {
      return {
        id: signal.request_id,
        epoch: signal.membership_epoch,
        generation: Number(signal.membership_generation),
      };
    }
    return { id: signal.request_id };
  }

  private sameRoomMembership(left: RoomMembership, right: RoomMembership): boolean {
    if (left.id !== right.id) return false;
    if (left.epoch === undefined || right.epoch === undefined) return true;
    return left.epoch === right.epoch && left.generation === right.generation;
  }

  private roomMembershipKey(peerId: string, scope: string): string {
    return `${scope}\u0000${peerId}`;
  }

  private roomMembershipReleaseKey(peerId: string, scope: string, membershipId: string): string {
    return `${scope}\u0000${peerId}\u0000${membershipId}`;
  }

  private acceptRoomMembership(peerId: string, scope: string, signal: VoiceSignal): boolean {
    const key = this.roomMembershipKey(peerId, scope);
    const incoming = this.roomMembershipFromSignal(signal);
    if (!incoming) {
      // Preserve compatibility with older clients, but never allow an
      // unbound legacy offer to replace a membership-aware connection.
      return !this.remoteRoomMemberships.has(key);
    }
    this.pruneReleasedRoomMemberships();
    if (this.releasedRoomMemberships.has(this.roomMembershipReleaseKey(peerId, scope, incoming.id))) {
      return false;
    }
    const current = this.remoteRoomMemberships.get(key);
    if (current && this.sameRoomMembership(current, incoming)) return true;
    if (current?.epoch !== undefined && current.generation !== undefined) {
      if (incoming.epoch === undefined || incoming.generation === undefined) return false;
      if (current.epoch === incoming.epoch && incoming.generation <= current.generation) return false;
    }
    if (current) this.rememberRoomMembershipRelease(peerId, scope, current.id);
    this.clearSessionRecovery(peerId, scope);
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId && session.scope === scope) this.closeSession(session);
    }
    this.remoteRoomMemberships.set(key, incoming);
    return true;
  }

  private rememberRoomMembershipRelease(
    peerId: string,
    scope: string,
    membershipId: string,
    now = Date.now(),
  ): void {
    this.pruneReleasedRoomMemberships(now);
    this.releasedRoomMemberships.set(
      this.roomMembershipReleaseKey(peerId, scope, membershipId),
      now,
    );
    while (this.releasedRoomMemberships.size > MAX_RELEASED_ROOM_MEMBERSHIPS) {
      const oldest = [...this.releasedRoomMemberships.entries()]
        .sort((a, b) => a[1] - b[1])[0]?.[0];
      if (!oldest) break;
      this.releasedRoomMemberships.delete(oldest);
    }
  }

  private pruneReleasedRoomMemberships(now = Date.now()): void {
    for (const [key, releasedAt] of this.releasedRoomMemberships) {
      if (now - releasedAt > ROOM_MEMBERSHIP_TOMBSTONE_MS) {
        this.releasedRoomMemberships.delete(key);
      }
    }
  }

  private deleteRemoteRoomMembershipsForScope(scope: string): void {
    const prefix = `${scope}\u0000`;
    for (const key of this.remoteRoomMemberships.keys()) {
      if (key.startsWith(prefix)) this.remoteRoomMemberships.delete(key);
    }
  }

  private deleteRoomMembershipsForPeer(peerId: string): void {
    for (const [key] of this.remoteRoomMemberships) {
      if (key.endsWith(`\u0000${peerId}`)) this.remoteRoomMemberships.delete(key);
    }
    const marker = `\u0000${peerId}\u0000`;
    for (const key of this.releasedRoomMemberships.keys()) {
      if (key.includes(marker)) this.releasedRoomMemberships.delete(key);
    }
  }

  private async ensureWorldSpeakerSession(peerId: string): Promise<void> {
    if (!this.localStream || this.localWorld?.status !== 'speaking' || peerId === this.localPeerId) return;
    await this.ensureSession(
      peerId,
      'world',
      true,
      this.localWorld.request_id,
      this.localGenerationForScope('world'),
    );
  }

  private async ensureRoomSession(peerId: string, scope: string): Promise<void> {
    if (!this.localStream
      || this.roomScope !== scope
      || peerId === this.localPeerId
      || this.localPeerId.localeCompare(peerId) >= 0) return;
    await this.ensureSession(peerId, scope, true, undefined, this.localGenerationForScope(scope));
  }

  private async ensureSession(
    peerId: string,
    scope: string,
    initiator: boolean,
    requestId?: string,
    recoveryGeneration?: string,
  ): Promise<void> {
    const key = this.sessionRecoveryKey(peerId, scope);
    if (this.sessionByPeerScope.has(key)) return;
    if (initiator && !recoveryGeneration) return;
    const recovery = this.sessionRecoveries.get(key);
    if (recovery) {
      if (recovery.generation !== recoveryGeneration) this.sessionRecoveries.delete(key);
      else if (!this.claimSessionRecovery(recovery)) return;
    }
    let session: Session | undefined;
    try {
      session = this.createSession(
        crypto.randomUUID(),
        peerId,
        scope,
        initiator,
        recoveryGeneration,
      );
      if (!initiator) return;
      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      await waitForIceGathering(session.pc);
      if (session.closed) return;
      const signal: VoiceSignal = {
        connection_id: session.id,
        action: 'offer',
        scope,
        ...(scope === 'world'
          ? { request_id: requestId }
          : this.localRoomMembershipSignal()),
        sdp: session.pc.localDescription?.sdp ?? offer.sdp ?? '',
      };
      this.sendOfferWithRetry(session, signal, OFFER_RETRY_COUNT);
    } catch (error) {
      if (session && !session.closed) this.failSession(session);
      throw error;
    }
  }

  private sendOfferWithRetry(session: Session, signal: VoiceSignal, retriesLeft: number): void {
    if (session.closed || session.pc.remoteDescription?.type === 'answer') return;
    this.callbacks?.sendSignal(session.peerId, signal);
    if (retriesLeft <= 0) return;
    if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
    session.offerRetryTimer = window.setTimeout(() => {
      session.offerRetryTimer = undefined;
      if (session.closed || session.pc.remoteDescription?.type === 'answer') return;
      try { this.sendOfferWithRetry(session, signal, retriesLeft - 1); } catch {}
    }, OFFER_RETRY_DELAY_MS);
  }

  private createSession(
    id: string,
    peerId: string,
    scope: string,
    addLocalAudio: boolean,
    recoveryGeneration?: string,
  ): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const peerScopeKey = `${scope}\u0000${peerId}`;
    const previousId = this.sessionByPeerScope.get(peerScopeKey);
    const previous = previousId ? this.sessions.get(previousId) : undefined;
    if (previous && previous.id !== id) this.closeSession(previous);
    else if (previousId && !previous) this.sessionByPeerScope.delete(peerScopeKey);
    if (this.sessions.size >= MAX_GROUP_SESSIONS) throw new Error('Too many active group voice connections.');
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const early = this.earlyIce.get(id);
    if (early?.peerId === peerId) this.earlyIce.delete(id);
    const session: Session = {
      id, peerId, scope, pc,
      pendingIce: early?.peerId === peerId ? early.candidates : [],
      closed: false,
      recoveryGeneration,
    };
    this.sessions.set(id, session);
    this.sessionByPeerScope.set(peerScopeKey, id);
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
      if (session.closed) return;
      this.callbacks?.onRemoteStream(scope, peerId, event.streams[0] ?? new MediaStream([event.track]));
    };
    const handleConnectionState = () => {
      if (session.closed) return;
      const failed = pc.connectionState === 'failed' || pc.iceConnectionState === 'failed';
      if (failed) {
        this.error = 'Nie udało się zestawić połączenia głosowego WAN.';
        this.emit();
        this.failSession(session);
        return;
      }
      const disconnected = pc.connectionState === 'disconnected'
        || pc.iceConnectionState === 'disconnected';
      if (disconnected) {
        if (session.disconnectTimer === undefined) {
          const timer = window.setTimeout(() => {
            // A cleared timer can still have an already-queued callback. Do
            // not let it close a recovered session or a newer grace window.
            if (session.disconnectTimer !== timer) return;
            session.disconnectTimer = undefined;
            if (session.closed || this.sessions.get(session.id) !== session) return;
            if (session.pc.connectionState !== 'disconnected'
              && session.pc.iceConnectionState !== 'disconnected') return;
            this.error = 'Połączenie głosowe WAN zostało przerwane przez zbyt długi czas.';
            this.emit();
            this.failSession(session);
          }, VOICE_DISCONNECT_GRACE_MS);
          session.disconnectTimer = timer;
        }
        return;
      }
      const connected = pc.connectionState === 'connected'
        || pc.iceConnectionState === 'connected'
        || pc.iceConnectionState === 'completed';
      if (connected) {
        if (session.connectTimer !== undefined) window.clearTimeout(session.connectTimer);
        if (session.disconnectTimer !== undefined) window.clearTimeout(session.disconnectTimer);
        if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
        session.connectTimer = undefined;
        session.disconnectTimer = undefined;
        session.offerRetryTimer = undefined;
        this.clearSessionRecovery(session.peerId, session.scope, session.recoveryGeneration);
      }
      if (pc.connectionState === 'closed') this.closeSession(session);
    };
    pc.onconnectionstatechange = handleConnectionState;
    pc.oniceconnectionstatechange = handleConnectionState;
    session.connectTimer = window.setTimeout(() => {
      if (session.closed || session.pc.connectionState === 'connected') return;
      this.error = 'Przekroczono czas zestawiania połączenia głosowego WAN.';
      this.emit();
      this.failSession(session);
    }, VOICE_CONNECT_TIMEOUT_MS);
    return session;
  }

  private async flushIce(session: Session): Promise<void> {
    for (const candidate of session.pendingIce.splice(0)) {
      if (session.closed) return;
      try { await session.pc.addIceCandidate(candidate); } catch {}
    }
  }

  private sessionRecoveryKey(peerId: string, scope: string): string {
    return `${scope}\u0000${peerId}`;
  }

  private localGenerationForScope(scope: string): string | undefined {
    if (scope === 'world') {
      return this.localWorld?.status === 'speaking'
        ? `world:${this.localWorld.request_id}`
        : undefined;
    }
    if (this.roomScope !== scope || !this.roomMembershipId || !this.localStream) return undefined;
    return `room:${this.roomMembershipEpoch}:${this.roomMembershipGeneration}:${this.roomMembershipId}`;
  }

  private isSessionRecoveryValid(recovery: SessionRecovery): boolean {
    if (recovery.generation !== this.localGenerationForScope(recovery.scope)) return false;
    if (recovery.scope === 'world') {
      return this.localWorld?.status === 'speaking'
        && (this.callbacks?.peers() ?? []).includes(recovery.peerId);
    }
    return this.roomScope === recovery.scope
      && this.localPeerId.localeCompare(recovery.peerId) < 0
      && this.remoteRoomMemberships.has(this.roomMembershipKey(recovery.peerId, recovery.scope));
  }

  private claimSessionRecovery(recovery: SessionRecovery, now = Date.now()): boolean {
    if (!this.isSessionRecoveryValid(recovery)
      || recovery.attempts >= SESSION_RECOVERY_BACKOFF_MS.length
      || now < recovery.nextAt) return false;
    recovery.attempts += 1;
    recovery.nextAt = Number.POSITIVE_INFINITY;
    return true;
  }

  private scheduleSessionRecovery(session: Session, now = Date.now()): void {
    const generation = session.recoveryGeneration;
    if (!generation) return;
    const key = this.sessionRecoveryKey(session.peerId, session.scope);
    const current = this.sessionRecoveries.get(key);
    const recovery: SessionRecovery = current?.generation === generation
      ? current
      : { peerId: session.peerId, scope: session.scope, generation, attempts: 0, nextAt: 0 };
    if (!this.isSessionRecoveryValid(recovery)) {
      this.sessionRecoveries.delete(key);
      return;
    }
    if (recovery.attempts >= SESSION_RECOVERY_BACKOFF_MS.length) {
      recovery.nextAt = Number.POSITIVE_INFINITY;
    } else {
      const jitter = [...session.peerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 251;
      const scheduledAt = now + SESSION_RECOVERY_BACKOFF_MS[recovery.attempts] + jitter;
      recovery.nextAt = current?.generation === generation && Number.isFinite(recovery.nextAt)
        ? Math.min(recovery.nextAt, scheduledAt)
        : scheduledAt;
    }
    this.sessionRecoveries.set(key, recovery);
  }

  private clearSessionRecovery(peerId: string, scope: string, generation?: string): void {
    const key = this.sessionRecoveryKey(peerId, scope);
    const recovery = this.sessionRecoveries.get(key);
    if (!recovery || (generation && recovery.generation !== generation)) return;
    this.sessionRecoveries.delete(key);
  }

  private clearSessionRecoveriesForPeer(peerId: string): void {
    for (const [key, recovery] of this.sessionRecoveries) {
      if (recovery.peerId === peerId) this.sessionRecoveries.delete(key);
    }
  }

  private clearSessionRecoveriesForScope(scope: string): void {
    for (const [key, recovery] of this.sessionRecoveries) {
      if (recovery.scope === scope) this.sessionRecoveries.delete(key);
    }
  }

  private failSession(session: Session): void {
    if (session.closed) return;
    try {
      this.callbacks?.sendSignal(session.peerId, {
        connection_id: session.id,
        action: 'hangup',
        scope: session.scope,
      });
    } catch {}
    this.closeSession(session);
    this.scheduleSessionRecovery(session);
  }

  private drainSessionRecoveries(now = Date.now()): void {
    let starts = 0;
    for (const [key, recovery] of this.sessionRecoveries) {
      if (!this.isSessionRecoveryValid(recovery)) {
        this.sessionRecoveries.delete(key);
        continue;
      }
      if (starts >= MAX_SESSION_RECOVERY_STARTS_PER_TICK
        || recovery.attempts >= SESSION_RECOVERY_BACKOFF_MS.length
        || recovery.nextAt > now) continue;
      starts += 1;
      const attempt = recovery.scope === 'world'
        ? this.ensureWorldSpeakerSession(recovery.peerId)
        : this.ensureRoomSession(recovery.peerId, recovery.scope);
      void attempt.catch(error => {
        this.error = String(error);
        this.emit();
      });
    }
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.connectTimer !== undefined) window.clearTimeout(session.connectTimer);
    if (session.disconnectTimer !== undefined) window.clearTimeout(session.disconnectTimer);
    if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
    session.pc.close();
    this.sessions.delete(session.id);
    const peerScopeKey = `${session.scope}\u0000${session.peerId}`;
    if (this.sessionByPeerScope.get(peerScopeKey) === session.id) {
      this.sessionByPeerScope.delete(peerScopeKey);
      this.callbacks?.onRemoteStream(session.scope, session.peerId, null);
    }
  }

  private orderedWorld(): WorldVoiceState[] {
    const now = Date.now();
    for (const [peerId, state] of this.worldStates) {
      if (state.status === 'idle'
        || (state.status === 'speaking' && (state.speaking_until ?? 0) <= now)
        || (peerId !== this.localPeerId && now - (this.worldSeen.get(peerId) ?? 0) > 75_000)) {
        this.worldStates.delete(peerId);
        this.worldSeen.delete(peerId);
        this.rememberWorldRelease(peerId, state.request_id, now);
        this.deletePendingWorldOffersForPeer(peerId);
      }
    }
    return [...this.worldStates.values()].sort((a, b) => a.joined_at - b.joined_at || a.peer_id.localeCompare(b.peer_id));
  }

  private announceRoomMembership(): void {
    if (!this.roomScope || !this.roomMembershipId || !this.localStream) return;
    this.broadcast({
      connection_id: crypto.randomUUID(),
      action: 'join',
      scope: this.roomScope,
      ...this.localRoomMembershipSignal(),
      reply: false,
    });
  }

  private tickRoomMembership(now: number): void {
    if (!this.roomScope || !this.roomMembershipId || !this.localStream || now < this.nextRoomJoinAt) return;
    this.announceRoomMembership();
    const nextBurstInterval = ROOM_JOIN_BURST_INTERVALS_MS[this.roomJoinPhase + 1];
    if (nextBurstInterval !== undefined) {
      this.roomJoinPhase += 1;
      this.nextRoomJoinAt = now + nextBurstInterval;
    } else {
      this.roomJoinPhase = ROOM_JOIN_BURST_INTERVALS_MS.length;
      this.nextRoomJoinAt = now + ROOM_JOIN_HEARTBEAT_MS;
    }
  }

  private demoteContendedWorldSpeaker(now: number): void {
    const current = this.localWorld;
    if (!current || current.status !== 'speaking') return;
    this.mediaEpoch += 1;
    this.publishWorldRelease(current);
    this.stopWorldSessions();
    this.clearSessionRecoveriesForScope('world');
    this.stopLocalStream();
    const queued: WorldVoiceState = {
      ...current,
      status: 'queued',
      request_id: crypto.randomUUID(),
      joined_at: now,
      speaking_until: undefined,
    };
    this.localWorld = queued;
    this.worldStates.set(this.localPeerId, queued);
    this.worldSeen.set(this.localPeerId, now);
    this.worldContentionUntil = now + WORLD_CONTENTION_DELAY_MS;
    this.worldStartInFlight = undefined;
    this.worldAutoStartEligible = true;
    this.callbacks?.publishWorld(this.publicState(queued));
  }

  private tick(): void {
    const now = Date.now();
    this.prunePendingWorldOffers(now);
    this.pruneReleasedWorldRequests(now);
    this.pruneReleasedRoomMemberships(now);
    this.tickRoomMembership(now);
    if (this.localWorld?.status === 'speaking'
      && (this.localWorld.speaking_until ?? 0) <= now) this.leaveWorld();
    else {
      const head = this.orderedWorld()[0];
      if (this.localWorld?.status === 'speaking'
        && head
        && head.peer_id !== this.localPeerId) this.demoteContendedWorldSpeaker(now);
      const snapshot = this.snapshot();
      if (this.worldAutoStartEligible
        && this.localWorld?.status === 'queued'
        && now >= this.worldContentionUntil
        && snapshot.canStartWorld
        && !this.worldStartInFlight) {
        void this.startWorldTurn().catch(error => {
          this.error = String(error);
          this.emit();
        });
      }
      this.drainSessionRecoveries(now);
      const speakerId = snapshot.speaker?.peer_id;
      const localIsSpeaker = this.localWorld?.status === 'speaking' && speakerId === this.localPeerId;
      for (const session of [...this.sessions.values()]) {
        if (session.scope === 'world' && !localIsSpeaker && session.peerId !== speakerId) this.closeSession(session);
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

  private publishWorldRelease(state: WorldVoiceState): void {
    this.broadcast({
      connection_id: crypto.randomUUID(),
      action: 'world_release',
      scope: 'world',
      request_id: state.request_id,
    });
    this.publishIdle(state);
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
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
    } catch (error) {
      const name = (error as { name?: unknown })?.name;
      if (name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(t('audio.microphonePermission'));
      } else {
        throw error;
      }
    }
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
