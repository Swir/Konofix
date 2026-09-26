import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

// No added browser/library dependency: use the runner's installed Edge/Chromium.
function findBrowser() {
  const candidates = [process.env.KONOFIX_TEST_BROWSER];
  for (const root of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
    for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) candidates.push(path.join(root, name));
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  const browser = candidates.find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(browser, 'SDP/layout gate requires Edge/Chromium; do not silently skip');
  return browser;
}

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-audio-browser-'));
let browser;
const pending = new Map();
try {
  const config = path.join(temp, 'tsconfig.json');
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ES2022', lib: ['ES2022', 'DOM'], skipLibCheck: true, outDir: path.join(temp, 'built'), types: [] },
    files: [path.join(root, 'src/audio-media-engine.ts')],
  }));
  const compile = spawnSync('npx', ['--no-install', 'tsc', '--project', config, '--pretty', 'false'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
  assert.equal(compile.status, 0, `SDP fixture compilation failed: ${compile.error || ''}\n${compile.stdout}\n${compile.stderr}`);
  const engine = fs.readFileSync(path.join(temp, 'built/audio-media-engine.js'), 'utf8').replace(/^export /gm, '');
  const css = ['style.css', 'secure-ui.css', 'private-audio-ui.css', 'room-audio-ui.css', 'ui-layout.css'].map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  const fixture = fs.readFileSync(path.join(root, 'scripts/fixtures/audio-sdp-layout.browser.js'), 'utf8');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${path.join(temp, 'profile')}`];
  if (process.platform === 'linux') args.push('--no-sandbox'); // Isolated ephemeral CI browser only.
  browser = spawn(findBrowser(), args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let sequence = 0, buffer = '', stderr = '';
  browser.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  const rejectPending = reason => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(reason); } pending.clear(); };
  browser.on('error', rejectPending);
  browser.on('exit', code => rejectPending(new Error(`Test browser exited (${code}): ${stderr}`)));
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
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser ${method} timed out: ${stderr}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  for (const width of [1600, 1280, 1024, 820]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const result = await call('Runtime.evaluate', { expression: `(async () => { const REPOSITORY_CSS = ${JSON.stringify(css)};\n${engine}\n${fixture}\n})()`, awaitPromise: true, returnByValue: true }, sessionId);
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails));
    assert.equal(result.result?.value?.pass, true, 'native SDP/layout fixture did not pass');
    console.log(`PASS SDP/layout ${width}px: ${JSON.stringify(result.result.value)}`);
  }
  await call('Browser.close');
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
