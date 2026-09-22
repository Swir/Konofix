import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const ui = read('src/secure-ui.ts');
const css = read('src/secure-ui.css');
const index = read('index.html');

function requireText(text, message) {
  if (!ui.includes(text)) throw new Error(message);
}

requireText("event.stopImmediatePropagation();", 'secure UI must capture protected-room/create actions before legacy handlers');
requireText("invoke<SecureRoomInfo>('create_secure_room'", 'password-protected room creation must use a dedicated secure command');
requireText("invoke('authorize_room_entry'", 'locked-room admission must explicitly authorize before legacy room entry');
requireText("invoke<SecureRoomInfo>('update_room_password'", 'room owners must be able to change/remove protection');
requireText("invoke<PrivateChatMessage>('send_private_message'", 'private messages must use the dedicated P2P command');
requireText("listen<PrivateChatMessage>('private-message'", 'private incoming messages must use a dedicated event');
requireText('renderChatText(message.text)', 'private messages must reuse safe chat rendering');
requireText("authorizedRoomRevision.get(roomId) === revision", 'room authorization must be tied to the advertised auth revision');
requireText("authorizedRoomRevision.delete(room.id)", 'password revision changes must invalidate cached local admission');
requireText("conversations.unreadCount(peerId)", 'private UI must expose unread state per peer');
requireText("const unreadText = String(Math.min(99, unread));", 'existing private-chat buttons must derive the current unread badge value');
requireText("if (badge.textContent !== unreadText) badge.textContent = unreadText;", 'existing private-chat buttons must refresh unread badges idempotently');
requireText("badge?.remove();", 'opening a private conversation must be able to clear a stale unread badge');
requireText("const accessibleLabel = `${openLabel}. ${unreadLabel}`;", 'private-chat trigger accessible names must include unread state');
requireText("button.getAttribute('aria-label') !== accessibleLabel", 'unread accessible labels must refresh idempotently');
requireText("button.getAttribute('aria-label') !== openLabel", 'clearing unread state must restore the base private-chat accessible name');
requireText("offlinePeers.has(activePrivatePeerId)", 'private UI must reflect peer disconnect state');
requireText("let augmentQueued = false;", 'secure UI must coalesce DOM augmentation work');
requireText("existingManage.textContent !== manageIcon", 'room password manager updates must be idempotent to avoid MutationObserver loops');
requireText("badge.textContent !== unreadText", 'unread badge updates must be idempotent to avoid MutationObserver loops');
requireText("secureRoomCreateModal", 'room creation must use one in-app modal instead of chained browser prompts');
requireText('aria-labelledby="secureRoomCreateTitle"', 'room creation dialog must expose its visible title to assistive technology');
requireText('data-room-create-error role="alert" aria-live="polite"', 'room creation errors must be announced to assistive technology');
requireText('aria-labelledby="privateChatTitle"', 'private chat dialog must expose its visible title to assistive technology');
requireText('data-private-input maxlength="4000" autocomplete="off" spellcheck="true" placeholder=', 'private message composer must remain present');
requireText('aria-label="${esc(t(\'private.messageTo\', { nick: activePrivateNick }))}"', 'private message input must expose an accessible name independent of placeholder support');
requireText('data-private-send aria-label="${esc(t(\'common.send\'))}"', 'icon-only private send control must expose a localized accessible name');
requireText("if (event.key === 'Escape')", 'secure/private dialogs must support Escape dismissal');
requireText("wrap.onkeydown = event =>", 'private chat rerenders must replace the Escape handler instead of accumulating listeners');
requireText("document.querySelector<HTMLButtonElement>('#newRoom')?.focus()", 'room creation dismissal must restore keyboard focus to its trigger');
requireText("[data-private-peer=\"${CSS.escape(peerId)}\"]", 'private chat dismissal must restore keyboard focus to the originating peer action');
requireText('function trapDialogFocus(container: HTMLElement, event: KeyboardEvent): void', 'secure/private dialogs must implement bounded keyboard focus trapping');
requireText("button:not([disabled]), input:not([disabled])", 'focus trapping must ignore disabled primary controls');
requireText("if (event.shiftKey && (active === first || !container.contains(active)))", 'Shift+Tab must wrap to the final dialog control when focus would escape');
requireText("else if (!event.shiftKey && active === last)", 'Tab must wrap from the final dialog control to the first control');
if ((ui.match(/trapDialogFocus\(wrap, event\)/g) || []).length < 2) {
  throw new Error('room creation and private chat must both trap Tab focus inside their modal surface');
}

if (!css.includes(':focus-visible')) {
  throw new Error('secure-room and private-chat controls must expose a visible keyboard focus state');
}
if (!css.includes('max-height: calc(100dvh - 32px)')) {
  throw new Error('secure-room creation modal must remain bounded inside short application windows');
}
if (!css.includes('@media (max-height: 560px) and (min-width: 721px)')) {
  throw new Error('private chat must adapt to short desktop windows instead of clipping controls');
}
if (!css.includes('@media (pointer: coarse)') || !css.includes('min-width: 44px') || !css.includes('min-height: 44px')) {
  throw new Error('touch-oriented secure/private controls must keep accessible coarse-pointer hit targets');
}
if (!css.includes('env(safe-area-inset-top)') || !css.includes('env(safe-area-inset-bottom)')) {
  throw new Error('mobile private chat must respect display safe-area insets');
}
if (!css.includes('@media (forced-colors: active)') || !css.includes('background: Highlight;') || !css.includes('color: HighlightText;')) {
  throw new Error('secure/private UI must preserve controls and unread status in Windows forced-colors mode');
}
if (!css.includes('outline-color: Highlight;')) {
  throw new Error('forced-colors mode must keep keyboard focus visibly distinct');
}
if (!css.includes('@media (prefers-reduced-motion: reduce)') || !css.includes('animation: none !important;') || !css.includes('transition: none !important;')) {
  throw new Error('secure/private UI must respect the operating-system reduced-motion preference');
}
if (!css.includes('scroll-behavior: auto;')) {
  throw new Error('reduced-motion mode must avoid smooth scrolling inside secure/private surfaces');
}

if (ui.includes("if (!fileButton || row.querySelector('[data-private-peer]')) return;")) {
  throw new Error('existing private-chat buttons must not skip unread-state refresh');
}
if (ui.includes("invoke('send_message'") || ui.includes('gossipsub')) {
  throw new Error('private/secure UI must not fall back to public chat or GossipSub');
}
if (/innerHTML\s*=.*message\.text/.test(ui)) {
  throw new Error('private message text must never be inserted as raw HTML');
}
if (!index.includes('/src/secure-ui.ts')) {
  throw new Error('secure UI module must be loaded by the application shell');
}

console.log('secure room/private-chat UI contract: OK');

if (/else if \(existingManage\)\s*\{\s*existingManage\.textContent\s*=/.test(ui)) {
  throw new Error('unconditional room-manager text writes can reintroduce an infinite MutationObserver loop');
}
