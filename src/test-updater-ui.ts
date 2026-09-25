import { invoke } from '@tauri-apps/api/core';
import { currentLocale } from './i18n';

type TestUpdateInfo = {
  channel: string;
  version: string;
  current_source_commit: string;
  source_commit: string;
  run_id: number;
  run_number: number;
  artifact_id: number;
  artifact_name: string;
  artifact_sha256: string;
  download_url: string;
  update_available: boolean;
};

const copy = currentLocale === 'pl'
  ? {
      available: 'Dostępna nowa wersja testowa Konofix',
      current: 'Masz najnowszą wersję testową',
      check: 'Sprawdź aktualizacje',
      install: 'Pobierz i zainstaluj',
      installing: 'Pobieranie i weryfikacja aktualizacji…',
      failed: 'Aktualizacja nie powiodła się',
      build: 'build',
      hint: 'Kanał testowy 0.6.x · tylko zielone buildy Windows CI',
    }
  : {
      available: 'A new Konofix test build is available',
      current: 'You have the newest test build',
      check: 'Check for updates',
      install: 'Download and install',
      installing: 'Downloading and verifying update…',
      failed: 'Update failed',
      build: 'build',
      hint: '0.6.x test channel · successful Windows CI builds only',
    };

let latest: TestUpdateInfo | null = null;
let checking = false;
let installing = false;
let lastError = '';

function shortSha(value: string): string {
  return /^[0-9a-f]{40}$/i.test(value) ? value.slice(0, 7) : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;',
  }[character]!));
}

async function checkForUpdates(showErrors = false): Promise<void> {
  if (checking || installing) return;
  checking = true;
  try {
    latest = await invoke<TestUpdateInfo>('check_test_update');
    lastError = '';
  } catch (error) {
    latest = null;
    if (showErrors) lastError = String(error);
  } finally {
    checking = false;
    renderAll();
  }
}

async function installUpdate(): Promise<void> {
  if (installing) return;
  installing = true;
  lastError = '';
  renderAll();
  try {
    await invoke('install_test_update');
  } catch (error) {
    installing = false;
    lastError = String(error);
    renderAll();
  }
}

function cardHtml(): string {
  if (installing) {
    return '<div class="test-updater-copy"><strong>' + copy.installing + '</strong><small>' + copy.hint + '</small></div>';
  }
  if (lastError) {
    return '<div class="test-updater-copy"><strong>' + copy.failed + '</strong><small>' + escapeHtml(lastError) + '</small></div>' +
      '<button type="button" data-test-update-check>' + copy.check + '</button>';
  }
  if (!latest) {
    return '<div class="test-updater-copy"><strong>' + copy.check + '</strong><small>' + copy.hint + '</small></div>' +
      '<button type="button" data-test-update-check>' + copy.check + '</button>';
  }
  if (!latest.update_available) {
    return '<div class="test-updater-copy"><strong>' + copy.current + '</strong><small>' + copy.build + ' ' + shortSha(latest.source_commit) + ' · ' + copy.hint + '</small></div>' +
      '<button type="button" data-test-update-check>' + copy.check + '</button>';
  }
  return '<div class="test-updater-copy"><strong>' + copy.available + '</strong><small>' + copy.build + ' ' + shortSha(latest.source_commit) + ' · ' + copy.hint + '</small></div>' +
    '<button type="button" class="primary compact" data-test-update-install>' + copy.install + '</button>';
}

function wire(container: HTMLElement): void {
  container.querySelector('[data-test-update-check]')?.addEventListener('click', () => { void checkForUpdates(true); });
  container.querySelector('[data-test-update-install]')?.addEventListener('click', () => { void installUpdate(); });
}

function ensureStyles(): void {
  if (document.querySelector('[data-test-updater-styles]')) return;
  const style = document.createElement('style');
  style.dataset.testUpdaterStyles = 'true';
  style.textContent =
    '.test-updater-card{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;padding:11px 12px;border-radius:12px;border:1px solid rgba(98,229,255,.24);background:rgba(0,136,255,.08)}' +
    '.test-updater-copy{display:grid;gap:3px;min-width:0}.test-updater-copy strong{font-size:.82rem;color:#f4faff}' +
    '.test-updater-copy small{color:#8da8b8;font-size:.72rem;line-height:1.35;overflow-wrap:anywhere}.test-updater-card button{flex:0 0 auto}';
  document.head.appendChild(style);
}

function ensureCard(parent: HTMLElement, key: string): void {
  let card = parent.querySelector<HTMLElement>('[data-test-updater="' + key + '"]');
  if (!card) {
    card = document.createElement('section');
    card.className = 'test-updater-card';
    card.dataset.testUpdater = key;
    parent.appendChild(card);
  }
  const html = cardHtml();
  if (card.innerHTML !== html) {
    card.innerHTML = html;
    wire(card);
  }
}

function renderAll(): void {
  ensureStyles();
  const login = document.querySelector<HTMLElement>('.login-card');
  if (login) ensureCard(login, 'login');

  const settings = document.querySelector<HTMLElement>('#networkModal .modal');
  if (settings) ensureCard(settings, 'settings');
}

let renderQueued = false;
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderAll();
  });
}

new MutationObserver(queueRender).observe(document.body, { childList: true, subtree: true });
renderAll();

window.setTimeout(() => { void checkForUpdates(false); }, 2500);
window.setInterval(() => { void checkForUpdates(false); }, 10 * 60 * 1000);
