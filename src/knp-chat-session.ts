export type KnpDelivery = 'incoming' | 'queued' | 'transport_delivered' | 'received' | 'unconfirmed' | 'failed';
export type KnpContact = { node_id: string; endpoint: string; label: string };
export type KnpMessage = {
  id: string; peer_node_id: string; outgoing: boolean; text: string;
  timestamp: number; delivery: KnpDelivery; transport_id: string | null;
};
export type KnpSnapshot = {
  session_id: string; node_id: string; local_addr: string; nick: string;
  revision: number; contacts: KnpContact[]; messages: KnpMessage[];
};
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Every asynchronous result belongs to one native session and UI generation. */
export class KnpChatSession {
  snapshot: KnpSnapshot | null = null;
  private generation = 0;
  private refreshing = false;
  private starting = false;
  private stopping = false;

  constructor(private invoke: Invoke, private changed: (snapshot: KnpSnapshot) => void) {}

  async start(nick: string, profile: string): Promise<void> {
    if (this.snapshot || this.starting) throw new Error('Chat session already active.');
    this.starting = true;
    const generation = ++this.generation;
    try {
      const snapshot = await this.invoke<KnpSnapshot>('start_knp_chat', { nick, profile });
      if (generation !== this.generation) {
        await this.invoke('stop_knp_chat', { sessionId: snapshot.session_id });
        return;
      }
      this.snapshot = snapshot;
      this.changed(snapshot);
    } finally { this.starting = false; }
  }

  async refresh(): Promise<void> {
    if (!this.snapshot || this.refreshing || this.stopping) return;
    this.refreshing = true;
    const sessionId = this.snapshot.session_id;
    const generation = this.generation;
    try {
      const next = await this.invoke<KnpSnapshot>('knp_chat_snapshot', { sessionId });
      if (generation !== this.generation || next.session_id !== this.snapshot?.session_id) return;
      if (next.revision <= this.snapshot.revision) return;
      this.snapshot = next;
      this.changed(next);
    } catch (error) {
      if (generation === this.generation) throw error;
    } finally { this.refreshing = false; }
  }

  private async command<T>(name: string, args: Record<string, unknown>): Promise<T | undefined> {
    if (!this.snapshot || this.stopping) throw new Error('Chat session is not active.');
    const generation = this.generation;
    const result = await this.invoke<T>(name, { ...args, sessionId: this.snapshot.session_id });
    if (generation !== this.generation) return;
    return result;
  }

  async addContact(contact: KnpContact): Promise<void> {
    await this.command('add_knp_chat_contact', { nodeId: contact.node_id, endpoint: contact.endpoint, label: contact.label });
    await this.refresh();
  }

  send(peerNodeId: string, text: string): Promise<string | undefined> {
    return this.command<string>('send_knp_chat_message', { peerNodeId, text });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    ++this.generation;
    try {
      if (this.snapshot) await this.invoke('stop_knp_chat', { sessionId: this.snapshot.session_id });
      this.snapshot = null;
    } finally { this.stopping = false; }
  }
}
