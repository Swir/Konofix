import { x } from './experience-i18n';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { KONOFIX_EMOJI, normalizeNickColor, renderChatText } from './chat-expression';
import { t } from './i18n';
import {
  PrivateConversationStore,
  type PrivateChatMessage,
  type SecureRoomInfo,
  roomSecurity,
} from './private-chat-state';
import { peerTransport, sendFileToPeer, worldRelay, isPeerOnline } from './main';
import type { AudioCallState } from './peer-transport';
import { CallTonePlayer } from './call-tones';
import { PrivateAudioOutput } from './private-audio-output';
import './secure-ui.css';
import { people, identityCode } from './people';
import { historyVault } from './history-vault';


const conversations = new PrivateConversationStore();
const roomState = new Map<string, SecureRoomInfo>();
const authorizedRoomRevision = new Map<string, number>();
const ownedRooms = new Set<string>();
const offlinePeers = new Set<string>();
const ignoredPrivatePeers = new Set<string>();
const audioStates = new Map<string, { state: AudioCallState; error?: string }>();
const mutedAudioPeers = new Set<string>();
const callStarted = new Map<string, number>();
const privateDrafts = new Map<string, string>();
const callTones = new CallTonePlayer();
const privateAudioOutput = new PrivateAudioOutput({
  onPlaybackState(peerId, blocked) {
    const state = audioStates.get(peerId);
    if (!state || ['ended', 'rejected', 'failed'].includes(state.state)) return;
    if (blocked) {
      audioStates.set(peerId, { ...state, error: t('audio.outputBlocked') });
    } else if (state.error === t('audio.outputBlocked')) {
      audioStates.set(peerId, { state: state.state });
    } else return;
    if (activePrivatePeerId === peerId) renderPrivateModal();
  },
});
const PRIVATE_MESSAGES_ENABLED_KEY = 'konofix.privateMessagesEnabled';

let lastSyncedPrivateMessagesEnabled: boolean | null = null;
let localPeerId = '';
let activePrivatePeerId = '';
let activePrivateNick = '';
let activePrivateColor = '';
let bypassRoomClick = '';
let roomOperationPending = false;
let augmentQueued = false;

function esc(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[character]!));
}

function privateMessagesEnabled(): boolean {
  return localStorage.getItem(PRIVATE_MESSAGES_ENABLED_KEY) !== '0';
}

async function syncPrivateMessagePolicy(force = false): Promise<void> {
  const enabled = privateMessagesEnabled();
  if (!force && lastSyncedPrivateMessagesEnabled === enabled) return;
  try {
    await invoke('set_private_messages_enabled', { enabled });
    lastSyncedPrivateMessagesEnabled = enabled;
  } catch {
    lastSyncedPrivateMessagesEnabled = null;
  }
}

function trapDialogFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )).filter(element => element.getAttribute('aria-hidden') !== 'true');
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
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
  if (augmentQueued) return;
  augmentQueued = true;
  queueMicrotask(() => {
    augmentQueued = false;
    augmentMainUi();
  });
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

    const manageIcon = locked ? '🔐' : '🔓';
    const existingManage = document.querySelector<HTMLButtonElement>(`button[data-room-password-manage="${CSS.escape(roomId)}"]`);
    if (ownedRooms.has(roomId) && !existingManage) {
      const manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'secure-room-manage';
      manage.dataset.roomPasswordManage = roomId;
      manage.title = t('rooms.passwordManage');
      manage.setAttribute('aria-label', `${t('rooms.passwordManage')}: ${roomId}`);
      manage.textContent = manageIcon;
      button.insertAdjacentElement('afterend', manage);
    } else if (existingManage && existingManage.textContent !== manageIcon) {
      existingManage.textContent = manageIcon;
    }
  });

  augmentPrivateSettings();

  document.querySelectorAll<HTMLElement>('#peerList .user').forEach(row => {
    const fileButton = row.querySelector<HTMLButtonElement>('[data-send-peer], [data-send-relay-peer]');
    const peerId = row.dataset.peerId ?? fileButton?.dataset.sendPeer ?? fileButton?.dataset.sendRelayPeer ?? '';
    if (!peerId) return;
    const nick = row.dataset.peerNick || row.querySelector('strong')?.textContent?.trim() || peerId;
    const color = row.dataset.peerColor || row.querySelector<HTMLElement>('strong')?.style.color || '';
    let button = row.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(peerId)}"]`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'mini-private';
      button.dataset.privatePeer = peerId;
      button.textContent = '💬';
      if (fileButton) fileButton.insertAdjacentElement('beforebegin', button);
      else row.appendChild(button);
    }
    button.dataset.privateNick = nick;
    button.dataset.privateColor = color;
    const openLabel = t('private.open', { nick });
    button.title = openLabel;

    const unread = conversations.unreadCount(peerId);
    let badge = button.querySelector<HTMLSpanElement>('.private-unread');
    if (unread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'private-unread';
        button.appendChild(badge);
      }
      const unreadText = String(Math.min(99, unread));
      if (badge.textContent !== unreadText) badge.textContent = unreadText;
      const unreadLabel = t('private.unread', { count: unread });
      if (badge.getAttribute('aria-label') !== unreadLabel) badge.setAttribute('aria-label', unreadLabel);
      const accessibleLabel = `${openLabel}. ${unreadLabel}`;
      if (button.getAttribute('aria-label') !== accessibleLabel) button.setAttribute('aria-label', accessibleLabel);
    } else {
      badge?.remove();
      if (button.getAttribute('aria-label') !== openLabel) button.setAttribute('aria-label', openLabel);
    }
  });
}

function augmentPrivateSettings(): void {
  const modal = document.querySelector<HTMLDivElement>('#networkModal [data-settings-privacy]');
  if (!modal || modal.querySelector('[data-private-settings]')) return;
  const section = document.createElement('section');
  section.className = 'private-settings-card';
  section.dataset.privateSettings = 'true';
  section.innerHTML = `
    <div><strong>${esc(t('private.settingsTitle'))}</strong><small>${esc(t('private.allowNewHelp'))}</small></div>
    <label class="private-setting-toggle">
      <input type="checkbox" data-private-enabled ${privateMessagesEnabled() ? 'checked' : ''} />
      <span>${esc(t('private.allowNew'))}</span>
    </label>`;
  modal.appendChild(section);
  section.querySelector<HTMLInputElement>('[data-private-enabled]')?.addEventListener('change', event => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem(PRIVATE_MESSAGES_ENABLED_KEY, enabled ? '1' : '0');
    if (!enabled) document.querySelectorAll('.private-notice-wrap').forEach(element => element.remove());
    void syncPrivateMessagePolicy(true);
  });
}

function createRoomWithOptionalPassword(): void {
  if (roomOperationPending || document.querySelector('#secureRoomCreateModal')) return;

  const wrap = document.createElement('div');
  wrap.id = 'secureRoomCreateModal';
  wrap.className = 'modal-wrap secure-room-create-wrap';
  wrap.innerHTML = `<section class="modal glass compact-modal secure-room-create-modal" role="dialog" aria-modal="true" aria-labelledby="secureRoomCreateTitle">
    <div class="modal-head">
      <div><span class="eyebrow">ROOMS 2.0</span><h3 id="secureRoomCreateTitle">${esc(t('rooms.create'))}</h3></div>
      <button type="button" data-room-create-close aria-label="${esc(t('common.cancel'))}">×</button>
    </div>
    <label for="secureRoomName">${esc(t('rooms.newPrompt'))}</label>
    <input id="secureRoomName" maxlength="32" autocomplete="off" spellcheck="false" />
    <label for="secureRoomPassword">${esc(t('rooms.passwordManage'))}</label>
    <input id="secureRoomPassword" type="password" maxlength="64" autocomplete="new-password" />
    <p class="secure-room-create-hint">${esc(t('rooms.passwordOptionalPrompt'))}</p>
    <div class="error" data-room-create-error role="alert" aria-live="polite"></div>
    <div class="secure-room-create-actions">
      <button type="button" class="ghost" data-room-create-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="primary compact" data-room-create-submit>${esc(t('rooms.create'))}</button>
    </div>
  </section>`;
  document.body.appendChild(wrap);

  const nameInput = wrap.querySelector<HTMLInputElement>('#secureRoomName')!;
  const passwordInput = wrap.querySelector<HTMLInputElement>('#secureRoomPassword')!;
  const error = wrap.querySelector<HTMLDivElement>('[data-room-create-error]')!;
  const submit = wrap.querySelector<HTMLButtonElement>('[data-room-create-submit]')!;
  const close = () => {
    if (roomOperationPending) return;
    wrap.remove();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#newRoom')?.focus());
  };
  wrap.querySelectorAll('[data-room-create-close]').forEach(button => button.addEventListener('click', close));
  wrap.addEventListener('click', event => { if (event.target === wrap) close(); });
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Tab') trapDialogFocus(wrap, event);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  const create = async () => {
    if (roomOperationPending) return;
    const title = nameInput.value.trim().replace(/^#/, '').trim();
    const password = passwordInput.value;
    error.textContent = '';
    if (!/^[\p{L}\p{N}_\- ]{3,32}$/u.test(title)) {
      error.textContent = t('rooms.invalidName');
      nameInput.focus();
      return;
    }

    roomOperationPending = true;
    submit.disabled = true;
    nameInput.disabled = true;
    passwordInput.disabled = true;
    try {
      const room = password.length > 0
        ? await invoke<SecureRoomInfo>('create_secure_room', { title, password })
        : await invoke<SecureRoomInfo>('create_room', { title });
      ownedRooms.add(room.id);
      rememberRoom(room);
      wrap.remove();
      requestAnimationFrame(() => roomButton(room.id)?.click());
    } catch (createError) {
      error.textContent = t('rooms.passwordError', { error: String(createError) });
      submit.disabled = false;
      nameInput.disabled = false;
      passwordInput.disabled = false;
      passwordInput.focus();
    } finally {
      roomOperationPending = false;
    }
  };
  submit.addEventListener('click', () => { void create(); });
  [nameInput, passwordInput].forEach(input => input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void create();
    }
  }));
  nameInput.focus();
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

function showPrivateNotification(message: PrivateChatMessage, peerId: string, nick: string, color: string): void {
  if (!privateMessagesEnabled() || ignoredPrivatePeers.has(peerId) || people.muted(peerId) || !people.allowInvitation(peerId)) return;
  const id = `private-notice-${peerId}`;
  if (document.getElementById(id)) return;
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.className = 'modal-wrap file-offer-wrap private-notice-wrap';
  const preview = message.text.slice(0, 240);
  wrap.innerHTML = `<section class="modal glass file-offer-modal private-notice-modal" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}-title">
    <div class="offer-icon">💬</div>
    <span class="eyebrow">PRIVATE P2P</span>
    <h3 id="${esc(id)}-title">${esc(t('private.noticeTitle', { nick }))}</h3>
    <div class="private-notice-preview" style="--nick-color:${normalizeNickColor(color)}">${renderChatText(preview)}</div>
    <div class="safe-note">${esc(t('private.noticeHint'))}</div>
    <div class="offer-actions">
      <button type="button" class="ghost" data-private-ignore>${esc(t('private.ignore'))}</button>
      <button type="button" class="primary compact" data-private-open-notice>${esc(t('private.openNow'))}</button>
    </div>
  </section>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', event => { if (event.target === wrap) close(); });
  wrap.querySelector('[data-private-ignore]')?.addEventListener('click', () => {
    ignoredPrivatePeers.add(peerId);
    close();
    queueAugment();
  });
  wrap.querySelector('[data-private-open-notice]')?.addEventListener('click', () => {
    close();
    openPrivateChat(peerId, nick, color);
  });
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

  const oldInput = wrap.querySelector<HTMLInputElement>('[data-private-input]');
  if (oldInput && wrap.dataset.peerId) privateDrafts.set(wrap.dataset.peerId, oldInput.value);
  const draft = privateDrafts.get(activePrivatePeerId) ?? '';
  wrap.dataset.peerId = activePrivatePeerId;
  const selection = oldInput?.selectionStart ?? 0;
  const focused = document.activeElement === oldInput;
  const oldSearch = wrap.querySelector<HTMLInputElement>('[data-private-search]')?.value ?? '';
  const messages = conversations.conversation(activePrivatePeerId);
  const contact = people.get(activePrivatePeerId);
  const offline = offlinePeers.has(activePrivatePeerId) || !isPeerOnline(activePrivatePeerId);
  const color = normalizeNickColor(activePrivateColor);
  const audio = audioStates.get(activePrivatePeerId);
  const audioActive = audio && ['calling', 'ringing', 'connecting', 'connected', 'muted'].includes(audio.state);
  const audioStatus = audio?.state === 'calling' ? t('audio.calling')
    : audio?.state === 'ringing' ? t('audio.ringing')
      : audio?.state === 'connecting' ? t('audio.connecting')
        : audio?.state === 'connected' ? (audio.error ?? t('audio.connected'))
          : audio?.state === 'muted' ? t('audio.muted')
            : audio?.state === 'failed' ? t('audio.failed', { error: audio.error ?? 'WebRTC' })
              : (offline ? t('private.offline') : t('private.subtitle'));
  const audioCapable = activePrivatePeerId.startsWith('nostr:') && 'RTCPeerConnection' in window && navigator.mediaDevices?.getUserMedia;
  wrap.innerHTML = `<section class="private-chat-modal glass" role="dialog" aria-modal="true" aria-labelledby="privateChatTitle">
    <header class="private-chat-head">
      <div><span class="eyebrow">PRIVATE P2P</span><h3 id="privateChatTitle" style="color:${color}">${esc(activePrivateNick)}</h3><span class="private-peer-status ${offline ? 'offline' : ''}"><i></i>${esc(audioStatus)}</span>${audioActive ? `<span class="call-duration" data-call-duration="${esc(activePrivatePeerId)}"></span>` : ''}</div>
      <div class="private-call-actions">
        ${audioCapable && !audioActive ? `<button type="button" data-audio-call title="${esc(t('audio.start'))}" aria-label="${esc(t('audio.start'))}" ${offline ? 'disabled' : ''}>☎</button>` : ''}
        ${audioActive && (audio?.state === 'connected' || audio?.state === 'muted') ? `<button type="button" data-audio-mute title="${esc(mutedAudioPeers.has(activePrivatePeerId) ? t('audio.unmute') : t('audio.mute'))}" aria-label="${esc(mutedAudioPeers.has(activePrivatePeerId) ? t('audio.unmute') : t('audio.mute'))}">${mutedAudioPeers.has(activePrivatePeerId) ? '🔇' : '🎙'}</button>` : ''}
        ${audioActive ? `<button type="button" data-audio-hangup title="${esc(t('audio.hangup'))}" aria-label="${esc(t('audio.hangup'))}">⏹</button>` : ''}
        <button type="button" data-private-close aria-label="${esc(t('common.cancel'))}">×</button>
      </div>
    </header>
    <div class="private-tools">
      <button class="ghost" data-contact-favorite>${contact?.favorite ? x('favorite') : x('addContact')}</button>
      <button class="ghost" data-contact-verify>${contact?.verified ? x('verified') : x('verifyIdentity')}</button>
      <button class="ghost" data-contact-mute>${contact?.muted ? x('unmute') : x('mute')}</button>
      <button class="ghost danger" data-contact-block>${x('block')}</button>
      <input data-private-search type="search" placeholder="${x('searchConversation')}" aria-label="${x('searchConversation16')}">
    </div>
    <div class="private-messages" data-private-messages>
      ${messages.length ? messages.map(message => privateMessageHtml(message, activePrivatePeerId)).join('') : `<div class="private-empty">${esc(t('private.subtitle'))}</div>`}
    </div>
    <footer class="private-compose">
      <div class="private-compose-tools">
        <button type="button" data-private-file title="${esc(t('private.sendFile', { nick: activePrivateNick }))}" aria-label="${esc(t('private.sendFile', { nick: activePrivateNick }))}" ${offline ? 'disabled' : ''}>📎</button>
        <button type="button" data-private-emoji title="${esc(t('chat.emoji'))}" aria-label="${esc(t('chat.emoji'))}">☺</button>
        <div class="private-emoji-panel" data-private-emoji-panel hidden>
          ${KONOFIX_EMOJI.filter((item, index, items) => items.findIndex(other => other.glyph === item.glyph) === index).map(item => `<button type="button" data-private-emoji-code="${esc(item.code)}" title="${esc(item.code)} · ${esc(item.label)}">${item.glyph}</button>`).join('')}
        </div>
      </div>
      <input data-private-input maxlength="4000" autocomplete="off" spellcheck="true" placeholder="${esc(t('private.messageTo', { nick: activePrivateNick }))}" aria-label="${esc(t('private.messageTo', { nick: activePrivateNick }))}" ${offline ? 'disabled' : ''}/>
      <button type="button" class="send" data-private-send aria-label="${esc(t('common.send'))}" ${offline ? 'disabled' : ''}>➤</button>
    </footer>
  </section>`;

  const close = () => {
    const peerId = activePrivatePeerId;
    privateDrafts.set(peerId, wrap?.querySelector<HTMLInputElement>('[data-private-input]')?.value ?? '');
    conversations.close();
    activePrivatePeerId = '';
    wrap?.remove();
    queueAugment();
    requestAnimationFrame(() => {
      if (!peerId) return;
      document.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(peerId)}"]`)?.focus();
    });
  };
  wrap.querySelector('[data-private-close]')?.addEventListener('click', close);
  const selectedPeer = activePrivatePeerId, selectedNick = activePrivateNick, selectedColor = activePrivateColor;
  const changeContact = (changes: Parameters<typeof people.update>[1]) => { people.update(selectedPeer, { nick: selectedNick, color: selectedColor, ...changes }); renderPrivateModal(); };
  wrap.querySelector('[data-contact-favorite]')?.addEventListener('click', () => changeContact({ favorite: !contact?.favorite }));
  wrap.querySelector('[data-contact-mute]')?.addEventListener('click', () => changeContact({ muted: !contact?.muted }));
  wrap.querySelector('[data-contact-block]')?.addEventListener('click', () => { people.update(selectedPeer, { nick: selectedNick, color: selectedColor, blocked: true }); peerTransport.peerOffline(selectedPeer); close(); });
  wrap.querySelector('[data-contact-verify]')?.addEventListener('click', async () => {
    const code = await identityCode(selectedPeer);
    if (window.confirm(x('compareThroughATrustedChannelDoesYour') + '\n\n' + selectedPeer + '\n\n' + code)) changeContact({ verified: true });
  });
  const search = wrap.querySelector<HTMLInputElement>('[data-private-search]')!; search.value = oldSearch;
  const filterMessages = () => { wrap!.querySelectorAll<HTMLElement>('.private-message').forEach(item => { item.hidden = !item.textContent?.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()); }); };
  search.addEventListener('input', filterMessages); filterMessages();
  wrap.querySelector('[data-audio-call]')?.addEventListener('click', () => {
    void peerTransport.startCall(activePrivatePeerId).catch(error => {
      callTones.stop();
      audioStates.set(activePrivatePeerId, { state: 'failed', error: String(error) });
      renderPrivateModal();
    });
  });
  wrap.querySelector('[data-audio-hangup]')?.addEventListener('click', () => peerTransport.hangup(activePrivatePeerId));
  wrap.querySelector('[data-audio-mute]')?.addEventListener('click', () => {
    const peerId = activePrivatePeerId;
    const muted = !mutedAudioPeers.has(peerId);
    if (muted) mutedAudioPeers.add(peerId); else mutedAudioPeers.delete(peerId);
    peerTransport.setMuted(peerId, muted);
  });
  wrap.onkeydown = event => {
    if (event.key === 'Tab') trapDialogFocus(wrap, event);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const input = wrap.querySelector<HTMLInputElement>('[data-private-input]');
  const send = () => { void sendPrivateMessage(); };
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) send();
  });
  wrap.querySelector('[data-private-send]')?.addEventListener('click', send);
  wrap.querySelector('[data-private-file]')?.addEventListener('click', () => { void sendPrivateFile(); });
  const emojiToggle = wrap.querySelector<HTMLButtonElement>('[data-private-emoji]');
  const emojiPanel = wrap.querySelector<HTMLDivElement>('[data-private-emoji-panel]');
  emojiToggle?.addEventListener('click', () => {
    if (emojiPanel) emojiPanel.hidden = !emojiPanel.hidden;
  });
  wrap.querySelectorAll<HTMLButtonElement>('[data-private-emoji-code]').forEach(button => button.addEventListener('click', () => {
    if (!input) return;
    const code = button.dataset.privateEmojiCode ?? '';
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${code}${suffix}`;
    input.value = `${before}${inserted}${after}`.slice(0, 4000);
    const caret = Math.min(before.length + inserted.length, input.value.length);
    input.focus();
    input.setSelectionRange(caret, caret);
    if (emojiPanel) emojiPanel.hidden = true;
  }));
  const messageList = wrap.querySelector<HTMLDivElement>('[data-private-messages]');
  if (messageList) messageList.scrollTop = messageList.scrollHeight;
  if (input) { input.value = draft; if (focused || !oldInput) { input.focus(); input.setSelectionRange(selection, selection); } }
}

function openPrivateChat(peerId: string, nick: string, color: string): void {
  if (people.blocked(peerId)) return;
  ignoredPrivatePeers.delete(peerId);
  document.getElementById(`private-notice-${peerId}`)?.remove();
  activePrivatePeerId = peerId;
  activePrivateNick = nick;
  activePrivateColor = color;
  conversations.open(peerId);
  renderPrivateModal();
  queueAugment();
}

function showIncomingAudioCall(peerId: string, connectionId: string): void {
  document.querySelector(`#audio-call-${CSS.escape(connectionId)}`)?.remove();
  const peerButton = document.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(peerId)}"]`);
  const nick = peerButton?.dataset.privateNick || peerId;
  const modal = document.createElement('div');
  modal.id = `audio-call-${connectionId}`;
  modal.className = 'modal-wrap file-offer-wrap audio-call-wrap';
  modal.dataset.peerId = peerId;
  modal.innerHTML = `<section class="modal glass file-offer-modal audio-call-modal" role="dialog" aria-modal="true">
    <div class="offer-icon">☎</div>
    <span class="eyebrow">PRIVATE P2P AUDIO</span>
    <h3>${esc(t('audio.incomingTitle', { nick }))}</h3>
    <div class="safe-note">${esc(t('audio.incomingHelp'))}</div>
    <div class="offer-actions"><button type="button" class="ghost" data-audio-reject>${esc(t('audio.reject'))}</button><button type="button" class="primary compact" data-audio-accept>${esc(t('audio.accept'))}</button></div>
  </section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-audio-reject]')?.addEventListener('click', () => { peerTransport.rejectCall(connectionId); close(); });
  modal.querySelector('[data-audio-accept]')?.addEventListener('click', () => {
    const button = modal.querySelector<HTMLButtonElement>('[data-audio-accept]');
    if (button) button.disabled = true;
    void peerTransport.acceptCall(connectionId).then(() => {
      close();
      openPrivateChat(peerId, nick, peerButton?.dataset.privateColor || '');
    }).catch(error => {
      peerTransport.rejectCall(connectionId);
      close();
      alert(t('audio.failed', { error: String(error) }));
    });
  });
}

function attachRemoteAudio(peerId: string, stream: MediaStream | null): void {
  privateAudioOutput.attach(peerId, stream);
}

function resumePrivateAudio(): void {
  privateAudioOutput.retry();
}

window.addEventListener('pointerdown', resumePrivateAudio, { passive: true });
window.addEventListener('keydown', resumePrivateAudio);

async function sendPrivateFile(): Promise<void> {
  if (!activePrivatePeerId || offlinePeers.has(activePrivatePeerId)) return;
  if (activePrivatePeerId.startsWith('nostr:')) {
    await sendFileToPeer(activePrivatePeerId);
    return;
  }
  try {
    await invoke('offer_file', {
      peerId: activePrivatePeerId,
      roomId: null,
    });
  } catch (error) {
    alert(t('transfer.startError', { error: String(error) }));
  }
}

async function sendPrivateMessage(): Promise<void> {
  if (!activePrivatePeerId || offlinePeers.has(activePrivatePeerId)) return;
  const input = document.querySelector<HTMLInputElement>('[data-private-input]');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const message = activePrivatePeerId.startsWith('nostr:')
      ? worldRelay.publishPrivate(activePrivatePeerId, text)
      : await invoke<PrivateChatMessage>('send_private_message', { peerId: activePrivatePeerId, text });
    localPeerId = localPeerId || message.peer_id;
    conversations.push(message, message.peer_id);
    void historyVault?.append(message.peer_id, message).catch(() => window.dispatchEvent(new Event('konofix-history-error')));
    input.value = '';
    privateDrafts.delete(activePrivatePeerId);
    renderPrivateModal();
  } catch (error) {
    const detail = String(error);
    alert(detail.includes('private_disabled') ? t('private.blocked') : t('private.sendError', { error: detail }));
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
    if (!people.allows(message.peer_id)) return;
    void historyVault?.append(message.target_peer_id, message).catch(() => window.dispatchEvent(new Event('konofix-history-error')));
    localPeerId = localPeerId || message.target_peer_id;
    const result = conversations.push(message, message.target_peer_id);
    if (!result?.inserted) return;
    const peerButton = document.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(result.peerId)}"]`);
    const nick = peerButton?.dataset.privateNick || message.nick;
    const color = peerButton?.dataset.privateColor || message.nick_color || '';
    if (activePrivatePeerId === result.peerId) {
      activePrivateNick = nick;
      activePrivateColor = color;
      conversations.open(result.peerId);
      renderPrivateModal();
    } else {
      showPrivateNotification(message, result.peerId, nick, color);
    }
    queueAugment();
  });
  window.addEventListener('konofix-relay-private-message', event => {
    if (!privateMessagesEnabled()) return;
    const message = (event as CustomEvent<PrivateChatMessage>).detail;
    if (!people.allows(message.peer_id)) return;
    void historyVault?.append(message.target_peer_id, message).catch(() => window.dispatchEvent(new Event('konofix-history-error')));
    const result = conversations.push(message, message.target_peer_id);
    if (!result?.inserted) return;
    const peerButton = document.querySelector<HTMLButtonElement>(`[data-private-peer="${CSS.escape(result.peerId)}"]`);
    const nick = peerButton?.dataset.privateNick || message.nick;
    const color = peerButton?.dataset.privateColor || message.nick_color || '';
    if (activePrivatePeerId === result.peerId) {
      activePrivateNick = nick;
      activePrivateColor = color;
      conversations.open(result.peerId);
      renderPrivateModal();
    } else {
      showPrivateNotification(message, result.peerId, nick, color);
    }
    queueAugment();
  });
  window.addEventListener('konofix-relay-peer-offline', event => {
    const peerId = (event as CustomEvent<{ peer_id: string }>).detail.peer_id;
    offlinePeers.add(peerId);
    if (activePrivatePeerId === peerId) renderPrivateModal();
    peerTransport.peerOffline(peerId);
  });
  window.addEventListener('konofix-relay-peer-online', event => {
    const peerId = (event as CustomEvent<{ peer_id: string }>).detail.peer_id;
    offlinePeers.delete(peerId);
    if (activePrivatePeerId === peerId) renderPrivateModal();
    queueAugment();
  });
  window.addEventListener('konofix-incoming-audio-call', event => {
    const detail = (event as CustomEvent<{ peerId: string; connectionId: string }>).detail;
    showIncomingAudioCall(detail.peerId, detail.connectionId);
  });
  window.addEventListener('konofix-audio-call-state', event => {
    const detail = (event as CustomEvent<{ peerId: string; state: AudioCallState; error?: string }>).detail;
    const error = detail.error ?? (privateAudioOutput.isBlocked(detail.peerId)
      && ['connecting', 'connected', 'muted'].includes(detail.state) ? t('audio.outputBlocked') : undefined);
    audioStates.set(detail.peerId, { state: detail.state, error });
    if (['connected', 'muted'].includes(detail.state) && !callStarted.has(detail.peerId)) callStarted.set(detail.peerId, Date.now());
    if (['ended', 'rejected', 'failed'].includes(detail.state)) callStarted.delete(detail.peerId);
    if (detail.state === 'calling') callTones.start('outgoing');
    else if (detail.state === 'ringing') callTones.start('incoming');
    else callTones.stop();
    if (['ended', 'rejected', 'failed'].includes(detail.state)) {
      privateAudioOutput.stop(detail.peerId);
      mutedAudioPeers.delete(detail.peerId);
      document.querySelectorAll<HTMLElement>('.audio-call-wrap').forEach(modal => {
        if (modal.dataset.peerId === detail.peerId) modal.remove();
      });
    }
    if (activePrivatePeerId === detail.peerId) renderPrivateModal();
  });
  window.addEventListener('konofix-remote-audio', event => {
    const detail = (event as CustomEvent<{ peerId: string; stream: MediaStream | null }>).detail;
    attachRemoteAudio(detail.peerId, detail.stream);
  });
  await listen<{ phase?: string }>('network-status', event => {
    if (event.payload?.phase === 'offline') {
      callTones.stop();
      privateAudioOutput.stop();
      lastSyncedPrivateMessagesEnabled = null;
      return;
    }
    void syncPrivateMessagePolicy();
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
    callTones.stop();
    privateAudioOutput.stop();
    conversations.reset();
    roomState.clear();
    authorizedRoomRevision.clear();
    ownedRooms.clear();
    offlinePeers.clear();
    ignoredPrivatePeers.clear();
    lastSyncedPrivateMessagesEnabled = null;
    localPeerId = '';
    activePrivatePeerId = '';
    document.querySelector('#privateChatModal')?.remove();
  });
}

const unlockCallTones = () => { void callTones.unlock().catch(() => undefined); };
window.addEventListener('pointerdown', unlockCallTones, { capture: true });
window.addEventListener('keydown', unlockCallTones, { capture: true });

window.addEventListener('konofix-history-unlocked', () => {
  for (const record of historyVault?.all() ?? []) if (!people.blocked(record.message.peer_id)) conversations.push(record.message, record.self);
  renderPrivateModal(); queueAugment();
});
window.addEventListener('konofix-history-locked', () => { conversations.reset(); renderPrivateModal(); queueAugment(); });
window.addEventListener('konofix-history-error', () => { const status = document.querySelector('#historyStatus'); if (status) status.textContent = x('historyCouldNotBeSavedCheckAvailable'); });
installCaptureRouter();
new MutationObserver(queueAugment).observe(document.body, { childList: true, subtree: true });
wireSecureEvents().catch(error => console.error('Secure UI event wiring failed', error));
queueAugment();

setInterval(() => {
  document.querySelectorAll<HTMLElement>('[data-call-duration]').forEach(label => {
    const start = callStarted.get(label.dataset.callDuration!);
    const seconds = start ? Math.floor((Date.now() - start) / 1000) : 0;
    label.textContent = start ? String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : '';
  });
}, 1000);
