import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { normalizeNickColor, renderChatText } from './chat-expression';
import { t } from './i18n';
import {
  PrivateConversationStore,
  type PrivateChatMessage,
  type SecureRoomInfo,
  roomSecurity,
} from './private-chat-state';
import './secure-ui.css';

const conversations = new PrivateConversationStore();
const roomState = new Map<string, SecureRoomInfo>();
const authorizedRoomRevision = new Map<string, number>();
const ownedRooms = new Set<string>();
const offlinePeers = new Set<string>();

let localPeerId = '';
let activePrivatePeerId = '';
let activePrivateNick = '';
let activePrivateColor = '';
let bypassRoomClick = '';
let roomOperationPending = false;

function esc(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[character]!));
}

function roomButton(roomId: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[data-room="${CSS.escape(roomId)}"]`);
}

function roomIsProtected(roomId: string): boolean {
  const room = roomState.get(roomId);
  return Boolean(room && roomSecurity(room).protected);
}

function roomRevision(roomId: string): number {
  const room = roomState.get(roomId);
  return room ? roomSecurity(room).revision : 0;
}

function rememberRoom(room: SecureRoomInfo): void {
  const previous = roomState.get(room.id);
  roomState.set(room.id, room);
  const previousRevision = previous ? roomSecurity(previous).revision : 0;
  const nextRevision = roomSecurity(room).revision;
  if (previousRevision !== nextRevision) authorizedRoomRevision.delete(room.id);
  queueAugment();
}

function queueAugment(): void {
  queueMicrotask(augmentMainUi);
}

function augmentMainUi(): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-room]').forEach(button => {
    const roomId = button.dataset.room ?? '';
    if (!roomId || roomId === 'world') return;
    const locked = roomIsProtected(roomId);
    button.classList.toggle('secure-room-locked', locked);
    let lock = button.querySelector<HTMLElement>('.secure-room-lock');
    if (locked && !lock) {
      lock = document.createElement('i');
      lock.className = 'secure-room-lock';
      lock.textContent = '🔒';
      lock.title = t('rooms.locked');
      const count = button.querySelector('b');
      if (count) button.insertBefore(lock, count);
      else button.appendChild(lock);
    } else if (!locked) {
      lock?.remove();
    }

    const existingManage = document.querySelector<HTMLButtonElement>(`button[data-room-password-manage="${CSS.escape(roomId)}"]`);
    if (ownedRooms.has(roomId) && !existingManage) {
      const manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'secure-room-manage';
      manage.dataset.roomPasswordManage = roomId;
      manage.title = t('rooms.passwordManage');
      manage.setAttribute('aria-label', `${t('rooms.passwordManage')}: ${roomId}`);
      manage.textContent = locked ? '🔐' : '🔓';
      button.insertAdjacentElement('afterend', manage);
    } else if (existingManage) {
      existingManage.textContent = locked ? '🔐' : '🔓';
    }
  });

  document.querySelectorAll<HTMLElement>('#peerList .user').forEach(row => {
    const fileButton = row.querySelector<HTMLButtonElement>('[data-send-peer]');
    const peerId = fileButton?.dataset.sendPeer ?? '';
    if (!peerId || row.querySelector('[data-private-peer]')) return;
    const nick = row.querySelector('strong')?.textContent?.trim() || peerId;
    const color = row.querySelector<HTMLElement>('strong')?.style.color || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini-private';
    button.dataset.privatePeer = peerId;
    button.dataset.privateNick = nick;
    button.dataset.privateColor = color;
    button.title = t('private.open', { nick });
    button.setAttribute('aria-label', t('private.open', { nick }));
    button.textContent = '💬';
    const unread = conversations.unreadCount(peerId);
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'private-unread';
      badge.textContent = String(Math.min(99, unread));
      button.appendChild(badge);
    }
    fileButton.insertAdjacentElement('beforebegin', button);
  });
}

function promptRoomName(): string | null {
  const raw = prompt(t('rooms.newPrompt'));
  if (!raw) return null;
  const title = raw.trim().replace(/^#/, '').trim();
  if (!/^[\p{L}\p{N}_\- ]{3,32}$/u.test(title)) {
    alert(t('rooms.invalidName'));
    return null;
  }
  return title;
}

async function createRoomWithOptionalPassword(): Promise<void> {
  if (roomOperationPending) return;
  const title = promptRoomName();
  if (!title) return;
  const password = prompt(t('rooms.passwordOptionalPrompt'));
  if (password === null) return;

  roomOperationPending = true;
  try {
    const room = password.length > 0
      ? await invoke<SecureRoomInfo>('create_secure_room', { title, password })
      : await invoke<SecureRoomInfo>('create_room', { title });
    ownedRooms.add(room.id);
    rememberRoom(room);
    setTimeout(() => {
      const button = roomButton(room.id);
      if (button) button.click();
    }, 0);
  } catch (error) {
    alert(t('rooms.passwordError', { error: String(error) }));
  } finally {
    roomOperationPending = false;
  }
}

async function authorizeProtectedRoom(roomId: string, button: HTMLButtonElement): Promise<void> {
  if (roomOperationPending) return;
  const revision = roomRevision(roomId);
  if (!roomIsProtected(roomId) || ownedRooms.has(roomId) || authorizedRoomRevision.get(roomId) === revision) {
    bypassRoomClick = roomId;
    button.click();
    return;
  }

  const password = prompt(t('rooms.passwordJoinPrompt'));
  if (password === null) return;
  roomOperationPending = true;
  try {
    await invoke('authorize_room_entry', { roomId, password });
    authorizedRoomRevision.set(roomId, revision);
    bypassRoomClick = roomId;
    button.click();
  } catch (error) {
    authorizedRoomRevision.delete(roomId);
    alert(t('rooms.passwordError', { error: String(error) }));
  } finally {
    roomOperationPending = false;
  }
}

async function manageRoomPassword(roomId: string): Promise<void> {
  if (!ownedRooms.has(roomId) || roomOperationPending) return;
  const raw = prompt(t('rooms.passwordChangePrompt'));
  if (raw === null) return;
  roomOperationPending = true;
  try {
    const room = await invoke<SecureRoomInfo>('update_room_password', {
      roomId,
      password: raw.length > 0 ? raw : null,
    });
    rememberRoom(room);
    alert(raw.length > 0 ? t('rooms.passwordUpdated') : t('rooms.passwordRemoved'));
  } catch (error) {
    alert(t('rooms.passwordError', { error: String(error) }));
  } finally {
    roomOperationPending = false;
  }
}

function privateMessageHtml(message: PrivateChatMessage, peerId: string): string {
  const incoming = message.peer_id === peerId;
  const color = normalizeNickColor(message.nick_color);
  const time = new Date(Number(message.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<article class="private-message ${incoming ? 'incoming' : 'mine'}">
    <div class="private-meta"><strong style="color:${color}">${esc(message.nick)}</strong><time>${esc(time)}</time></div>
    <p>${renderChatText(message.text)}</p>
  </article>`;
}

function renderPrivateModal(): void {
  if (!activePrivatePeerId) {
    document.querySelector('#privateChatModal')?.remove();
    return;
  }
  let wrap = document.querySelector<HTMLDivElement>('#privateChatModal');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'privateChatModal';
    wrap.className = 'private-chat-wrap';
    document.body.appendChild(wrap);
  }

  const messages = conversations.conversation(activePrivatePeerId);
  const offline = offlinePeers.has(activePrivatePeerId);
  const color = normalizeNickColor(activePrivateColor);
  wrap.innerHTML = `<section class="private-chat-modal glass" role="dialog" aria-modal="true" aria-label="${esc(t('private.open', { nick: activePrivateNick }))}">
    <header class="private-chat-head">
      <div><span class="eyebrow">PRIVATE P2P</span><h3 style="color:${color}">${esc(activePrivateNick)}</h3><small>${esc(offline ? t('private.offline') : t('private.subtitle'))}</small></div>
      <button type="button" data-private-close aria-label="${esc(t('common.cancel'))}">×</button>
    </header>
    <div class="private-messages" data-private-messages>
      ${messages.length ? messages.map(message => privateMessageHtml(message, activePrivatePeerId)).join('') : `<div class="private-empty">${esc(t('private.subtitle'))}</div>`}
    </div>
    <footer class="private-compose">
      <input data-private-input maxlength="4000" autocomplete="off" spellcheck="true" placeholder="${esc(t('private.messageTo', { nick: activePrivateNick }))}" ${offline ? 'disabled' : ''}/>
      <button type="button" class="send" data-private-send ${offline ? 'disabled' : ''}>➤</button>
    </footer>
  </section>`;

  const close = () => {
    conversations.close();
    activePrivatePeerId = '';
    wrap?.remove();
    queueAugment();
  };
  wrap.querySelector('[data-private-close]')?.addEventListener('click', close);
  const input = wrap.querySelector<HTMLInputElement>('[data-private-input]');
  const send = () => { void sendPrivateMessage(); };
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) send();
  });
  wrap.querySelector('[data-private-send]')?.addEventListener('click', send);
  const messageList = wrap.querySelector<HTMLDivElement>('[data-private-messages]');
  if (messageList) messageList.scrollTop = messageList.scrollHeight;
  input?.focus();
}

function openPrivateChat(peerId: string, nick: string, color: string): void {
  activePrivatePeerId = peerId;
  activePrivateNick = nick;
  activePrivateColor = color;
  conversations.open(peerId);
  renderPrivateModal();
  queueAugment();
}

async function sendPrivateMessage(): Promise<void> {
  if (!activePrivatePeerId || offlinePeers.has(activePrivatePeerId)) return;
  const input = document.querySelector<HTMLInputElement>('[data-private-input]');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const message = await invoke<PrivateChatMessage>('send_private_message', {
      peerId: activePrivatePeerId,
      text,
    });
    localPeerId = localPeerId || message.peer_id;
    conversations.push(message, localPeerId);
    input.value = '';
    renderPrivateModal();
  } catch (error) {
    alert(t('private.sendError', { error: String(error) }));
    input.disabled = false;
    input.focus();
  }
}

function installCaptureRouter(): void {
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const newRoom = target.closest<HTMLElement>('#newRoom');
    if (newRoom) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void createRoomWithOptionalPassword();
      return;
    }

    const manage = target.closest<HTMLButtonElement>('[data-room-password-manage]');
    if (manage) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const roomId = manage.dataset.roomPasswordManage;
      if (roomId) void manageRoomPassword(roomId);
      return;
    }

    const privateButton = target.closest<HTMLButtonElement>('[data-private-peer]');
    if (privateButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const peerId = privateButton.dataset.privatePeer ?? '';
      if (peerId) {
        openPrivateChat(
          peerId,
          privateButton.dataset.privateNick || peerId,
          privateButton.dataset.privateColor || '',
        );
      }
      return;
    }

    const room = target.closest<HTMLButtonElement>('button[data-room]');
    const roomId = room?.dataset.room ?? '';
    if (!room || !roomId || roomId === 'world' || !roomIsProtected(roomId) || ownedRooms.has(roomId)) return;
    if (bypassRoomClick === roomId) {
      bypassRoomClick = '';
      return;
    }
    const revision = roomRevision(roomId);
    if (authorizedRoomRevision.get(roomId) === revision) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void authorizeProtectedRoom(roomId, room);
  }, true);
}

async function wireSecureEvents(): Promise<void> {
  await listen<SecureRoomInfo>('room-created', event => rememberRoom(event.payload));
  await listen<SecureRoomInfo>('room-security-updated', event => rememberRoom(event.payload));
  await listen<{ room_id: string }>('room-closed', event => {
    roomState.delete(event.payload.room_id);
    authorizedRoomRevision.delete(event.payload.room_id);
    ownedRooms.delete(event.payload.room_id);
    queueAugment();
  });
  await listen<PrivateChatMessage>('private-message', event => {
    const message = event.payload;
    localPeerId = localPeerId || message.target_peer_id;
    const result = conversations.push(message, localPeerId);
    if (!result?.inserted) return;
    const peerButton = document.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(result.peerId)}"]`);
    if (activePrivatePeerId === result.peerId) {
      activePrivateNick = peerButton?.dataset.privateNick || message.nick;
      activePrivateColor = peerButton?.dataset.privateColor || message.nick_color || '';
      conversations.open(result.peerId);
      renderPrivateModal();
    }
    queueAugment();
  });
  await listen<{ peer_id: string }>('peer-offline', event => {
    offlinePeers.add(event.payload.peer_id);
    if (activePrivatePeerId === event.payload.peer_id) renderPrivateModal();
  });
  await listen<{ peer_id: string }>('peer-online', event => {
    offlinePeers.delete(event.payload.peer_id);
    if (activePrivatePeerId === event.payload.peer_id) renderPrivateModal();
    queueAugment();
  });
  await listen('network-error', () => {
    conversations.reset();
    roomState.clear();
    authorizedRoomRevision.clear();
    ownedRooms.clear();
    offlinePeers.clear();
    localPeerId = '';
    activePrivatePeerId = '';
    document.querySelector('#privateChatModal')?.remove();
  });
}

installCaptureRouter();
new MutationObserver(queueAugment).observe(document.body, { childList: true, subtree: true });
wireSecureEvents().catch(error => console.error('Secure UI event wiring failed', error));
queueAugment();
