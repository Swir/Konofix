export type VoiceScope =
  | { kind: 'private'; peerId: string }
  | { kind: 'room'; roomId: string };

export type PrivateVoiceScope = Extract<VoiceScope, { kind: 'private' }>;
export type RoomVoiceScope = Extract<VoiceScope, { kind: 'room' }>;

export type VoicePhase =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'joining'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'error';

export type RoomVoiceIntent = 'none' | 'listen' | 'speak';

export type VoiceParticipant = {
  peerId: string;
  nick: string;
  muted: boolean;
  speaking: boolean;
};

export type VoiceSession = {
  id: string;
  scope: VoiceScope;
  phase: VoicePhase;
  localMuted: boolean;
  deafened: boolean;
  roomIntent: RoomVoiceIntent;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  participants: ReadonlyMap<string, VoiceParticipant>;
};

export type VoicePreferences = {
  allowPrivateCalls: boolean;
  allowRoomVoice: boolean;
  chatMuted: boolean;
  notificationsMuted: boolean;
  defaultDeafened: boolean;
};

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  allowPrivateCalls: true,
  allowRoomVoice: true,
  chatMuted: false,
  notificationsMuted: false,
  defaultDeafened: false,
};

const MAX_PARTICIPANTS_TRACKED = 64;

function cleanId(value: string, label: string): string {
  const id = value.trim();
  if (!id || id.length > 128) throw new Error(`Invalid ${label}.`);
  return id;
}

function scopeKey(scope: VoiceScope): string {
  return scope.kind === 'private'
    ? `private:${cleanId(scope.peerId, 'peer ID')}`
    : `room:${cleanId(scope.roomId, 'room ID')}`;
}

function assertTransition(from: VoicePhase, to: VoicePhase): void {
  if (from === to) return;
  const allowed: Record<VoicePhase, readonly VoicePhase[]> = {
    idle: ['calling', 'ringing', 'joining', 'ended', 'error'],
    calling: ['joining', 'connected', 'ended', 'error'],
    ringing: ['joining', 'connected', 'ended', 'error'],
    joining: ['connected', 'ended', 'error'],
    connected: ['reconnecting', 'ended', 'error'],
    reconnecting: ['connected', 'ended', 'error'],
    ended: [],
    error: ['ended'],
  };
  if (!allowed[from].includes(to)) {
    throw new Error(`Invalid voice transition: ${from} -> ${to}`);
  }
}

export class VoiceSessionStore {
  private readonly sessions = new Map<string, VoiceSession>();
  private preferences: VoicePreferences = { ...DEFAULT_VOICE_PREFERENCES };

  setPreferences(next: Partial<VoicePreferences>): VoicePreferences {
    this.preferences = { ...this.preferences, ...next };
    return this.getPreferences();
  }

  getPreferences(): VoicePreferences {
    return { ...this.preferences };
  }

  canReceivePrivateCall(): boolean {
    return this.preferences.allowPrivateCalls;
  }

  canJoinRoomVoice(): boolean {
    return this.preferences.allowRoomVoice;
  }

  session(scope: VoiceScope): VoiceSession | undefined {
    return this.sessions.get(scopeKey(scope));
  }

  begin(id: string, scope: VoiceScope, phase: Extract<VoicePhase, 'calling' | 'ringing' | 'joining'>): VoiceSession {
    const key = scopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing && !['ended', 'error'].includes(existing.phase)) {
      throw new Error('A voice session is already active for this scope.');
    }
    if (scope.kind === 'private' && phase === 'ringing' && !this.preferences.allowPrivateCalls) {
      throw new Error('Private voice calls are disabled.');
    }
    if (scope.kind === 'room' && !this.preferences.allowRoomVoice) {
      throw new Error('Room voice is disabled.');
    }
    const session: VoiceSession = {
      id: cleanId(id, 'voice session ID'),
      scope,
      phase,
      localMuted: false,
      deafened: this.preferences.defaultDeafened,
      roomIntent: scope.kind === 'room' ? 'listen' : 'none',
      participants: new Map(),
    };
    this.sessions.set(key, session);
    return session;
  }

  transition(scope: VoiceScope, phase: VoicePhase, now = Date.now(), error?: string): VoiceSession {
    const key = scopeKey(scope);
    const session = this.sessions.get(key);
    if (!session) throw new Error('Unknown voice session.');
    assertTransition(session.phase, phase);
    const next: VoiceSession = {
      ...session,
      phase,
      startedAt: phase === 'connected' && session.startedAt === undefined ? now : session.startedAt,
      endedAt: phase === 'ended' ? now : session.endedAt,
      error: phase === 'error' ? (error?.trim() || 'Voice session failed.') : undefined,
    };
    this.sessions.set(key, next);
    return next;
  }

  setLocalMuted(scope: VoiceScope, muted: boolean): VoiceSession {
    return this.patch(scope, { localMuted: muted });
  }

  setDeafened(scope: VoiceScope, deafened: boolean): VoiceSession {
    return this.patch(scope, { deafened });
  }

  setRoomIntent(scope: VoiceScope, intent: RoomVoiceIntent): VoiceSession {
    if (scope.kind !== 'room') throw new Error('Speak/listen intent is only valid for room voice.');
    if (!this.preferences.allowRoomVoice && intent !== 'none') throw new Error('Room voice is disabled.');
    return this.patch(scope, { roomIntent: intent, localMuted: intent !== 'speak' });
  }

  upsertParticipant(scope: VoiceScope, participant: VoiceParticipant): VoiceSession {
    const session = this.require(scope);
    const peerId = cleanId(participant.peerId, 'participant peer ID');
    const participants = new Map(session.participants);
    if (!participants.has(peerId) && participants.size >= MAX_PARTICIPANTS_TRACKED) {
      throw new Error('Voice participant limit reached.');
    }
    participants.set(peerId, { ...participant, peerId });
    return this.patch(scope, { participants });
  }

  removeParticipant(scope: VoiceScope, peerId: string): VoiceSession {
    const session = this.require(scope);
    const participants = new Map(session.participants);
    participants.delete(peerId);
    return this.patch(scope, { participants });
  }

  reset(): void {
    this.sessions.clear();
  }

  private require(scope: VoiceScope): VoiceSession {
    const session = this.sessions.get(scopeKey(scope));
    if (!session) throw new Error('Unknown voice session.');
    return session;
  }

  private patch(scope: VoiceScope, patch: Partial<VoiceSession>): VoiceSession {
    const key = scopeKey(scope);
    const session = this.require(scope);
    const next = { ...session, ...patch };
    this.sessions.set(key, next);
    return next;
  }
}

export function roomVoiceScope(roomId: string): RoomVoiceScope {
  return { kind: 'room', roomId: cleanId(roomId, 'room ID') };
}

export function privateVoiceScope(peerId: string): PrivateVoiceScope {
  return { kind: 'private', peerId: cleanId(peerId, 'peer ID') };
}
