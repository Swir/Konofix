import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-call-sounds-'));
let browser;
let closeBrowser;
const pending = new Map();
try {
  // Compile unchanged sound sources with the installed project CLI (including TS7).
  // Only locale resolution is stubbed, never the sound synthesis or settings code.
  for (const file of ['call-sounds.ts', 'call-sounds-ui.ts']) {
    fs.copyFileSync(path.join(root, 'src', file), path.join(temp, file));
  }
  fs.writeFileSync(path.join(temp, 'i18n.ts'), "export const currentLocale: string = 'en';\n");
  fs.writeFileSync(path.join(temp, 'assets.d.ts'), "declare module '*.css';\n");
  const config = path.join(temp, 'tsconfig.json');
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: true, rootDir: temp, outDir: path.join(temp, 'built'), types: [] },
    files: ['call-sounds.ts', 'call-sounds-ui.ts', 'i18n.ts', 'assets.d.ts'],
  }));
  const compiled = spawnSync('npx', ['--no-install', 'tsc', '--project', config, '--pretty', 'false'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
  assert.equal(compiled.status, 0, `Call sounds compilation failed: ${compiled.error || ''}\n${compiled.stdout}\n${compiled.stderr}`);
  const engine = fs.readFileSync(path.join(temp, 'built/call-sounds.js'), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(engine).toString('base64')}`);
  const { CallSoundPlayer, synthesizeCallTone, boundedCallVolume, DEFAULT_CALL_SOUND_PREFERENCES: defaults } = mod;
  let assertions = 0;
  function check(value, label) { assertions++; assert.ok(value, label); }
  const pcm = synthesizeCallTone('outgoing', 48000);
  const chime = synthesizeCallTone('incoming', 48000);
  check(pcm.length === 172800 && chime.length === pcm.length, 'bounded 3.6s PCM duration');
  check(pcm.every(value => Number.isFinite(value) && Math.abs(value) <= 0.17), 'outgoing samples finite and headroom bounded');
  check(chime.every(value => Number.isFinite(value) && Math.abs(value) <= 0.17), 'incoming samples finite and headroom bounded');
  check(pcm.slice(0, 30000).some(value => value !== 0) && pcm.slice(80000).every(value => value === 0), 'ringback contains sound and a real pause');
  check(pcm.some((value, i) => value !== chime[i]), 'ringback and ringtone are distinct');
  check(boundedCallVolume(NaN) === 0.45 && boundedCallVolume(2) === 1 && boundedCallVolume(-1) === 0, 'invalid volume stays bounded');

  class FakeContext {
    state = 'running'; sampleRate = 8000; currentTime = 10; sources = []; destinations = []; closed = false;
    destination = {}; onstatechange = null;
    createGain() { return { gain: { setValueAtTime: value => { this.volume = value; } }, connect: destination => this.destinations.push(destination), disconnect() {} }; }
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel(data) { this.pcm = data; } }; }
    createBufferSource() {
      const node = { started: 0, stopped: [], disconnected: false, onended: null,
        connect() {}, start() { this.started++; }, stop(time = 0) { this.stopped.push(time); }, disconnect() { this.disconnected = true; } };
      this.sources.push(node); return node;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  }
  const context = new FakeContext();
  let factories = 0;
  const statuses = [];
  const player = new CallSoundPlayer(() => { factories++; return context; }, status => statuses.push(status));
  const session = (phase, id = 'call-a', deafened = false) => ({ id, phase, deafened });
  player.setCall(session('calling'));
  check(factories === 0 && statuses.at(-1) === 'blocked', 'remote/start state cannot bypass gesture initialization');
  player.unlock();
  check(factories === 1 && context.sources.length === 1 && context.sources[0].loop, 'one output-only loop after unlock');
  for (let i = 0; i < 100; i++) player.setCall(session('calling'));
  check(context.sources.length === 1, 'repeated session events never stack loops');
  player.configure({ ...defaults, volume: 0.2 });
  check(context.sources.length === 1 && context.volume === 0.2, 'live volume changes do not recreate playback');
  for (const phase of ['joining', 'connected', 'reconnecting', 'ended', 'error']) {
    player.setCall(session('calling')); const old = context.sources.at(-1);
    player.setCall(session(phase));
    check(old.disconnected && old.stopped.includes(0), `${phase} stops ringback immediately`);
  }
  player.setCall(session('ringing')); let old = context.sources.at(-1);
  check(old.loop && old.buffer.pcm.length > 0, 'incoming call uses a synthesized loop');
  player.configure({ ...defaults, quiet: true });
  check(old.disconnected, 'notification mute stops incoming audio immediately');
  player.configure({ ...defaults, incoming: false });
  let total = context.sources.length; player.setCall(session('ringing'));
  check(context.sources.length === total, 'incoming toggle is enforced');
  player.setCall(session('calling')); check(context.sources.length === total + 1, 'incoming toggle does not disable outgoing ringback');
  player.configure({ ...defaults, outgoing: false }); old = context.sources.at(-1);
  check(old.disconnected, 'outgoing toggle stops ringback');
  player.configure({ ...defaults, volume: 0 }); total = context.sources.length;
  player.setCall(session('ringing')); check(context.sources.length === total, 'zero volume suppresses all sources');
  player.configure(defaults); old = context.sources.at(-1);
  player.setCall(session('ringing', 'call-a', true)); check(old.disconnected, 'deafen stops ringtone');
  player.setCall(session('connected')); check(!player.preview('incoming'), 'no preview during a conversation');
  player.setCall(null); check(player.preview('incoming'), 'idle explicit preview is available');
  old = context.sources.at(-1); check(!old.loop && old.stopped.includes(11.8), 'preview is bounded to 1.8s');
  const staleEnded = old.onended;
  player.setCall(session('ringing', 'new-call')); const current = context.sources.at(-1);
  staleEnded(); check(!current.disconnected, 'late previous onended cannot cancel a new call');
  player.setCall(null); check(current.disconnected, 'reset disconnects all feedback');
  player.preview('outgoing'); old = context.sources.at(-1); player.stopPreview();
  check(old.disconnected, 'manual preview stop releases source');
  player.dispose(); check(context.closed, 'unload releases the context');
  total = context.sources.length; player.unlock(); player.setCall(session('ringing'));
  check(context.sources.length === total, 'disposed player cannot restart');
  check(context.destinations.length === 1 && context.destinations[0] === context.destination, 'graph connects only to local speakers');

  const delayed = new FakeContext(); delayed.state = 'suspended';
  let resume;
  delayed.resume = () => new Promise(resolve => { resume = () => { delayed.state = 'running'; resolve(); }; });
  const race = new CallSoundPlayer(() => delayed);
  race.setCall(session('ringing')); race.unlock(); race.setCall(null); resume();
  await Promise.resolve();
  check(delayed.sources.length === 0, 'late autoplay resume does not resurrect a cancelled call');
  race.setCall(session('ringing')); race.dispose();
  check(delayed.sources.at(-1).disconnected && delayed.closed, 'dispose stops incoming feedback');
  const unavailable = [];
  const broken = new CallSoundPlayer(() => { throw new Error('audio unavailable'); }, value => unavailable.push(value));
  broken.setCall(session('calling')); broken.unlock();
  check(unavailable.at(-1) === 'unavailable', 'sound initialization errors do not throw into call code');
  broken.dispose();
  console.log(`Call sounds lifecycle/PCM: ${assertions} checks PASS.`);

  const uiSource = fs.readFileSync(path.join(root, 'src/private-audio-ui.ts'), 'utf8');
  assert.match(uiSource, /onSession\(session\)\s*\{\s*syncCallSoundSession\(session\)/, 'private session events drive feedback directly');
  assert.match(uiSource, /mountCallSoundSettings\(modal\)/, 'settings integrate with the existing UI observer');
  assert.match(uiSource, /phase === 'offline'[^]*?resetPrivateAudioUi\(\)/, 'offline must release call resources');
  assert.match(uiSource, /function resetPrivateAudioUi\(\): void \{\s*syncCallSoundSession\(null\);\s*controller.reset\(\)/, 'offline/error clear sounds before media cleanup');
  assert.match(uiSource, /if \(controller.activeSession\(\)\) \{[^]*?return;[^]*?activePeer = peer;/, 'busy guard must precede peer mutation');
  const startSource = uiSource.slice(uiSource.indexOf('async function startPrivateCall('), uiSource.indexOf('async function acceptIncomingCall('));
  const originalPeer = { peerId: 'original' }, originalStream = {};
  const calls = [], busyContext = {
    controller: { activeSession: () => ({ phase: 'connected' }) },
    privateCallsEnabled: () => true, alert: value => calls.push(value), copy: { busy: 'busy' },
    activePeer: originalPeer, remoteStream: originalStream, currentError: '', devices: ['original'], selectedDeviceId: 'original', loadedDevicesForSession: 'original',
  };
  await vm.runInNewContext(stripTypeScriptTypes(startSource) + '\nstartPrivateCall({peerId: "another"});', busyContext, { timeout: 1000 });
  assert.equal(busyContext.activePeer, originalPeer);
  assert.equal(busyContext.remoteStream, originalStream);
  assert.deepEqual(calls, ['busy']);
  const resetSource = uiSource.slice(uiSource.indexOf('function resetPrivateAudioUi('), uiSource.indexOf("void listen('network-error', resetPrivateAudioUi)"));
  const cleanup = [], resetContext = {
    syncCallSoundSession: value => cleanup.push(value), controller: { reset: () => cleanup.push('media') },
    removeIncomingDialog: () => cleanup.push('dialog'), document: { querySelector: () => ({ remove: () => cleanup.push('panel') }) },
  };
  vm.runInNewContext(stripTypeScriptTypes(resetSource) + '\nresetPrivateAudioUi();', resetContext, { timeout: 1000 });
  assert.deepEqual(cleanup, [null, 'media', 'dialog', 'panel']);
  assert.equal(resetContext.remoteStream, null);
  assert.equal(resetContext.activePeer, null);
  console.log('Private UI busy-state preservation and offline cleanup runtime: PASS.');
  const settingsJs = fs.readFileSync(path.join(temp, 'built/call-sounds-ui.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  assert.doesNotMatch(settingsJs, /new MutationObserver|setInterval|getUserMedia/, 'sounds add no DOM feedback loop, polling, or mic access');

  const candidates = [process.env.KONOFIX_TEST_BROWSER];
  for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
    for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) candidates.push(path.join(base, name));
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executable, 'Call sounds DOM gate requires Edge/Chromium; do not skip');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${path.join(temp, 'profile')}`];
  if (process.platform === 'linux') args.push('--no-sandbox'); // Disposable CI browser only.
  browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let sequence = 0, buffer = '', stderr = '';
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  browser.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  browser.on('error', rejectAll);
  browser.on('exit', code => rejectAll(new Error(`Call sounds browser exited ${code}: ${stderr}`)));
  browser.stdio[4].on('data', bytes => {
    buffer += bytes.toString(); let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!raw) continue;
      const message = JSON.parse(raw), item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Call sounds ${method} timeout: ${stderr}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  closeBrowser = () => call('Browser.close');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const css = fs.readFileSync(path.join(root, 'src/call-sounds.css'), 'utf8');
  const fixture = fs.readFileSync(path.join(root, 'scripts/fixtures/call-sounds.browser.js'), 'utf8');
  for (const locale of ['pl', 'en']) {
    const expression = `(async () => { const currentLocale = ${JSON.stringify(locale)}; const REPOSITORY_CSS = ${JSON.stringify(css)};\n${engine.replace(/^export /gm, '')}\n${settingsJs}\n${fixture}\n})()`;
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || 'Browser fixture error');
    assert.equal(result.result?.value?.pass, true, 'Call sounds native PCM/DOM fixture failed');
    console.log(`Call sounds DOM ${locale}: ${JSON.stringify(result.result.value)}`);
  }
  // Browser.close may terminate the pipe before its response; cleanup owns exit.
} finally {
  if (browser && browser.exitCode === null && closeBrowser) {
    await closeBrowser().catch(() => {});
    if (browser.exitCode === null) await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
