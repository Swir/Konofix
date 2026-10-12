import { invoke } from '@tauri-apps/api/core';
import type { RtcSignal } from './world-relay';

const FILE_CHUNK_BYTES = 32 * 1024;
const DATA_HIGH_WATER = 4 * 1024 * 1024;
const MAX_ACTIVE_SESSIONS = 12;
const MAX_FILES_PER_DIRECTION = 4;
const FILE_SESSION_IDLE_MS = 120_000;
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

type RtcFileDescriptor = { token: string; file_name: string; size: number; sha256: string };
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
};

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function validFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 180
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
  private readonly incoming = new Map<string, { offer: DirectFileOffer; sessionId: string }>();
  private readonly pendingCalls = new Map<string, {
    peerId: string;
    direction: 'incoming' | 'outgoing';
    stream?: MediaStream;
  }>();
  private readonly earlyIce = new Map<string, { peerId: string; candidates: RTCIceCandidateInit[] }>();
  private callbacks?: Callbacks;

  start(callbacks: Callbacks): void { this.callbacks = callbacks; }

  stop(): void {
    const audioPeers = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.audio) audioPeers.add(session.peerId);
      this.closeSession(session);
    }
    for (const peerId of audioPeers) this.callbacks?.onRemoteAudio(peerId, null);
    for (const call of this.pendingCalls.values()) call.stream?.getTracks().forEach(track => track.stop());
    this.sessions.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.pendingCalls.clear();
    this.earlyIce.clear();
    this.callbacks = undefined;
  }

  async sendFile(peerId: string): Promise<DirectFileOffer | null> {
    if (this.outgoing.size >= MAX_FILES_PER_DIRECTION) throw new Error('All direct outgoing file slots are busy.');
    const file = await invoke<RtcFileDescriptor | null>('pick_rtc_file');
    if (!file) return null;
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

  async acceptFile(token: string): Promise<void> {
    const incoming = this.incoming.get(token);
    if (!incoming) throw new Error('Oferta dużego pliku wygasła.');
    const session = this.sessions.get(incoming.sessionId);
    if (!session?.channel || session.channel.readyState !== 'open') throw new Error('Bezpośredni kanał pliku został zamknięty.');
    await invoke('begin_rtc_file_receive', {
      token,
      fileName: incoming.offer.file_name,
      size: incoming.offer.size,
      sha256: incoming.offer.sha256,
    });
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
    const stream = await this.captureMicrophone();
    if (this.pendingCalls.size > 0) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('Only one audio call can be active at a time.');
    }
    const connectionId = crypto.randomUUID();
    this.pendingCalls.set(connectionId, { peerId, direction: 'outgoing', stream });
    this.callbacks?.sendSignal(peerId, { connection_id: connectionId, action: 'call_request' });
    this.callbacks?.onCallState(peerId, 'calling');
  }

  async acceptCall(connectionId: string): Promise<void> {
    const call = this.pendingCalls.get(connectionId);
    if (!call || call.direction !== 'incoming') throw new Error('Zaproszenie audio wygasło.');
    const stream = await this.captureMicrophone();
    try {
      call.stream = stream;
      const session = this.createSession(connectionId, call.peerId, false, true, stream);
      this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_accept' });
      this.callbacks?.onCallState(call.peerId, 'connecting');
      session.audio = true;
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  rejectCall(connectionId: string): void {
    const call = this.pendingCalls.get(connectionId);
    if (!call) return;
    this.callbacks?.sendSignal(call.peerId, { connection_id: connectionId, action: 'call_reject' });
    if (!this.sessions.has(connectionId)) call.stream?.getTracks().forEach(track => track.stop());
    this.pendingCalls.delete(connectionId);
    this.callbacks?.onCallState(call.peerId, 'rejected');
  }

  hangup(peerId: string): void {
    for (const [id, call] of this.pendingCalls) {
      if (call.peerId !== peerId) continue;
      this.callbacks?.sendSignal(peerId, { connection_id: id, action: 'hangup' });
      const session = this.sessions.get(id);
      if (session) this.closeSession(session);
      else call.stream?.getTracks().forEach(track => track.stop());
      this.pendingCalls.delete(id);
    }
    this.callbacks?.onRemoteAudio(peerId, null);
    this.callbacks?.onCallState(peerId, 'ended');
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
      if (this.pendingCalls.has(signal.connection_id)) return;
      if (this.pendingCalls.size > 0) {
        this.callbacks?.sendSignal(peerId, { connection_id: signal.connection_id, action: 'call_reject' });
        return;
      }
      this.pendingCalls.set(signal.connection_id, { peerId, direction: 'incoming' });
      this.callbacks?.onIncomingCall(peerId, signal.connection_id);
      this.callbacks?.onCallState(peerId, 'ringing');
      return;
    }
    if (signal.action === 'call_reject') {
      const call = this.pendingCalls.get(signal.connection_id);
      if (!this.sessions.has(signal.connection_id)) call?.stream?.getTracks().forEach(track => track.stop());
      this.pendingCalls.delete(signal.connection_id);
      this.callbacks?.onCallState(peerId, 'rejected');
      return;
    }
    if (signal.action === 'hangup') {
      const call = this.pendingCalls.get(signal.connection_id);
      const session = this.sessions.get(signal.connection_id);
      if (session) this.closeSession(session);
      else call?.stream?.getTracks().forEach(track => track.stop());
      this.pendingCalls.delete(signal.connection_id);
      this.callbacks?.onRemoteAudio(peerId, null);
      this.callbacks?.onCallState(peerId, 'ended');
      return;
    }
    if (signal.action === 'call_accept') {
      const call = this.pendingCalls.get(signal.connection_id);
      if (!call || call.peerId !== peerId || call.direction !== 'outgoing') return;
      let stream: MediaStream | undefined;
      let session: Session | undefined;
      try {
        stream = call.stream ?? await this.captureMicrophone();
        session = this.createSession(signal.connection_id, peerId, true, true, stream);
        this.callbacks?.onCallState(peerId, 'connecting');
        await this.negotiate(session);
      } catch (error) {
        if (session) this.closeSession(session);
        else stream?.getTracks().forEach(track => track.stop());
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
      await session.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await this.flushIce(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      this.callbacks?.sendSignal(peerId, { connection_id: session.id, action: 'answer', sdp: answer.sdp ?? '' });
      return;
    }
    if (!session || session.peerId !== peerId) return;
    if (signal.action === 'answer') {
      if (!signal.sdp) return;
      await session.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.flushIce(session);
    } else if (signal.action === 'ice' && signal.candidate) {
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate,
        sdpMid: signal.sdp_mid,
        sdpMLineIndex: signal.sdp_mline_index,
      };
      if (session.pc.remoteDescription) await session.pc.addIceCandidate(candidate);
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
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks?.onRemoteAudio(peerId, remote);
    };
    pc.onconnectionstatechange = () => {
      if (session.closed) return;
      if (pc.connectionState === 'connected' && session.audio) this.callbacks?.onCallState(peerId, 'connected');
      if (pc.connectionState === 'failed') {
        if (session.audio) this.callbacks?.onCallState(peerId, 'failed', 'Nie udało się zestawić bezpośredniego połączenia audio.');
        if (session.audio) this.callbacks?.onRemoteAudio(peerId, null);
        this.closeSession(session);
      }
    };
    pc.ondatachannel = event => this.attachChannel(session, event.channel);
    if (initiator && !audio) this.attachChannel(session, pc.createDataChannel('konofix-files', { ordered: true }));
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
    this.callbacks?.sendSignal(session.peerId, { connection_id: session.id, action: 'offer', sdp: offer.sdp ?? '' });
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

  private async flushIce(session: Session): Promise<void> {
    const pending = session.pendingIce.splice(0);
    for (const candidate of pending) await session.pc.addIceCandidate(candidate);
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
      this.incoming.set(message.token, { offer, sessionId: session.id });
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

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer !== undefined) window.clearTimeout(session.idleTimer);
    session.channel?.close();
    session.pc.close();
    session.localStream?.getTracks().forEach(track => track.stop());
    this.sessions.delete(session.id);
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
