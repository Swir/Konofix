import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

// Run actual UI handlers and DOM, substitute only IPC and locale/expression helpers.
// Delayed initial IPC replies must not replace newer file-transfer events.
const root = process.cwd();
const mainSource = fs.readFileSync(process.env.KONOFIX_TRANSFER_TEST_MAIN || path.join(root, 'src/main.ts'), 'utf8');
const helperSource = fs.readFileSync(path.join(root, 'src/chat-usability.ts'), 'utf8');
const strip = source => stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const main = strip(mainSource);
const helper = strip(helperSource);
const room = stripTypeScriptTypes(fs.readFileSync(process.env.KONOFIX_TRANSFER_TEST_ROOM || path.join(root, 'src/room-audio-ui.ts'), 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, ''));
const fixture = fs.readFileSync(path.join(root, 'scripts/fixtures/transfer-room-ui.browser.js'), 'utf8');
const candidates = [process.env.KONOFIX_TEST_BROWSER];
for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
  for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) candidates.push(path.join(base, name));
}
candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
const executable = candidates.find(file => file && fs.existsSync(file));
assert.ok(executable, 'Transfer/room UI regression requires Edge/Chromium; do not silently skip');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-transfer-room-'));
const pending = new Map();
let browser, call, failed = false;
try {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${path.join(temp, 'profile')}`];
  if (process.platform === 'linux') args.push('--no-sandbox'); // Isolated ephemeral CI browser only.
  browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let sequence = 0, buffer = '', stderr = '';
  const rejectPending = reason => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(reason); } pending.clear(); };
  browser.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  browser.on('error', rejectPending);
  browser.on('exit', code => rejectPending(new Error(`UI test browser exited (${code}): ${stderr}`)));
  browser.stdio[4].on('data', bytes => {
    buffer += bytes.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw) continue;
      const message = JSON.parse(raw), item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    }
  });
  call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`UI browser ${method} timed out: ${stderr}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  for (const locale of ['pl', 'en']) {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const expression = `(async () => { const currentLocale = ${JSON.stringify(locale)}; const CORE_SOURCE = ${JSON.stringify(main)}; const HELPER_SOURCE = ${JSON.stringify(helper)}; const ROOM_SOURCE = ${JSON.stringify(room)}; ${fixture}\n})()`;
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails));
    assert.equal(result.result?.value?.pass, true, 'Actual transfer/room UI fixture did not pass');
    console.log(`Transfer/room actual DOM ${locale}: PASS ${JSON.stringify(result.result.value)}`);
    await call('Target.closeTarget', { targetId });
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  if (browser && browser.exitCode === null) {
    if (call) await call('Browser.close').catch(() => undefined);
    if (browser.exitCode === null) {
      await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 1500).unref(); });
      if (browser.exitCode === null) browser.kill();
    }
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { if (!failed) throw error; }
}
