import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const strip = text => stripTypeScriptTypes(text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const loader = fs.readFileSync('src/startup-ui-loader.ts', 'utf8');
const localeSource = fs.readFileSync('src/locale-settings-ui.ts', 'utf8');
const main = fs.readFileSync('src/main.ts', 'utf8');
const i18n = fs.readFileSync('src/i18n.ts', 'utf8');
const login = main.slice(main.indexOf('function renderLogin()'), main.indexOf('async function connect()'));
assert.ok(login.includes('login-card') && login.includes('connectBtn'), 'Use the actual core login renderer');
assert.match(loader, /import '\.\/login-layout\.css'/, 'Layout fix must load before optional modules');
assert.match(loader, /import\('\.\/locale-settings-ui'\)/, 'Language settings must be wired');
assert.doesNotMatch(localeSource, /new MutationObserver|setInterval|setTimeout|invoke\(|location\.(reload|assign|replace)/, 'Language preference must not restart, poll or change network state');
const resolver = i18n.slice(i18n.indexOf('function systemLocale()'), i18n.indexOf('export const currentLocale'));
const supported = i18n.match(/const SUPPORTED: Locale\[\] = (\[[^;]+\]);/)?.[1];
assert.ok(resolver.includes('localStorage.getItem(STORAGE_KEY)') && supported, 'Test against actual startup preference resolver');
const css = ['style.css','ui-layout.css','login-layout.css','secure-ui.css','private-audio-ui.css','room-audio-ui.css','chat-usability.css','professional-ui.css']
  .map(name => fs.readFileSync(`src/${name}`, 'utf8')).join('\n');
const fixture = fs.readFileSync('scripts/fixtures/login-locale.browser.js', 'utf8');
const candidates = [process.env.KONOFIX_TEST_BROWSER];
for (const base of [process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES,process.env.LOCALAPPDATA].filter(Boolean)) {
  for (const file of ['Microsoft/Edge/Application/msedge.exe','Google/Chrome/Application/chrome.exe']) candidates.push(path.join(base,file));
}
candidates.push('/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome');
const executable = candidates.find(file => file && fs.existsSync(file));
assert.ok(executable, 'Login/language regression requires Edge/Chromium; do not skip');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'konofix-login-locale-'));
const pending = new Map();
let browser, call, failed = false;
try {
  const args = ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-pipe',`--user-data-dir=${path.join(temp,'profile')}`];
  if (process.platform === 'linux') args.push('--no-sandbox'); // Ephemeral test browser only.
  browser = spawn(executable,args,{stdio:['ignore','ignore','pipe','pipe','pipe'],windowsHide:true});
  let sequence = 0, buffer = '', stderr = '';
  const rejectAll = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  browser.stderr.on('data',bytes => { stderr = (stderr+bytes).slice(-4000); });
  browser.on('error',rejectAll);
  browser.on('exit',code => rejectAll(new Error(`Browser exited (${code}): ${stderr}`)));
  browser.stdio[4].on('data',bytes => {
    buffer += bytes.toString(); let end;
    while ((end=buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0,end); buffer = buffer.slice(end+1); if (!raw) continue;
      const message = JSON.parse(raw), task = pending.get(message.id); if (!task) continue;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    }
  });
  call = (method,params={},sessionId) => new Promise((resolve,reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); },30000);
    pending.set(id,{resolve,reject,timer}); browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  for (const locale of ['pl','en']) for (const [width,height] of [[1280,760],[1280,620],[980,620],[1024,608],[853,507],[360,600]]) {
    const {targetId} = await call('Target.createTarget',{url:'about:blank'});
    const {sessionId} = await call('Target.attachToTarget',{targetId,flatten:true});
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},sessionId);
    const expression = `(async()=>{const LOCALE=${JSON.stringify(locale)}, CSS_SOURCE=${JSON.stringify(css)}, LOGIN_SOURCE=${JSON.stringify(strip(login))}, LOCALE_SOURCE=${JSON.stringify(strip(localeSource))}, RESOLVER=${JSON.stringify(strip(resolver))}, SUPPORTED=${supported};\n${fixture}\n})()`;
    const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    assert.ok(!result.exceptionDetails,result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails));
    assert.equal(result.result?.value?.pass,true,'Login/language browser gate failed');
    console.log(`Login/language ${locale} ${width}x${height}: PASS ${JSON.stringify(result.result.value)}`);
    await call('Target.closeTarget',{targetId});
  }
} catch (error) { failed = true; throw error; }
finally {
  if (browser && browser.exitCode === null) {
    if (call) await call('Browser.close').catch(()=>undefined);
    if (browser.exitCode === null) { await new Promise(resolve=>{browser.once('exit',resolve);setTimeout(resolve,1500).unref();}); if(browser.exitCode === null) browser.kill(); }
  }
  for (const task of pending.values()) clearTimeout(task.timer);
  try { fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200}); } catch(error) { if(!failed) throw error; }
}
