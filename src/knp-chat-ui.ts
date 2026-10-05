import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { KONOFIX_EMOJI, renderChatText } from './chat-expression';
import { KnpChatSession, type KnpSnapshot } from './knp-chat-session';
import './knp-chat.css';

const escape = (s: string) => s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]!));

let activePanel: HTMLElement | null = null;
let activeSession: KnpChatSession | null = null;
let disposePanel: (() => void) | null = null;

export function closeKnpChatUi(): void {
  document.querySelector('#knpLauncher')?.remove();
  disposePanel?.();
  disposePanel = null;
  const previous = activeSession;
  activeSession = null;
  activePanel = null;
  // The owning primary session also shuts down this exact native child.
  void previous?.stop().catch(() => {});
}

export function openKnpChatUi(nick: string): void {
  if (activePanel) { activePanel.hidden = false; return; }
  if (document.querySelector('#knpLauncher')) return;
  const launcher = document.createElement('div');
  launcher.id = 'knpLauncher'; launcher.className = 'modal-wrap';
  launcher.innerHTML = `<form class="modal glass"><h3>${escape(t('knp.openOptional'))}</h3>
    <p>${escape(t('knp.coexistence'))}</p><label for="knpProfile">${escape(t('knp.profile'))}</label>
    <input id="knpProfile" value="default" maxlength="32" pattern="[a-z0-9-]{1,32}" required />
    <div id="knpStartError" class="error" role="alert"></div>
    <button id="knpStart" class="primary" type="submit">${escape(t('knp.openOptional'))}</button>
    <button id="knpCancelStart" type="button" class="ghost">${escape(t('common.cancel'))}</button></form>`;
  document.body.appendChild(launcher);
  launcher.querySelector('#knpCancelStart')!.addEventListener('click', closeKnpChatUi);
  launcher.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault();
    const button = launcher.querySelector<HTMLButtonElement>('#knpStart')!;
    button.disabled = true;
    try { await startKnpChatUi(nick, launcher.querySelector<HTMLInputElement>('#knpProfile')!.value.trim()); launcher.remove(); }
    catch (error) { launcher.querySelector('#knpStartError')!.textContent = String(error); button.disabled = false; }
  });
}

async function startKnpChatUi(nick: string, profile: string): Promise<void> {
  if (activeSession) throw new Error('KNP contacts are already starting or active.');
  const app = document.createElement('div');
  app.id = 'knpChatOverlay';
  app.className = 'knp-overlay';
  let selected = '';
  let mounted = false;
  let stopped = false;
  let sending = false;
  const drafts = new Map<string, string>();
  const session = new KnpChatSession(invoke, snapshot => { if (mounted) render(snapshot); });
  activeSession = session;
  try { await session.start(nick, profile); } catch (error) { if (activeSession === session) activeSession = null; throw error; }
  if (!session.snapshot) return;
  activePanel = app;
  app.dataset.transport = 'knp';
  document.body.appendChild(app);
  app.innerHTML = `<main class="chat-shell knp-chat" data-session-id="${escape(session.snapshot.session_id)}">
    <aside class="sidebar glass">
      <div class="logo-row"><div class="brand-mark small">K</div><div><strong>Konofix Chat</strong><span>KonoNexus · KNP beta</span></div></div>
      <button id="knpBack" class="ghost wide" type="button">${escape(t('knp.backToWorld'))}</button>
      <button id="knpContacts" class="primary">${escape(t('knp.contacts'))}</button>
      <div class="section-title">${escape(t('knp.directChats'))}</div><div id="knpContactList"></div>
      <div class="network-card"><strong>KNP</strong><small>${escape(t('knp.scope'))}</small></div>
      <div class="sidebar-bottom"><div class="me-info"><strong>${escape(nick)}</strong><span>${escape(profile)}</span></div>
      <button id="knpStop" class="icon-btn danger" title="${escape(t('knp.stopOptional'))}">⏻</button></div>
    </aside>
    <section class="chat-main glass">
      <header class="chat-header"><div><h2 id="knpTitle">${escape(t('knp.chooseContact'))}</h2><span id="knpPeerIdentity"></span></div></header>
      <div id="knpMessages" class="messages" aria-live="polite"></div>
      <div id="knpError" class="error" role="alert"></div>
      <footer class="composer">
        <div class="emoji-wrap"><button id="knpEmojiToggle" class="emoji-toggle" title="${escape(t('chat.emoji'))}">☺</button><div id="knpEmojiPanel" class="emoji-panel" hidden>
          ${KONOFIX_EMOJI.filter((v, i, a) => a.findIndex(x => x.glyph === v.glyph) === i).map(e => `<button data-knp-emoji="${escape(e.glyph)}" title="${escape(e.label)}">${e.glyph}</button>`).join('')}
        </div></div>
        <input id="knpMsg" maxlength="4000" autocomplete="off" aria-label="${escape(t('common.send'))}" placeholder="${escape(t('knp.chooseContact'))}" disabled />
        <button id="knpSend" class="send" title="${escape(t('common.send'))}" disabled>➤</button>
      </footer>
    </section>
    <aside class="users glass"><strong>${escape(t('knp.betaTitle'))}</strong><p class="muted">${escape(t('knp.betaHelp'))}</p><p class="muted">${escape(t('knp.receiptHelp'))}</p><p class="muted">${escape(t('knp.historyHelp'))}</p></aside>
  </main>`;
  mounted = true;
  const input = app.querySelector<HTMLInputElement>('#knpMsg')!;
  const sendButton = app.querySelector<HTMLButtonElement>('#knpSend')!;
  const error = app.querySelector<HTMLElement>('#knpError')!;
  function showError(value: unknown) { if (!stopped) error.textContent = String(value); }

  function render(snapshot: KnpSnapshot) {
    if (stopped) return;
    const list = app.querySelector<HTMLElement>('#knpContactList')!;
    list.innerHTML = snapshot.contacts.map(contact => `<button class="room ${selected === contact.node_id ? 'active' : ''}" data-knp-peer="${escape(contact.node_id)}">${escape(contact.label)}</button>`).join('');
    list.querySelectorAll<HTMLButtonElement>('[data-knp-peer]').forEach(button => button.addEventListener('click', () => {
      drafts.set(selected, input.value);
      selected = button.dataset.knpPeer!;
      input.value = drafts.get(selected) ?? '';
      render(session.snapshot!);
      input.focus();
    }));
    const contact = snapshot.contacts.find(c => c.node_id === selected);
    app.querySelector('#knpTitle')!.textContent = contact?.label ?? t('knp.chooseContact');
    app.querySelector('#knpPeerIdentity')!.textContent = contact?.node_id ?? '';
    input.disabled = !contact;
    sendButton.disabled = !contact || sending;
    input.placeholder = contact ? t('chat.messageTo', { room: contact.label }) : t('knp.chooseContact');
    const messages = app.querySelector<HTMLElement>('#knpMessages')!;
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    messages.innerHTML = snapshot.messages.filter(m => m.peer_node_id === selected).map(m => `<article class="message ${m.outgoing ? 'mine' : ''}" data-knp-message="${escape(m.id)}" data-delivery="${m.delivery}">
      <div class="bubble"><strong>${escape(m.outgoing ? snapshot.nick : contact?.label ?? m.peer_node_id)}</strong>
      <p>${renderChatText(m.text)}</p><small class="knp-delivery">${escape(t(`knp.delivery.${m.delivery}`))}</small></div></article>`).join('');
    if (!messages.children.length) messages.innerHTML = `<div class="empty"><strong>${escape(t('knp.chooseContact'))}</strong><span>${escape(t('knp.contactHelp'))}</span></div>`;
    if (follow) messages.scrollTop = messages.scrollHeight;
  }

  async function send() {
    const peer = selected;
    const text = input.value.trim();
    if (!peer || !text || sending || stopped) return;
    sending = true;
    sendButton.disabled = true;
    error.textContent = '';
    try {
      const id = await session.send(peer, text);
      if (stopped || !id) return;
      // Preserve edits typed while the native send was pending.
      if (drafts.get(peer)?.trim() === text) drafts.delete(peer);
      if (selected === peer && input.value.trim() === text) input.value = '';
      await session.refresh();
    } catch (e) { showError(e); }
    finally { sending = false; if (!stopped) sendButton.disabled = !selected; }
  }
  input.addEventListener('input', () => drafts.set(selected, input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) void send(); });
  sendButton.addEventListener('click', () => void send());
  app.querySelector('#knpEmojiToggle')!.addEventListener('click', () => {
    const panel = app.querySelector<HTMLElement>('#knpEmojiPanel')!; panel.hidden = !panel.hidden;
  });
  app.querySelectorAll<HTMLButtonElement>('[data-knp-emoji]').forEach(button => button.addEventListener('click', () => {
    if (input.disabled) return;
    input.setRangeText(button.dataset.knpEmoji!, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    input.value = input.value.slice(0, 4000);
    drafts.set(selected, input.value);
    input.focus();
  }));

  app.querySelector('#knpContacts')!.addEventListener('click', () => {
    if (document.querySelector('#knpContactModal')) return;
    const snapshot = session.snapshot!;
    const modal = document.createElement('div');
    modal.id = 'knpContactModal'; modal.className = 'modal-wrap';
    modal.innerHTML = `<form class="modal glass knp-contact-form">
      <div class="modal-head"><h3>${escape(t('knp.contacts'))}</h3><button type="button" id="knpCloseContacts" aria-label="${escape(t('common.cancel'))}">×</button></div>
      <p>${escape(t('knp.contactHelp'))}</p>
      <label>${escape(t('knp.yourIdentity'))}<input id="knpOwnNodeId" value="${escape(snapshot.node_id)}" readonly /></label>
      <label>${escape(t('knp.boundAddress'))}<input id="knpBoundAddress" value="${escape(snapshot.local_addr)}" readonly /></label>
      <p class="muted">${escape(t('knp.endpointHelp'))}</p>
      <label>${escape(t('knp.contactLabel'))}<input id="knpContactLabel" maxlength="48" required /></label>
      <label>NodeID<input id="knpContactNodeId" maxlength="44" spellcheck="false" required /></label>
      <label>IP:port<input id="knpContactEndpoint" maxlength="100" placeholder="192.168.1.2:47000" spellcheck="false" required /></label>
      <div id="knpContactError" class="error" role="alert"></div>
      <button id="knpAddContact" class="primary" type="submit">${escape(t('knp.addContact'))}</button>
    </form>`;
    document.body.appendChild(modal);
    modal.querySelector('#knpCloseContacts')!.addEventListener('click', () => modal.remove());
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
    modal.querySelector<HTMLInputElement>('#knpContactLabel')!.focus();
    modal.querySelector('form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const button = modal.querySelector<HTMLButtonElement>('#knpAddContact')!;
      button.disabled = true;
      try {
        const node_id = modal.querySelector<HTMLInputElement>('#knpContactNodeId')!.value.trim();
        await session.addContact({ node_id, endpoint: modal.querySelector<HTMLInputElement>('#knpContactEndpoint')!.value.trim(), label: modal.querySelector<HTMLInputElement>('#knpContactLabel')!.value.trim() });
        if (stopped) return;
        selected = node_id; input.value = drafts.get(selected) ?? '';
        modal.remove(); render(session.snapshot!); input.focus();
      } catch (e) { modal.querySelector('#knpContactError')!.textContent = String(e); }
      finally { button.disabled = false; }
    });
  });
  app.querySelector('#knpBack')!.addEventListener('click', () => { app.hidden = true; });
  const timer = window.setInterval(() => { void session.refresh().catch(showError); }, 500);
  disposePanel = () => { stopped = true; window.clearInterval(timer); document.querySelector('#knpContactModal')?.remove(); app.remove(); drafts.clear(); };
  app.querySelector('#knpStop')!.addEventListener('click', async () => {
    const button = app.querySelector<HTMLButtonElement>('#knpStop')!;
    if (button.disabled) return;
    button.disabled = true;
    try {
      await session.stop();
      stopped = true;
      window.clearInterval(timer);
      document.querySelector('#knpContactModal')?.remove();
      drafts.clear();
      app.remove();
      activePanel = null;
      activeSession = null;
      disposePanel = null;
    } catch (e) { showError(e); button.disabled = false; }
  });
  render(session.snapshot);
}
