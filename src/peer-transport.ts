import { invoke } from '@tauri-apps/api/core';
import type { RtcSignal } from './world-relay';
import { RTC_CONFIG } from './rtc-config.ts';
import { captureMicrophone, releaseMicrophoneStream, type MicrophoneCaptureScope } from './microphone-capture.ts';

const FILE_CHUNK_BYTES = 32 * 1024;
const DATA_HIGH_WATER = 4 * 1024 * 1024;
const MAX_ACTIVE_SESSIONS = 12;
const MAX_FILES_PER_DIRECTION = 4;
const FILE_SESSION_IDLE_MS = 120_000;
const ICE_GATHER_TIMEOUT_MS = 5_000;
const AUDIO_CONNECT_TIMEOUT_MS = 25_000;
const AUDIO_DISCONNECT_GRACE_MS = 8_000;
const OFFER_RETRY_DELAY_MS = 750;
const OFFER_RETRY_COUNT = 2;
const CALL_CONTROL_RETRY_MS = 750;
const CALL_CONTROL_RETRY_COUNT = 2;
const CALL_ACCEPT_RETRY_COUNT = 6;
const CALL_ACCEPT_RETRY_MAX_MS = 5_000;
const CALL_REQUEST_TIMEOUT_MS = 30_000;
const CALL_TOMBSTONE_TTL_MS = 125_000;
const MAX_CALL_TOMBSTONES = 256;

export type RtcFileDescriptor = { token: string; file_name: string; size: number; sha256: string };
type RtcFileChunk = { offset: number; data_base64: string; eof: boolean };
export type DirectFileOffer = RtcFileDescriptor & { peer_id: string };
export type DirectFileProgress = DirectFileOffer & {
  direction: 'incoming' | 'outgoing';
  transferred: number;
  progress: number;
  status: 'waiting' | 'transferring' | 'verifying' | 'completed' | 'rejected' | 'failed' | 'cancelled';
  path?: string;
  error?: string;
};
export type AudioCallState = 'calling' | 'ringing' | 'connecting' | 'connected' | 'muted' | 'ended' | 'rejected' | 'failed';

type Callbacks = {
  sendSignal(peerId: string, signal: RtcSignal): void;
  beforeMicrophoneCapture?(): void;
  onIncomingCall(peerId: string, connectionId: string): void;
  onCallState(peerId: string, state: AudioCallState, error?: string): void;
  onRemoteAudio(peerId: string, stream: MediaStream | null): void;
  onFileOffer(offer: DirectFileOffer): void;
  onFileProgress(progress: DirectFileProgress): void;
};

type WireMessage =
  | { type: 'file_offer'; token: string; file_name: string; size: number; sha256: string }
  | { type: 'file_accept'; token: string }
  | { type: 'file_reject'; token: string; reason?: string }
  | { type: 'file_chunk'; token: string; offset: number; data_base64: string }
  | { type: 'file_complete'; token: string }
  | { type: 'file_saved'; token: string; path: string }
  | { type: 'file_error'; token: string; reason: string };

type Session = {
  id: string;
  peerId: string;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  pendingIce: RTCIceCandidateInit[];
  localStream?: MediaStream;
  audio: boolean;
  closed: boolean;
  receiveChain: Promise<void>;
  idleTimer?: number;
  connectTimer?: number;
  disconnectTimer?: number;
  offerRetryTimer?: number;
  answerInFlight?: Promise<void>;
  established: boolean;
};

type PendingCall = {
  peerId: string;
  direction: 'incoming' | 'outgoing';
  stream?: MediaStream;
  controlTimer?: number;
  expiryTimer?: number;
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

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function validFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= 180
    && !/[\u0000-\u001f<>:"/\\|?*]/.test(value) && value !== '.' && value !== '..';
}

function parseWireMessage(value: unknown): WireMessage | undefined {
  if (typeof value !== 'string' || value.length > 96 * 1024) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!validUuid(record.token) || typeof record.type !== 'string') return undefined;
  if (record.type === 'file_offer') {
    if (!validFileName(record.file_name) || !Number.isSafeInteger(record.size) || Number(record.size) < 0
      || Number(record.size) > 32 * 1024 * 1024 * 1024 || !validSha256(record.sha256)) return undefined;
  } else if (record.type === 'file_chunk') {
    if (!Number.isSafeInteger(record.offset) || Number(record.offset) < 0
      || typeof record.data_base64 !== 'string' || record.data_base64.length > 90 * 1024) return undefined;
  } else if (record.type === 'file_saved') {
    if (typeof record.path !== 'string' || record.path.length > 4_096) return undefined;
  } else if (record.type === 'file_reject' || record.type === 'file_error') {
    if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.length > 500)) return undefined;
  } else if (!['file_accept', 'file_complete'].includes(record.type)) return undefined;
  return record as unknown as WireMessage;
}

export class PeerTransport {
  private readonly sessions = new Map<string, Session>();
  private readonly outgoing = new Map<string, { file: RtcFileDescriptor; sessionId: string; peerId: string }>();
  private readonly incoming = new Map<string, { offer: DirectFileOffer; sessionId: string; previewOnly: boolean }>();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly endedCalls = new Map<string, number>();
  private readonly earlyIce = new Map<string, { peerId: string; candidates: RTCIceCandidateInit[] }>();
  private callbacks?: Callbacks;
  private mediaEpoch = 0;
  private readonly microphoneScope?: MicrophoneCaptureScope;

  constructor(microphoneScope?: MicrophoneCaptureScope) {
    this.microphoneScope = microphoneScope;
  }

  start(callbacks: Callbacks): void { this.callbacks = callbacks; }

  stop(): void {
    this.mediaEpoch += 1;
    const audioPeers = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.audio) audioPeers.add(session.peerId);
      this.closeSession(session);
    }
    for (const peerId of audioPeers) this.callbacks?.onRemoteAudio(peerId, null);
    for (const call of this.pendingCalls.values()) {
      this.clearCallTimers(call);
      releaseMicrophoneStream(call.stream);
    }
    this.sessions.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.pendingCalls.clear();
    this.endedCalls.clear();
    this.earlyIce.clear();
    this.callbacks = undefined;
  }

  async sendFile(peerId: string): Promise<DirectFileOffer | null> {
    if (this.outgoing.size >= MAX_FILES_PER_DIRECTION) throw new Error('All direct outgoing file slots are busy.');
    const file = await invoke<RtcFileDescriptor | null>('pick_rtc_file');
    if (!file) return null;
    return this.sendPreparedFile(peerId, file);
  }

  async sendPreparedFile(peerId: string, file: RtcFileDescriptor): Promise<DirectFileOffer> {
    if (this.outgoing.size >= MAX_FILES_PER_DIRECTION) throw new Error('All direct outgoing file slots are busy.');
    if (!validUuid(file.token) || !validFileName(file.file_name)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 32 * 1024 * 1024 * 1024
      || !validSha256(file.sha256)) throw new Error('Invalid prepared P2P file descriptor.');
    let session: Session | undefined;
    try {
      session = this.createSession(crypto.randomUUID(), peerId, true, false);
      this.outgoing.set(file.token, { file, sessionId: session.id, peerId });
      this.callbacks?.onFileProgress({ ...file, peer_id: peerId, direction: 'outgoing', transferred: 0, progress: 0, status: 'waiting' });
      await this.negotiate(session);
      return { ...file, peer_id: peerId };
    } catch (error) {
      this.outgoing.delete(file.token);
      if (session) this.closeSession(session);
      await invoke('close_rtc_file', { token: file.token }).catch(() => undefined);
      throw error;
    }
  }

  async acceptFile(token: string, previewOnly = false): Promise<void> {
    const incoming = this.incoming.get(token);
    if (!incoming) throw new Error('Oferta dużego pliku wygasła.');
    const session = this.sessions.get(incoming.sessionId);
    if (!session?.channel || session.channel.readyState !== 'open') throw new Error('Bezpośredni kanał pliku został zamknięty.');
    await invoke('begin_rtc_file_receive', {
      token,
      fileName: incoming.offer.file_name,
      size: incoming.offer.size,
      sha256: incoming.offer.sha256,
      previewOnly,
    });
    incoming.previewOnly = previewOnly;
    if (session.channel.readyState !== 'open') {
      await invoke('close_rtc_file', { token }).catch(() => undefined);
      throw new Error('Bezpośredni kanał pliku został zamknięty.');
    }
    this.sendWire(session.channel, { type: 'file_accept', token });
    this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: 0, progress: 0, status: 'transferring' });
  }

  async rejectFile(token: string, reason = 'Recipient rejected the file.'): Promise<void> {
    const incoming = this.incoming.get(token);
    if (!incoming) return;
    const session = this.sessions.get(incoming.sessionId);
    if (session?.channel?.readyState === 'open') this.sendWire(session.channel, { type: 'file_reject', token, reason });
    this.incoming.delete(token);
    await invoke('close_rtc_file', { token }).catch(() => undefined);
    if (session) this.closeSession(session);
  }

  async cancelFile(token: string): Promise<void> {
    const outgoing = this.outgoing.get(token);
    if (outgoing) {
      const session = this.sessions.get(outgoing.sessionId);
      if (session?.channel?.readyState === 'open') this.sendWire(session.channel, { type: 'file_reject', token, reason: 'Sender cancelled the file.' });
      this.outgoing.delete(token);
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: 0, progress: 0, status: 'cancelled' });
      if (session) this.closeSession(session);
    }
    const incoming = this.incoming.get(token);
    if (incoming) {
      const session = this.sessions.get(incoming.sessionId);
      if (session?.channel?.readyState === 'open') this.sendWire(session.channel, { type: 'file_reject', token, reason: 'Recipient cancelled the file.' });
      this.incoming.delete(token);
      this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: 0, progress: 0, status: 'cancelled' });
      if (session) this.closeSession(session);
    }
    await invoke('close_rtc_file', { token }).catch(() => undefined);
  }

  async startCall(peerId: string): Promise<void> {
    if (this.pendingCalls.size > 0) throw new Error('Only one audio call can be active at a time.');
    const mediaEpoch = ++this.mediaEpoch;
    this.callbacks?.beforeMicrophoneCapture?.();
    const stream = await captureMicrophone({ scope: this.microphoneScope });
    if (mediaEpoch !== this.mediaEpoch || this.pendingCalls.size > 0) {
      releaseMicrophoneStream(stream);
      throw new Error(mediaEpoch !== this.mediaEpoch
        ? 'Audio call was cancelled before the microphone became ready.'
        : 'Only one audio call can be active at a time.');
    }
    const connectionId = crypto.randomUUID();
    const call: PendingCall = { peerId, direction: 'outgoing', stream };
    this.pendingCalls.set(connectionId, call);
    try {
      this.sendCallRequestWithRetry(connectionId, CALL_CONTROL_RETRY_COUNT);
    } catch (error) {
      this.pendingCalls.delete(connectionId);
      releaseMicrophoneStream(stream);
      throw error;
    }
    call.expiryTimer = window.setTimeout(() => {
      if (this.sessions.has(connectionId) || this.pendingCalls.get(connectionId) !== call) return;
      this.clearCallTimers(call);
      releaseMicrophoneStream(call.stream);
      this.pendingCalls.delete(connectionId);
      this.rememberEndedCall(call.peerId, connectionId);
      this.callbacks?.onCallState(peerId, 'failed', 'Zaproszenie audio nie zostało dostarczone na czas.');
    }, CALL_REQUEST_TIMEOUT_MS);
    this.callbacks?.onCallState(peerId, 'calling');
  }

  async acceptCall(connectionId: string): Promise<void> {
    const call = this.pendingCalls.get(connectionId);
    if (!call || call.direction !== 'incoming') throw new Error('Zaproszenie audio wygasło.');
    const mediaEpoch = ++this.mediaEpoch;
    this.callbacks?.beforeMicrophoneCapture?.();
    let stream: MediaStream | undefined;
    let session: Session | undefined;
    try {
      stream = await captureMicrophone({ scope: this.microphoneScope });
      if (mediaEpoch !== this.mediaEpoch
        || this.pendingCalls.get(connectionId) !== call
        || this.sessions.has(connectionId)) {
        releaseMicrophoneStream(stream);
        stream = undefined;
        throw new Error('Zaproszenie audio wygasło.');
      }
      call.stream = stream;
      this.clearCallTimers(call);
      session = this.createSession(connectionId, call.peerId, false, true, stream);
      this.sendCallAcceptWithRetry(connectionId, 0);
      this.callbacks?.onCallState(call.peerId, 'connecting');
      session.audio = true;
    } catch (error) {
      if (session) this.closeSession(session);
      releaseMicrophoneStream(stream);
      if (this.pendingCalls.get(connectionId) === call) {
        this.clearCallTimers(call);
        this.pendingCalls.delete(connectionId);
        this.rememberEndedCall(call.peerId, connectionId);
        try { this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_reject' }); } catch {}
        this.callbacks?.onCallState(call.peerId, 'failed', String(error));
      }
      throw error;
    }
  }

  rejectCall(connectionId: string): void {
    const call = this.pendingCalls.get(connectionId);
    if (!call) return;
    this.clearCallTimers(call);
    this.rememberEndedCall(call.peerId, connectionId);
    try { this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_reject' }); } catch {}
    if (!this.sessions.has(connectionId)) releaseMicrophoneStream(call.stream);
    this.pendingCalls.delete(connectionId);
    this.callbacks?.onCallState(call.peerId, 'rejected');
  }

  hangup(peerId: string): void {
    let ended = false;
    for (const [id, call] of this.pendingCalls) {
      if (call.peerId !== peerId) continue;
      ended = true;
      this.clearCallTimers(call);
      this.rememberEndedCall(peerId, id);
      try { this.callbacks?.sendSignal(peerId, { connection_id: id, action: 'hangup' }); } catch {}
      const session = this.sessions.get(id);
      if (session) this.closeSession(session);
      else releaseMicrophoneStream(call.stream);
      this.pendingCalls.delete(id);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.peerId !== peerId || !session.audio) continue;
      ended = true;
      this.rememberEndedCall(peerId, session.id);
      try { this.callbacks?.sendSignal(peerId, { connection_id: session.id, action: 'hangup' }); } catch {}
      this.closeSession(session);
    }
    if (!ended) return;
    this.callbacks?.onRemoteAudio(peerId, null);
    this.callbacks?.onCallState(peerId, 'ended');
  }

  hangupAllCalls(): void {
    // Invalidate a getUserMedia request that has not produced a PendingCall or
    // Session yet, so switching to group voice cannot race it for the device.
    this.mediaEpoch += 1;
    const peers = new Set<string>();
    for (const call of this.pendingCalls.values()) peers.add(call.peerId);
    for (const session of this.sessions.values()) {
      if (session.audio) peers.add(session.peerId);
    }
    for (const peerId of peers) this.hangup(peerId);
  }

  setMuted(peerId: string, muted: boolean): void {
    for (const [id, call] of this.pendingCalls) {
      if (call.peerId !== peerId) continue;
      const stream = this.sessions.get(id)?.localStream;
      stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
      this.callbacks?.onCallState(peerId, muted ? 'muted' : 'connected');
    }
  }

  peerOffline(peerId: string): void {
    this.hangup(peerId);
    for (const session of [...this.sessions.values()]) {
      if (session.peerId !== peerId || session.audio) continue;
      this.failSessionFiles(session, 'Peer went offline during the direct file transfer.');
      this.closeSession(session);
    }
  }

  async handleSignal(peerId: string, signal: RtcSignal): Promise<void> {
    if (signal.action === 'call_request') {
      if (this.hasEndedCall(peerId, signal.connection_id)) {
        try { this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'hangup' }); } catch {}
        return;
      }
      const existing = this.pendingCalls.get(signal.connection_id);
      if (existing) {
        if (existing.peerId === peerId
          && existing.direction === 'incoming'
          && this.sessions.has(signal.connection_id)) {
          this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'call_accept' });
        }
        return;
      }
      if (this.pendingCalls.size > 0) {
        this.rememberEndedCall(peerId, signal.connection_id);
        this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'call_reject' });
        return;
      }
      const call: PendingCall = { peerId, direction: 'incoming' };
      this.pendingCalls.set(signal.connection_id, call);
      call.expiryTimer = window.setTimeout(() => {
        if (this.sessions.has(signal.connection_id) || this.pendingCalls.get(signal.connection_id) !== call) return;
        this.pendingCalls.delete(signal.connection_id);
        this.rememberEndedCall(peerId, signal.connection_id);
        this.callbacks?.onCallState(peerId, 'ended');
      }, CALL_REQUEST_TIMEOUT_MS);
      this.callbacks?.onIncomingCall(peerId, signal.connection_id);
      this.callbacks?.onCallState(peerId, 'ringing');
      return;
    }
    if (signal.action === 'call_reject') {
      const call = this.pendingCalls.get(signal.connection_id);
      if (!call || call.peerId !== peerId || call.direction !== 'outgoing'
        || this.sessions.has(signal.connection_id)) return;
      this.clearCallTimers(call);
      this.rememberEndedCall(peerId, signal.connection_id);
      releaseMicrophoneStream(call.stream);
      this.pendingCalls.delete(signal.connection_id);
      this.callbacks?.onCallState(peerId, 'rejected');
      return;
    }
    if (signal.action === 'hangup') {
      const call = this.pendingCalls.get(signal.connection_id);
      const session = this.sessions.get(signal.connection_id);
      this.rememberEndedCall(peerId, signal.connection_id);
      if ((!call || call.peerId !== peerId) && (!session || session.peerId !== peerId)) return;
      if (call) this.clearCallTimers(call);
      if (session) this.closeSession(session);
      else releaseMicrophoneStream(call?.stream);
      this.pendingCalls.delete(signal.connection_id);
      this.callbacks?.onRemoteAudio(peerId, null);
      this.callbacks?.onCallState(peerId, 'ended');
      return;
    }
    if (signal.action === 'call_accept') {
      const call = this.pendingCalls.get(signal.connection_id);
      if (!call || call.peerId !== peerId || call.direction !== 'outgoing') return;
      const existingSession = this.sessions.get(signal.connection_id);
      if (existingSession) {
        // call_request is retried until an accept arrives. A delayed duplicate accept
        // must not start a second negotiation on the same RTCPeerConnection.
        if (existingSession.peerId === peerId && existingSession.audio) return;
        return;
      }
      this.clearCallTimers(call);
      let stream: MediaStream | undefined;
      let session: Session | undefined;
      try {
        stream = call.stream ?? await captureMicrophone({ scope: this.microphoneScope });
        session = this.createSession(signal.connection_id, peerId, true, true, stream);
        this.callbacks?.onCallState(peerId, 'connecting');
        await this.negotiate(session);
      } catch (error) {
        if (session) this.closeSession(session);
        else releaseMicrophoneStream(stream);
        this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'hangup' });
        this.pendingCalls.delete(signal.connection_id);
        this.callbacks?.onRemoteAudio(peerId, null);
        this.callbacks?.onCallState(peerId, 'failed', String(error));
      }
      return;
    }
    let session = this.sessions.get(signal.connection_id);
    if (signal.action === 'ice' && signal.candidate && !session) {
      const queued = this.earlyIce.get(signal.connection_id);
      if (queued && queued.peerId !== peerId) return;
      if (!queued && this.earlyIce.size >= MAX_ACTIVE_SESSIONS) return;
      const candidates = queued?.candidates ?? [];
      if (candidates.length >= 32) return;
      candidates.push({
        candidate: signal.candidate,
        sdpMid: signal.sdp_mid,
        sdpMLineIndex: signal.sdp_mline_index,
      });
      this.earlyIce.set(signal.connection_id, { peerId, candidates });
      return;
    }
    if (signal.action === 'offer') {
      if (!signal.sdp) return;
      if (!session && /(?:^|\r?\n)m=audio\s/im.test(signal.sdp)) {
        this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'hangup' });
        this.earlyIce.delete(signal.connection_id);
        return;
      }
      if (!session) session = this.createSession(signal.connection_id, peerId, false, false);
      if (session.peerId !== peerId) return;
      const acceptedCall = this.pendingCalls.get(signal.connection_id);
      if (acceptedCall?.direction === 'incoming') {
        if (acceptedCall.controlTimer !== undefined) window.clearTimeout(acceptedCall.controlTimer);
        acceptedCall.controlTimer = undefined;
      }
      if (session.answerInFlight) {
        try { await session.answerInFlight; } catch { return; }
        if (!session.closed && session.pc.localDescription?.type === 'answer') {
          this.callbacks?.sendSignal(peerId, {
            connection_id: session.id,
            action: 'answer',
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
          sdp: session.pc.localDescription?.sdp ?? answer.sdp ?? '',
        });
      })();
      session.answerInFlight = answering;
      try { await answering; } finally {
        if (session.answerInFlight === answering) session.answerInFlight = undefined;
      }
      return;
    }
    if (!session || session.peerId !== peerId) return;
    if (signal.action === 'answer') {
      if (!signal.sdp) return;
      if (session.pc.remoteDescription?.type === 'answer') return;
      await session.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
      session.offerRetryTimer = undefined;
      await this.flushIce(session);
    } else if (signal.action === 'ice' && signal.candidate) {
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate,
        sdpMid: signal.sdp_mid,
        sdpMLineIndex: signal.sdp_mline_index,
      };
      if (session.pc.remoteDescription) {
        try { await session.pc.addIceCandidate(candidate); } catch {}
      }
      else session.pendingIce.push(candidate);
    }
  }

  private createSession(id: string, peerId: string, initiator: boolean, audio: boolean, stream?: MediaStream): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) throw new Error('Too many active direct peer sessions.');
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const earlyIce = this.earlyIce.get(id);
    if (earlyIce?.peerId === peerId) this.earlyIce.delete(id);
    const session: Session = {
      id,
      peerId,
      pc,
      pendingIce: earlyIce?.peerId === peerId ? earlyIce.candidates : [],
      localStream: stream,
      audio,
      closed: false,
      established: false,
      receiveChain: Promise.resolve(),
    };
    this.sessions.set(id, session);
    stream?.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.onicecandidate = event => {
      if (!event.candidate || session.closed) return;
      const candidate = event.candidate.toJSON();
      this.callbacks?.sendSignal(peerId, {
        connection_id: id,
        action: 'ice',
        candidate: candidate.candidate,
        sdp_mid: candidate.sdpMid,
        sdp_mline_index: candidate.sdpMLineIndex,
      });
    };
    pc.ontrack = event => {
      if (session.closed) return;
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks?.onRemoteAudio(peerId, remote);
    };
    const handleConnectionState = () => {
      if (session.closed) return;
      const failed = pc.connectionState === 'failed' || pc.iceConnectionState === 'failed';
      if (failed) {
        if (session.audio) this.failAudioSession(session, 'Nie udało się utrzymać bezpośredniego połączenia audio.');
        else this.closeSession(session);
        return;
      }
      const disconnected = pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected';
      if (disconnected) {
        if (session.audio && session.established && session.disconnectTimer === undefined) {
          session.disconnectTimer = window.setTimeout(() => {
            session.disconnectTimer = undefined;
            if (session.closed || this.sessions.get(session.id) !== session) return;
            if (session.pc.connectionState !== 'disconnected'
              && session.pc.iceConnectionState !== 'disconnected') return;
            this.failAudioSession(session, 'Połączenie audio zostało przerwane przez zbyt długi czas.');
          }, AUDIO_DISCONNECT_GRACE_MS);
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
        session.established = true;
        if (session.audio) this.callbacks?.onCallState(peerId, 'connected');
      }
    };
    pc.onconnectionstatechange = handleConnectionState;
    pc.oniceconnectionstatechange = handleConnectionState;
    pc.ondatachannel = event => this.attachChannel(session, event.channel);
    if (initiator && !audio) this.attachChannel(session, pc.createDataChannel('konofix-files', { ordered: true }));
    if (audio) {
      session.connectTimer = window.setTimeout(() => {
        if (session.closed || session.pc.connectionState === 'connected') return;
        this.callbacks?.onCallState(peerId, 'failed', 'Przekroczono czas zestawiania połączenia audio WAN.');
        this.callbacks?.onRemoteAudio(peerId, null);
        try { this.callbacks?.sendSignal(peerId, { connection_id: session.id, action: 'hangup' }); } catch {}
        this.closeSession(session);
      }, AUDIO_CONNECT_TIMEOUT_MS);
    }
    this.touchSession(session);
    return session;
  }

  private attachChannel(session: Session, channel: RTCDataChannel): void {
    session.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = DATA_HIGH_WATER / 2;
    channel.onopen = () => {
      for (const outgoing of this.outgoing.values()) {
        if (outgoing.sessionId !== session.id) continue;
        this.sendWire(channel, { type: 'file_offer', ...outgoing.file });
      }
    };
    channel.onmessage = event => {
      this.touchSession(session);
      const message = parseWireMessage(event.data);
      if (!message) return;
      session.receiveChain = session.receiveChain.then(() => this.receiveWire(session, message)).catch(error => {
        this.failSessionFiles(session, String(error));
      });
    };
    channel.onerror = () => this.failSessionFiles(session, 'Bezpośredni kanał pliku uległ awarii.');
    channel.onclose = () => {
      if (!session.audio && !session.closed) {
        this.failSessionFiles(session, 'Bezpośredni kanał pliku został zamknięty.');
        this.closeSession(session);
      }
    };
  }

  private async negotiate(session: Session): Promise<void> {
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    await waitForIceGathering(session.pc);
    if (session.closed) return;
    const signal: RtcSignal = {
      connection_id: session.id,
      action: 'offer',
      sdp: session.pc.localDescription?.sdp ?? offer.sdp ?? '',
    };
    this.sendOfferWithRetry(session, signal, OFFER_RETRY_COUNT);
  }

  private sendOfferWithRetry(session: Session, signal: RtcSignal, retriesLeft: number): void {
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

  private sendCallRequestWithRetry(connectionId: string, retriesLeft: number): void {
    const call = this.pendingCalls.get(connectionId);
    if (!call || call.direction !== 'outgoing' || this.sessions.has(connectionId)) return;
    this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_request' });
    if (retriesLeft <= 0) return;
    if (call.controlTimer !== undefined) window.clearTimeout(call.controlTimer);
    call.controlTimer = window.setTimeout(() => {
      call.controlTimer = undefined;
      if (this.pendingCalls.get(connectionId) !== call || this.sessions.has(connectionId)) return;
      try { this.sendCallRequestWithRetry(connectionId, retriesLeft - 1); } catch {}
    }, CALL_CONTROL_RETRY_MS);
  }

  private sendCallAcceptWithRetry(connectionId: string, attempt: number): void {
    const call = this.pendingCalls.get(connectionId);
    const session = this.sessions.get(connectionId);
    if (!call || call.direction !== 'incoming' || !session || session.closed
      || session.pc.remoteDescription?.type === 'offer') return;
    this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_accept' });
    if (attempt >= CALL_ACCEPT_RETRY_COUNT) return;
    if (call.controlTimer !== undefined) window.clearTimeout(call.controlTimer);
    const delay = Math.min(CALL_CONTROL_RETRY_MS * 2 ** attempt, CALL_ACCEPT_RETRY_MAX_MS);
    call.controlTimer = window.setTimeout(() => {
      call.controlTimer = undefined;
      try { this.sendCallAcceptWithRetry(connectionId, attempt + 1); } catch {}
    }, delay);
  }

  private clearCallTimers(call: PendingCall): void {
    if (call.controlTimer !== undefined) window.clearTimeout(call.controlTimer);
    if (call.expiryTimer !== undefined) window.clearTimeout(call.expiryTimer);
    call.controlTimer = undefined;
    call.expiryTimer = undefined;
  }

  private callTombstoneKey(peerId: string, connectionId: string): string {
    return `${peerId}\u0000${connectionId}`;
  }

  private hasEndedCall(peerId: string, connectionId: string, now = Date.now()): boolean {
    this.pruneEndedCalls(now);
    return (this.endedCalls.get(this.callTombstoneKey(peerId, connectionId)) ?? 0) > now;
  }

  private rememberEndedCall(peerId: string, connectionId: string, now = Date.now()): void {
    this.pruneEndedCalls(now);
    const key = this.callTombstoneKey(peerId, connectionId);
    this.endedCalls.delete(key);
    this.endedCalls.set(key, now + CALL_TOMBSTONE_TTL_MS);
    while (this.endedCalls.size > MAX_CALL_TOMBSTONES) {
      const oldest = this.endedCalls.keys().next().value;
      if (oldest === undefined) break;
      this.endedCalls.delete(oldest);
    }
  }

  private pruneEndedCalls(now = Date.now()): void {
    for (const [key, expiresAt] of this.endedCalls) {
      if (expiresAt <= now) this.endedCalls.delete(key);
    }
  }

  private async flushIce(session: Session): Promise<void> {
    const pending = session.pendingIce.splice(0);
    for (const candidate of pending) {
      if (session.closed) return;
      try { await session.pc.addIceCandidate(candidate); } catch {}
    }
  }

  private sendWire(channel: RTCDataChannel, message: WireMessage | Record<string, unknown>): void {
    if (channel.readyState !== 'open') throw new Error('Bezpośredni kanał danych nie jest otwarty.');
    channel.send(JSON.stringify(message));
  }

  private async waitForBuffer(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= DATA_HIGH_WATER) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', ready);
        reject(new Error('Kanał pliku nie opróżnił bufora na czas.'));
      }, 30_000);
      const ready = () => {
        window.clearTimeout(timeout);
        channel.removeEventListener('bufferedamountlow', ready);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', ready, { once: true });
    });
  }

  private async sendChunks(session: Session, outgoing: { file: RtcFileDescriptor; sessionId: string; peerId: string }): Promise<void> {
    const channel = session.channel;
    if (!channel) throw new Error('Brak bezpośredniego kanału danych.');
    let offset = 0;
    try {
      while (offset < outgoing.file.size) {
        this.touchSession(session);
        await this.waitForBuffer(channel);
        const chunk = await invoke<RtcFileChunk>('read_rtc_file_chunk', { token: outgoing.file.token, offset, maxBytes: FILE_CHUNK_BYTES });
        if (chunk.offset !== offset || !chunk.data_base64) throw new Error('Nieprawidłowy fragment pliku ze źródła.');
        this.sendWire(channel, { type: 'file_chunk', token: outgoing.file.token, offset, data_base64: chunk.data_base64 });
        const bytes = Math.min(FILE_CHUNK_BYTES, outgoing.file.size - offset);
        offset += bytes;
        this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: offset, progress: outgoing.file.size === 0 ? 100 : offset / outgoing.file.size * 100, status: 'transferring' });
      }
      await this.waitForBuffer(channel);
      this.sendWire(channel, { type: 'file_complete', token: outgoing.file.token });
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: offset, progress: 100, status: 'verifying' });
    } catch (error) {
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: offset, progress: outgoing.file.size === 0 ? 100 : offset / outgoing.file.size * 100, status: 'failed', error: String(error) });
      await invoke('close_rtc_file', { token: outgoing.file.token }).catch(() => undefined);
      this.outgoing.delete(outgoing.file.token);
    }
  }

  private async receiveWire(session: Session, message: WireMessage): Promise<void> {
    if (message.type === 'file_offer') {
      if (this.incoming.size >= MAX_FILES_PER_DIRECTION && !this.incoming.has(message.token)) {
        this.sendWire(session.channel!, { type: 'file_reject', token: message.token, reason: 'All incoming file slots are busy.' });
        return;
      }
      const offer: DirectFileOffer = { token: message.token, peer_id: session.peerId, file_name: message.file_name, size: message.size, sha256: message.sha256 };
      this.incoming.set(message.token, { offer, sessionId: session.id, previewOnly: false });
      this.callbacks?.onFileOffer(offer);
      return;
    }
    if (message.type === 'file_accept') {
      const outgoing = this.outgoing.get(message.token);
      if (outgoing?.sessionId === session.id) await this.sendChunks(session, outgoing);
      return;
    }
    if (message.type === 'file_reject') {
      const outgoing = this.outgoing.get(message.token);
      if (!outgoing || outgoing.sessionId !== session.id) return;
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: 0, progress: 0, status: 'rejected', error: message.reason });
      await invoke('close_rtc_file', { token: message.token }).catch(() => undefined);
      this.outgoing.delete(message.token);
      this.closeSession(session);
      return;
    }
    if (message.type === 'file_chunk') {
      const incoming = this.incoming.get(message.token);
      if (!incoming || incoming.sessionId !== session.id) return;
      const next = await invoke<number>('write_rtc_file_chunk', { token: message.token, offset: message.offset, dataBase64: message.data_base64 });
      this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: next, progress: incoming.offer.size === 0 ? 100 : next / incoming.offer.size * 100, status: 'transferring' });
      return;
    }
    if (message.type === 'file_complete') {
      const incoming = this.incoming.get(message.token);
      if (!incoming || incoming.sessionId !== session.id) return;
      this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: incoming.offer.size, progress: 100, status: 'verifying' });
      try {
        const path = await invoke<string>('finish_rtc_file_receive', { token: message.token });
        this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: incoming.offer.size, progress: 100, status: 'completed', path });
        this.sendWire(session.channel!, { type: 'file_saved', token: message.token, path: '' });
      } catch (error) {
        this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: 0, progress: 0, status: 'failed', error: String(error) });
        this.sendWire(session.channel!, { type: 'file_error', token: message.token, reason: String(error).slice(0, 500) });
      }
      this.incoming.delete(message.token);
      return;
    }
    if (message.type === 'file_saved') {
      const outgoing = this.outgoing.get(message.token);
      if (!outgoing || outgoing.sessionId !== session.id) return;
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: outgoing.file.size, progress: 100, status: 'completed' });
      await invoke('close_rtc_file', { token: message.token }).catch(() => undefined);
      this.outgoing.delete(message.token);
      this.closeSession(session);
      return;
    }
    if (message.type === 'file_error') {
      const outgoing = this.outgoing.get(message.token);
      if (!outgoing || outgoing.sessionId !== session.id) return;
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: 0, progress: 0, status: 'failed', error: message.reason });
      await invoke('close_rtc_file', { token: message.token }).catch(() => undefined);
      this.outgoing.delete(message.token);
      this.closeSession(session);
    }
  }

  private failSessionFiles(session: Session, reason: string): void {
    for (const [token, outgoing] of this.outgoing) {
      if (outgoing.sessionId !== session.id) continue;
      this.callbacks?.onFileProgress({ ...outgoing.file, peer_id: outgoing.peerId, direction: 'outgoing', transferred: 0, progress: 0, status: 'failed', error: reason });
      this.outgoing.delete(token);
      void invoke('close_rtc_file', { token }).catch(() => undefined);
    }
    for (const [token, incoming] of this.incoming) {
      if (incoming.sessionId !== session.id) continue;
      this.callbacks?.onFileProgress({ ...incoming.offer, direction: 'incoming', transferred: 0, progress: 0, status: 'failed', error: reason });
      this.incoming.delete(token);
      void invoke('close_rtc_file', { token }).catch(() => undefined);
    }
  }

  private failAudioSession(session: Session, reason: string): void {
    if (session.closed || !session.audio || this.sessions.get(session.id) !== session) return;
    try {
      this.callbacks?.sendSignal(session.peerId, { connection_id: session.id, action: 'hangup' });
    } catch {}
    this.callbacks?.onCallState(session.peerId, 'failed', reason);
    this.callbacks?.onRemoteAudio(session.peerId, null);
    this.closeSession(session);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer !== undefined) window.clearTimeout(session.idleTimer);
    if (session.connectTimer !== undefined) window.clearTimeout(session.connectTimer);
    if (session.disconnectTimer !== undefined) window.clearTimeout(session.disconnectTimer);
    if (session.offerRetryTimer !== undefined) window.clearTimeout(session.offerRetryTimer);
    session.channel?.close();
    session.pc.close();
    releaseMicrophoneStream(session.localStream);
    this.sessions.delete(session.id);
    if (session.audio) this.rememberEndedCall(session.peerId, session.id);
    const call = this.pendingCalls.get(session.id);
    if (call) this.clearCallTimers(call);
    this.pendingCalls.delete(session.id);
    this.earlyIce.delete(session.id);
  }

  private touchSession(session: Session): void {
    if (session.audio || session.closed) return;
    if (session.idleTimer !== undefined) window.clearTimeout(session.idleTimer);
    session.idleTimer = window.setTimeout(() => {
      if (session.closed) return;
      this.failSessionFiles(session, 'Direct file session timed out.');
      this.closeSession(session);
    }, FILE_SESSION_IDLE_MS);
  }
}
