export type SecureRoomInfo = {
  id: string;
  title: string;
  owner?: string;
  users?: number;
  password_protected?: boolean;
  auth_revision?: number;
};

export type PrivateChatMessage = {
  id: string;
  peer_id: string;
  target_peer_id: string;
  nick: string;
  nick_color?: string;
  text: string;
  timestamp: number;
};

export type RoomSecurity = {
  protected: boolean;
  revision: number;
};

const MAX_PRIVATE_MESSAGES_PER_PEER = 1000;

export function roomSecurity(room: SecureRoomInfo): RoomSecurity {
  const protectedRoom = room.password_protected === true;
  const rawRevision = Number(room.auth_revision);
  const revision = Number.isSafeInteger(rawRevision) && rawRevision > 0 ? rawRevision : 0;
  return { protected: protectedRoom, revision };
}

export function roomNeedsPassword(room: SecureRoomInfo, localPeerId: string): boolean {
  const security = roomSecurity(room);
  return security.protected && room.owner !== localPeerId;
}

function otherPeer(message: PrivateChatMessage, selfPeerId: string): string | null {
  if (message.peer_id === selfPeerId && message.target_peer_id !== selfPeerId) {
    return message.target_peer_id;
  }
  if (message.target_peer_id === selfPeerId && message.peer_id !== selfPeerId) {
    return message.peer_id;
  }
  return null;
}

export class PrivateConversationStore {
  private readonly messages = new Map<string, PrivateChatMessage[]>();
  private readonly unread = new Map<string, number>();
  private activePeerId = '';

  open(peerId: string): void {
    this.activePeerId = peerId;
    this.unread.set(peerId, 0);
  }

  close(): void {
    this.activePeerId = '';
  }

  activePeer(): string {
    return this.activePeerId;
  }

  unreadCount(peerId: string): number {
    return this.unread.get(peerId) ?? 0;
  }

  unreadTotal(): number {
    let total = 0;
    for (const value of this.unread.values()) total += value;
    return total;
  }

  conversation(peerId: string): readonly PrivateChatMessage[] {
    return this.messages.get(peerId) ?? [];
  }

  push(message: PrivateChatMessage, selfPeerId: string): { peerId: string; inserted: boolean } | null {
    const peerId = otherPeer(message, selfPeerId);
    if (!peerId) return null;

    const list = this.messages.get(peerId) ?? [];
    if (list.some(item => item.id === message.id)) {
      return { peerId, inserted: false };
    }
    list.push(message);
    if (list.length > MAX_PRIVATE_MESSAGES_PER_PEER) {
      list.splice(0, list.length - MAX_PRIVATE_MESSAGES_PER_PEER);
    }
    this.messages.set(peerId, list);

    const incoming = message.target_peer_id === selfPeerId;
    if (incoming && this.activePeerId !== peerId) {
      this.unread.set(peerId, Math.min(999, (this.unread.get(peerId) ?? 0) + 1));
    }
    return { peerId, inserted: true };
  }

  reset(): void {
    this.messages.clear();
    this.unread.clear();
    this.activePeerId = '';
  }
}
