import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the real updater module in a real DOM. Only IPC and locale are
// substituted: this must never query GitHub or install an update during tests.
const sourcePath = process.env.KONOFIX_UPDATER_TEST_SOURCE
  || new URL('../src/test-updater-ui.ts', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
// Node 22.13+ strips the erasable annotations without relying on the legacy
// TypeScript compiler API (not exposed by TypeScript 7). The normal tsc/Vite
// build remains the full production type/build gate; this gate tests the DOM.
const outputText = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, ''), {
  mode: 'strip',
});

function findBrowser() {
  if (process.env.KONOFIX_TEST_BROWSER) {
    assert.ok(fs.existsSync(process.env.KONOFIX_TEST_BROWSER), 'configured test browser is missing');
    return process.env.KONOFIX_TEST_BROWSER;
  }
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Updater DOM regression requires Edge/Chromium. Set KONOFIX_TEST_BROWSER to its executable; do not silently skip this gate.');
}

const browser = findBrowser();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-updater-dom-'));
const harness = String.raw`
const currentLocale = new URLSearchParams(location.search).get('locale') || 'en';
const proof = { observerCallbacks: 0, writes: 0, maxCallbacksPerStep: 0, checks: 0, installs: 0, inputs: 0, cases: [] };
let mode = 'current';
let holdCheck = null;
const build = {
  channel: 'test', version: '0.6.0', current_source_commit: 'a'.repeat(40),
  source_commit: 'b'.repeat(40), run_id: 1, run_number: 1,
  artifact_id: 1, artifact_name: 'fixture', artifact_sha256: 'c'.repeat(64),
  download_url: 'https://example.invalid/not-contacted', update_available: false,
};
const invoke = async command => {
  if (command === 'check_test_update') {
    proof.checks++;
    if (mode === 'held') return new Promise(resolve => { holdCheck = resolve; });
    if (mode === 'error') throw new Error('offline <script>bad()</script> & "quoted"');
    return { ...build, update_available: mode === 'available' };
  }
  if (command === 'install_test_update') {
    proof.installs++;
    throw new Error('fixture installation blocked');
  }
  throw new Error('Unexpected IPC command: ' + command);
};
let failed = false;
const observers = [];
const nativeObserver = MutationObserver;
function finishFailure(message) {
  if (failed) return;
  failed = true;
  for (const observer of observers) observer.disconnect();
  document.getElementById('result').textContent = 'FAIL ' + message;
}
// Bound a broken fixture without disguising its failure. Original 7ee32c0
// reaches this guard before a timer/input task can run. Fixed code must settle.
window.MutationObserver = class extends nativeObserver {
  constructor(callback) {
    super((records, observer) => {
      proof.observerCallbacks++;
      proof.writes += records.length;
      if (proof.observerCallbacks > 128) {
        finishFailure('updater mutation feedback loop: >128 observer callbacks');
        return;
      }
      callback(records, observer);
    });
    observers.push(this);
  }
};
window.addEventListener('error', event => finishFailure(event.message));
window.addEventListener('unhandledrejection', event => finishFailure(String(event.reason)));
const assert = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const login = () => document.querySelector('.login-card');
const settings = () => document.querySelector('#networkModal .modal');
const card = key => document.querySelector('[data-test-updater="' + key + '"]');
const button = (key, kind = 'check') => card(key)?.querySelector('[data-test-update-' + kind + ']');
async function settle(name, operation) {
  const before = proof.observerCallbacks;
  await operation();
  await tick();
  await tick();
  assert(!failed, 'mutation guard failed: ' + name);
  const callbacks = proof.observerCallbacks - before;
  proof.maxCallbacksPerStep = Math.max(proof.maxCallbacksPerStep, callbacks);
  assert(callbacks <= 8, name + ': DOM work must be bounded');
  const quiet = proof.observerCallbacks;
  await tick();
  assert(quiet === proof.observerCallbacks, name + ': observer did not become idle');
  proof.cases.push(name);
}
async function test() {
  await settle('initial login and settings render', async () => {});
  assert(card('login') && card('settings'), 'both updater mounts are required');
  const expected = currentLocale === 'pl' ? 'Sprawdź aktualizacje' : 'Check for updates';
  assert(button('login').textContent === expected, 'locale was not preserved');
  assert(button('login').hasAttribute('data-test-update-check'), 'bare data attribute did not parse');
  assert(button('login').outerHTML.includes('data-test-update-check=""'), 'fixture must exercise browser normalization');
  await settle('unchanged render preserves button and focus', async () => {
    const first = button('login');
    first.focus();
    for (let i = 0; i < 50; i++) {
      const marker = document.createElement('span');
      document.body.append(marker);
      marker.remove();
    }
    await tick();
    assert(button('login') === first, 'unchanged state recreated the button');
    assert(document.activeElement === first, 'unchanged state stole keyboard focus');
  });
  await settle('input and click handlers remain responsive', async () => {
    const input = document.getElementById('nickname');
    input.addEventListener('input', () => { proof.inputs++; });
    input.value = 'Konofix tester';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert(proof.inputs === 1, 'input handler did not run');
    button('login').click();
    await tick();
    assert(proof.checks === 1, 'update-check click did not reach IPC exactly once');
    assert(card('settings').textContent.includes('bbbbbbb'), 'settings did not synchronize current build');
  });
  await settle('repeated identical response preserves button', async () => {
    const first = button('login');
    first.click();
    await tick();
    assert(proof.checks === 2 && button('login') === first, 'identical update result rewrote the card or duplicated listener');
  });
  await settle('in-flight update check is single-flight', async () => {
    mode = 'held';
    button('login').click();
    button('settings').click();
    await tick();
    assert(proof.checks === 3 && holdCheck, 'concurrent checks bypassed the guard');
    holdCheck({ ...build });
    mode = 'current';
  });
  await settle('failed update check stays escaped and responsive', async () => {
    mode = 'error';
    button('login').click();
    await tick();
    assert(card('login').textContent.includes('<script>bad()</script>'), 'error detail is missing');
    assert(!card('login').querySelector('script'), 'error string was injected as executable HTML');
    assert(button('settings'), 'retry disappeared in settings');
  });
  await settle('available update preserves explicit install action', async () => {
    mode = 'available';
    button('settings').click();
    await tick();
    assert(button('login', 'install') && button('settings', 'install'), 'install action did not appear');
    assert(proof.installs === 0, 'update was installed without a click');
  });
  await settle('failed installation recovers to retry', async () => {
    button('login', 'install').click();
    await tick();
    assert(proof.installs === 1, 'install click was not single');
    assert(card('login').textContent.includes('fixture installation blocked'), 'install error disappeared');
    assert(button('login') && button('settings'), 'retry buttons are missing');
  });
  await settle('core rerender recreates a removed card once', async () => {
    const old = card('login');
    old.remove();
    await tick();
    assert(card('login') && card('login') !== old, 'removed card was not restored');
    const replacement = document.createElement('section');
    replacement.className = 'login-card';
    login().replaceWith(replacement);
    await tick();
    assert(card('login')?.parentElement === replacement, 'core login rerender lost updater');
  });
  await settle('cleared card content is restored', async () => {
    card('settings').replaceChildren();
    await tick();
    assert(button('settings'), 'empty existing card was not repaired');
  });
  await settle('settings close and reopen with functional listeners', async () => {
    document.getElementById('networkModal').remove();
    await tick();
    const modal = document.createElement('div');
    modal.id = 'networkModal';
    modal.innerHTML = '<section class="modal"></section>';
    document.body.append(modal);
    await tick();
    mode = 'current';
    const before = proof.checks;
    button('settings').click();
    await tick();
    assert(proof.checks === before + 1, 'remounted updater click did not run once');
  });
  await settle('background check runs after initial 2.5 second delay', async () => {
    const before = proof.checks;
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert(proof.checks === before + 1, 'scheduled startup check did not run once');
  });
  assert(!failed, 'fixture has failed');
  for (const observer of observers) observer.disconnect();
  document.getElementById('result').textContent = 'PASS ' + JSON.stringify(proof);
}
`;

// CDP over inherited pipes avoids a debugging TCP listener and needs no new
// npm/browser-driver dependency. Node 22 and the runner's Edge/Chrome suffice.
const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-extensions', '--disable-component-update',
  '--disable-sync', '--disable-dev-shm-usage', '--password-store=basic', '--use-mock-keychain',
  '--remote-debugging-pipe', '--user-data-dir=' + path.join(dir, 'profile')];
if (process.env.KONOFIX_TEST_BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox');
const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let sequence = 0;
let buffered = '';
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
function rejectPending(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}
child.on('error', rejectPending);
child.on('exit', code => rejectPending(new Error('Test browser exited: ' + code + '\n' + stderr)));
child.stdio[4].setEncoding('utf8');
child.stdio[4].on('data', data => {
  buffered += data;
  let end;
  while ((end = buffered.indexOf('\0')) !== -1) {
    const raw = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser responsiveness timeout: ' + method + '\n' + stderr));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
try {
  for (const locale of ['pl', 'en']) {
    const html = '<section class="login-card"><input id="nickname"></section>'
      + '<div id="networkModal"><section class="modal"></section></div><pre id="result">PENDING</pre>';
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.evaluate', { expression: 'document.body.innerHTML = ' + JSON.stringify(html) }, sessionId);
    const localizedHarness = harness.replace("new URLSearchParams(location.search).get('locale') || 'en'", JSON.stringify(locale));
    const execution = await cdp('Runtime.evaluate', {
      expression: '(async () => {' + localizedHarness + '\n' + outputText
        + '\ntry { await test(); } catch(error) { finishFailure(error.stack || String(error)); }'
        + '\nreturn document.getElementById("result").textContent; })()',
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    assert.ok(!execution.exceptionDetails, 'fixture execution failed: ' + JSON.stringify(execution.exceptionDetails));
    const evidence = execution.result?.value;
    assert.ok(typeof evidence === 'string' && evidence.startsWith('PASS '), `${locale}: ${evidence}`);
    console.log(`Updater real-DOM ${locale}: ${evidence}`);
    await cdp('Target.closeTarget', { targetId });
  }
} finally {
  if (child.exitCode === null && child.pid) {
    try { await cdp('Browser.close'); } catch {}
    // Wait for browser profile handles to close before deleting the fixture.
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  rejectPending(new Error('Browser fixture closed'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
