export type Contact = { id: string; nick: string; color: string; favorite: boolean; verified: boolean; blocked: boolean; muted: boolean };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'konofix.people.v1';
export class PeopleBook {
  private entries = new Map<string, Contact>();
  contactsOnly = false;
  private attempts = new Map<string, number[]>();
  private storage?: StorageLike;
  constructor(storage?: StorageLike) {
    this.storage = storage;
    try {
      const raw = storage?.getItem(KEY);
      if (!raw || raw.length > 600_000) return;
      const data = JSON.parse(raw);
      this.contactsOnly = data.contactsOnly === true;
      for (const item of Array.isArray(data.entries) ? data.entries.slice(0, 1000) : []) {
        if (typeof item.id !== 'string' || item.id.length > 200 || !item.id || typeof item.nick !== 'string') continue;
        this.entries.set(item.id, { id: item.id, nick: item.nick.slice(0, 64), color: typeof item.color === 'string' ? item.color.slice(0, 32) : '', favorite: item.favorite === true, verified: item.verified === true, blocked: item.blocked === true, muted: item.muted === true });
      }
    } catch { /* Corrupt preferences never grant trust. */ }
  }
  list(): Contact[] { return [...this.entries.values()].map(item => ({ ...item })); }
  get(id: string): Contact | undefined { const item = this.entries.get(id); return item ? { ...item } : undefined; }
  update(id: string, changes: Partial<Omit<Contact, 'id'>>): void {
    if (!id || id.length > 200 || (!this.entries.has(id) && this.entries.size >= 1000)) throw new Error('Contact limit reached.');
    const before = this.entries.get(id) ?? { id, nick: id, color: '', favorite: false, verified: false, blocked: false, muted: false };
    const next = { ...before, ...changes, id };
    const entries = new Map(this.entries); entries.set(id, next);
    this.storage?.setItem(KEY, JSON.stringify({ contactsOnly: this.contactsOnly, entries: [...entries.values()] }));
    this.entries = entries;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('konofix-people-changed'));
  }
  setContactsOnly(value: boolean): void {
    this.storage?.setItem(KEY, JSON.stringify({ contactsOnly: value, entries: this.list() }));
    this.contactsOnly = value;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('konofix-people-changed'));
  }
  blocked(id: string): boolean { return this.entries.get(id)?.blocked === true; }
  muted(id: string): boolean { return this.blocked(id) || this.entries.get(id)?.muted === true; }
  allows(id: string): boolean { return !this.blocked(id) && (!this.contactsOnly || this.entries.get(id)?.favorite === true); }
  allowInvitation(id: string, now = Date.now()): boolean {
    if (!this.allows(id)) return false;
    for (const [key, times] of this.attempts) {
      const recent = times.filter(time => now - time < 60_000);
      if (recent.length) this.attempts.set(key, recent); else this.attempts.delete(key);
    }
    const recent = this.attempts.get(id) ?? [];
    const count = [...this.attempts.values()].reduce((total, times) => total + times.length, 0);
    if (recent.length >= 3 || count >= 12) return false;
    this.attempts.set(id, [...recent, now]); return true;
  }
}
export const people = new PeopleBook(typeof localStorage === 'undefined' ? undefined : localStorage);
export async function identityCode(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Konofix identity v1\n${id}`));
  return [...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ').toUpperCase();
}
