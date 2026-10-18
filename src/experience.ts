import { x } from './experience-i18n';
import { people } from './people';
import { historyVault } from './history-vault';
import { configureTurn, probeRelay, turnConfigured, type TurnSettings } from './rtc-config';
import './experience.css';
export const html = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function applyAppearance(): void {
  document.documentElement.dataset.accent = localStorage.getItem('konofix.accent') === 'cyan' ? 'cyan' : 'violet';
  document.documentElement.dataset.density = localStorage.getItem('konofix.density') === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.style.setProperty('--chat-size', localStorage.getItem('konofix.largeText') === '1' ? '17px' : '15px');
  document.documentElement.dataset.peopleHidden = localStorage.getItem('konofix.peopleHidden') === '1' ? 'true' : 'false';
}
applyAppearance();

export function decorateSettings(wrap: HTMLElement, status: { chat: boolean; native: number; relays: number; identity: string }): void {
  const modal = wrap.querySelector<HTMLElement>('.modal')!;
  modal.classList.add('settings-modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', x('settings'));
  const title = modal.querySelector('h3'); if (title) title.textContent = x('yourSettings');
  const eyebrow = modal.querySelector('.eyebrow'); if (eyebrow) eyebrow.textContent = 'KONOFIX';
  const abort = new AbortController();
  const observer = new MutationObserver(() => { if (!wrap.isConnected) { abort.abort(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true });
  const audio = modal.querySelector('.audio-settings-card');
  const update = audio?.nextElementSibling;
  const sections: Record<string, HTMLElement> = {};
  const names = { appearance: x('appearance'), sound: x('sound'), privacy: x('privacy'), connection: x('connection'), updates: x('updates') };
  for (const [id, name] of Object.entries(names)) {
    const section = document.createElement('section'); section.className = 'settings-page'; section.id = `settings-${id}`;
    section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', `tab-${id}`); section.hidden = id !== 'appearance';
    sections[id] = section;
  }
  if (audio) sections.sound.append(audio);
  if (update) sections.updates.append(update);
  const advanced = document.createElement('details');
  advanced.innerHTML = `<summary>${x('advancedDetails')}</summary>`;
  for (const child of [...modal.children]) if (!child.classList.contains('modal-head')) advanced.append(child);
  const network = document.createElement('div'); network.className = 'settings-card';
  network.innerHTML = `<h4>${x('connectionStatus')}</h4><p>${status.chat ? x('chatIsConnected') : x('chatIsWaitingForAConnection')}</p><p>${x('nativeConnections')}: ${status.native} · WORLD: ${status.relays}</p><p>${x('voiceAndFilesHaveSeparateConnectionsChecked')}</p><button class="ghost" id="diagnoseConnection">${x('checkConnection')}</button><p role="status" id="diagnosisResult"></p>`;
  sections.connection.append(network);
  sections.connection.insertAdjacentHTML('beforeend', `<form class="settings-card" id="turnForm"><h4>${x('relayForRestrictiveNetworks')}</h4><p>${x('optionalTurnServerCredentialsLastOnlyUntil')}</p><label>${x('addressesOnePerLine')}<textarea id="turnUrls" placeholder="turns:relay.example.org:5349?transport=tcp" rows="2" required></textarea></label><label>${x('username')}<input id="turnUsername" autocomplete="off" required maxlength="256"></label><label>${x('relayCredential')}<input id="turnCredential" type="password" autocomplete="off" required maxlength="2048"></label><label>${x('validForMinutesMax1440')}<input id="turnMinutes" type="number" min="1" max="1440" value="60" required></label><label class="setting-check"><input type="checkbox" id="turnOnly">${x('useRelayOnlyForNewConnections')}</label><div class="settings-actions"><button class="primary compact" type="submit">${x('testAndEnable')}</button><button class="ghost" type="button" id="turnDisable">${x('disable')}</button></div><p role="status" id="turnResult">${turnConfigured() ? x('relayConfiguredForThisSession') : x('currentlyUsingDirectConnections')}</p></form>`);
  sections.connection.append(advanced);
  sections.appearance.innerHTML = `<div class="settings-card"><h4>${x('roomForConversation')}</h4><label>${x('accentColor')}<select id="appearanceAccent"><option value="violet">${x('violet')}</option><option value="cyan">${x('cyan')}</option></select></label><label>${x('spacing')}<select id="appearanceDensity"><option value="comfortable">${x('comfortable')}</option><option value="compact">${x('compact')}</option></select></label><label class="setting-check"><input id="appearanceLarge" type="checkbox">${x('largerMessageText')}</label><p>${x('changesApplyImmediatelyAndAreRemembered')}</p></div>`;
  sections.privacy.dataset.settingsPrivacy = 'true';
  sections.privacy.innerHTML = `<div class="settings-card"><h4>${x('whoCanContactMe')}</h4><label class="setting-check"><input id="contactsOnly" type="checkbox" ${people.contactsOnly ? 'checked' : ''}>${x('incomingMessagesCallsAndFileOffersOnly')}</label><p>${x('blocksApplyToIdentitiesNotNicknamesThey')}</p><div id="blockedPeople"></div></div><div class="settings-card"><h4>${x('encryptedHistoryOnThisDevice')}</h4><p>${x('optionallySavesUpTo2000PrivateMessages')}</p><label>${x('passphraseAtLeast12Characters')}<input id="historyPassword" type="password" autocomplete="off" minlength="12" maxlength="1024"></label><div class="settings-actions"><button class="ghost" id="unlockHistory">${historyVault?.exists() ? x('unlock') : x('enableHistory')}</button><button class="ghost" id="lockHistory">${x('lock')}</button><button class="ghost danger" id="clearHistory">${x('deleteSavedHistory')}</button></div><p role="status" id="historyStatus">${historyVault?.unlocked() ? x('historyUnlockedNewPrivateMessagesAreSaved') : x('historyOffOrLocked')}</p></div><div class="settings-card"><h4>${x('myIdentity')}</h4><p>${x('compareTheFullIdentifierWithYourContact')}</p><code class="identity-code">${html(status.identity)}</code></div>`;
  const tabs = document.createElement('div'); tabs.className = 'settings-tabs'; tabs.setAttribute('role', 'tablist');
  tabs.innerHTML = Object.entries(names).map(([id, name]) => `<button role="tab" id="tab-${id}" aria-controls="settings-${id}" aria-selected="${id === 'appearance'}" tabindex="${id === 'appearance' ? 0 : -1}" data-settings-tab="${id}">${name}</button>`).join('');
  modal.append(tabs, ...Object.values(sections));
  const selectTab = (id: string) => {
    tabs.querySelectorAll<HTMLButtonElement>('button').forEach(button => { const selected = button.dataset.settingsTab === id; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    Object.entries(sections).forEach(([key, section]) => { section.hidden = key !== id; });
  };
  tabs.addEventListener('click', event => { const id = (event.target as HTMLElement).closest<HTMLElement>('[data-settings-tab]')?.dataset.settingsTab; if (id) selectTab(id); });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('button')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    selectTab(buttons[index].dataset.settingsTab!); buttons[index].focus();
  });
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') { abort.abort(); wrap.remove(); document.querySelector<HTMLElement>('#networkSettings')?.focus(); }
    if (event.key === 'Tab') {
      const items = [...modal.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,textarea,summary')].filter(item => item.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
  const accent = modal.querySelector<HTMLSelectElement>('#appearanceAccent')!; accent.value = document.documentElement.dataset.accent!;
  const density = modal.querySelector<HTMLSelectElement>('#appearanceDensity')!; density.value = document.documentElement.dataset.density!;
  const large = modal.querySelector<HTMLInputElement>('#appearanceLarge')!; large.checked = localStorage.getItem('konofix.largeText') === '1';
  accent.onchange = () => { localStorage.setItem('konofix.accent', accent.value); applyAppearance(); };
  density.onchange = () => { localStorage.setItem('konofix.density', density.value); applyAppearance(); };
  large.onchange = () => { localStorage.setItem('konofix.largeText', large.checked ? '1' : '0'); applyAppearance(); };
  modal.querySelector<HTMLInputElement>('#contactsOnly')!.onchange = event => people.setContactsOnly((event.target as HTMLInputElement).checked);
  const blockedList = modal.querySelector<HTMLElement>('#blockedPeople')!;
  for (const contact of people.list().filter(item => item.blocked)) {
    const button = document.createElement('button'); button.className = 'ghost'; button.textContent = `${x('unblock')}: ${contact.nick}`;
    button.onclick = () => { people.update(contact.id, { blocked: false }); button.remove(); }; blockedList.append(button);
  }
  const historyStatus = modal.querySelector<HTMLElement>('#historyStatus')!;
  modal.querySelector<HTMLButtonElement>('#unlockHistory')!.onclick = async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    const input = modal.querySelector<HTMLInputElement>('#historyPassword')!;
    try { const password = input.value; input.value = ''; await historyVault?.unlock(password); window.dispatchEvent(new Event('konofix-history-unlocked')); historyStatus.textContent = x('historyUnlockedNewMessagesWillBeSaved'); }
    catch { historyStatus.textContent = x('couldNotUnlockHistoryCheckThePassphrase'); }
    finally { button.disabled = false; }
  };
  modal.querySelector<HTMLButtonElement>('#lockHistory')!.onclick = async () => { await historyVault?.flush().catch(() => {}); historyVault?.lock(); window.dispatchEvent(new Event('konofix-history-locked')); historyStatus.textContent = x('historyLocked'); };
  modal.querySelector<HTMLButtonElement>('#clearHistory')!.onclick = () => { if (window.confirm(x('permanentlyDeleteLocalHistoryThisCannotBe'))) { historyVault?.clear(); window.dispatchEvent(new Event('konofix-history-locked')); historyStatus.textContent = x('historyDeleted'); } };
  modal.querySelector<HTMLButtonElement>('#diagnoseConnection')!.onclick = () => {
    modal.querySelector<HTMLElement>('#diagnosisResult')!.textContent = !navigator.onLine ? x('theSystemReportsNoNetworkCheckWifi') : !status.chat ? x('systemNetworkAvailableButChatIsDisconnected') : !turnConfigured() ? x('chatConnectedVoiceAndLargeFilesUse') : x('chatConnectedTurnConfiguredOnlyAnActual');
  };
  modal.querySelector<HTMLFormElement>('#turnForm')!.onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
    const result = modal.querySelector<HTMLElement>('#turnResult')!;
    const read = (id: string) => modal.querySelector<HTMLInputElement>(id)!.value;
    const settings: TurnSettings = { urls: read('#turnUrls').split(/\s+/).filter(Boolean), username: read('#turnUsername'), credential: read('#turnCredential'), expiresAt: Date.now() + Number(read('#turnMinutes')) * 60_000, relayOnly: modal.querySelector<HTMLInputElement>('#turnOnly')!.checked };
    result.textContent = x('testingRelay');
    try { if (await probeRelay(settings, abort.signal)) { if (!abort.signal.aborted) { configureTurn(settings); result.textContent = x('relayAllocationSucceededEnabledForNewConnections'); } } else result.textContent = x('noTurnAllocationCheckAddressCredentialsAnd'); }
    catch (error) { result.textContent = String(error); }
    finally { modal.querySelector<HTMLInputElement>('#turnCredential')!.value = ''; button.disabled = false; }
  };
  modal.querySelector<HTMLButtonElement>('#turnDisable')!.onclick = () => { configureTurn(); modal.querySelector<HTMLElement>('#turnResult')!.textContent = x('turnDisabledForNewConnections'); };
  tabs.querySelector<HTMLButtonElement>('button')?.focus();
}
