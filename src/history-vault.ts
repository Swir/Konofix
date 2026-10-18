import type { PrivateChatMessage } from './private-chat-state';
type Record = { self: string; message: PrivateChatMessage };
type Envelope = { v: 1; salt: string; iv: string; data: string };
const KEY = 'konofix.encryptedHistory.v1';
const MAX_RECORDS = 2000;
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export class HistoryVault {
  private key?: CryptoKey;
  private salt?: Uint8Array<ArrayBuffer>;
  private records: Record[] = [];
  private epoch = 0;
  private queue = Promise.resolve();
  error = '';
  private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) { this.storage = storage; }
  exists(): boolean { return this.storage.getItem(KEY) !== null; }
  unlocked(): boolean { return Boolean(this.key); }
  all(): Record[] { return structuredClone(this.records); }
  async unlock(password: string): Promise<void> {
    if (this.key) throw new Error('History is already unlocked. Lock it before unlocking again.');
    if (password.length < 12 || password.length > 1024) throw new Error('Use a passphrase of at least 12 characters.');
    const epoch = ++this.epoch;
    const raw = this.storage.getItem(KEY);
    if (raw && raw.length > 24_000_000) throw new Error('History file is too large.');
    const envelope: Envelope | undefined = raw ? JSON.parse(raw) : undefined;
    if (envelope && (envelope.v !== 1 || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string')) throw new Error('Invalid encrypted history.');
    const salt = envelope ? decode(envelope.salt) : crypto.getRandomValues(new Uint8Array(16));
    if (salt.length !== 16) throw new Error('Invalid history salt.');
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    let records: Record[] = [];
    if (envelope) {
      const iv = decode(envelope.iv);
      if (iv.length !== 12) throw new Error('Invalid history nonce.');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(KEY) }, key, decode(envelope.data));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
      if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) throw new Error('Invalid history records.');
      records = parsed.filter((item): item is Record => Boolean(item && typeof item.self === 'string' && item.self.length <= 200 && item.message
        && ['id', 'peer_id', 'target_peer_id', 'nick', 'text'].every(field => typeof item.message[field] === 'string')
        && item.message.text.length <= 4000 && Number.isFinite(item.message.timestamp)));
    }
    if (epoch !== this.epoch) throw new Error('History unlock cancelled.');
    this.key = key; this.salt = salt; this.records = records; this.error = '';
    await this.save();
  }
  async append(self: string, message: PrivateChatMessage): Promise<void> {
    if (!this.key || message.text.length > 4000) return;
    if (this.records.some(item => item.self === self && item.message.id === message.id)) return;
    this.records.push({ self, message: structuredClone(message) });
    this.records = this.records.slice(-MAX_RECORDS);
    await this.save();
  }
  private save(): Promise<void> {
    const key = this.key, salt = this.salt, epoch = this.epoch, records = JSON.stringify(this.records);
    if (!key || !salt) return Promise.resolve();
    const pending = this.queue.catch(() => {}).then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(KEY) }, key, new TextEncoder().encode(records));
      if (epoch !== this.epoch || key !== this.key) return;
      this.storage.setItem(KEY, JSON.stringify({ v: 1, salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(data)) }));
    });
    this.queue = pending;
    return pending.catch(error => { this.error = String(error); throw error; });
  }
  lock(): void { ++this.epoch; this.key = undefined; this.salt = undefined; this.records = []; }
  clear(): void { this.lock(); this.storage.removeItem(KEY); this.error = ''; }
  async flush(): Promise<void> { await this.queue; }
}
export const historyVault = typeof localStorage === 'undefined' ? undefined : new HistoryVault(localStorage);
