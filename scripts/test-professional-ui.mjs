import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const root = process.cwd();
const source = fs.readFileSync('src/settings-ui.ts', 'utf8');
const updater = fs.readFileSync('src/test-updater-ui.ts', 'utf8');
const loader = fs.readFileSync('src/startup-ui-loader.ts', 'utf8');
assert.match(loader, /import\('\.\/settings-ui'\)/, 'settings must load after the core');
assert.match(updater, /konofix-settings-present/, 'reuse the existing updater observer');
assert.doesNotMatch(source, /new MutationObserver|setInterval|setTimeout|invoke\(/, 'settings may not poll or change network/media state');
assert.match(source, /professional-ui\.css/, 'professional styles must be included');
const strip = text => stripTypeScriptTypes(text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const settingsJs = strip(source), updaterJs = strip(updater);
// Minimal structural host. Existing full-cascade SDP/layout gate separately
// exercises actual repository CSS plus professional-ui.css against chat actions.
const hostCss = '*{box-sizing:border-box}body{margin:0;font-family:system-ui}.modal-wrap{position:fixed;inset:0;display:grid;place-items:center;padding:12px}.modal-head{display:flex;justify-content:space-between;align-items:center}.private-settings-card small{display:block}.inline-form,.stats-grid{display:grid}';
const css = hostCss + fs.readFileSync('src/professional-ui.css', 'utf8');
const fixture = fs.readFileSync('scripts/fixtures/settings-layout.browser.js', 'utf8');
const candidates = [process.env.KONOFIX_TEST_BROWSER];
for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
  for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) candidates.push(path.join(base, name));
}
candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
const executable = candidates.find(file => file && fs.existsSync(file));
assert.ok(executable, 'Settings gate requires Edge/Chromium; do not silently skip');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-settings-'));
const pending = new Map();
let browser, call, failed = false;
try {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${path.join(temp, 'profile')}`];
  if (process.platform === 'linux') args.push('--no-sandbox'); // Isolated ephemeral CI browser only.
  browser = spawn(executable, args, { stdio:['ignore','ignore','pipe','pipe','pipe'], windowsHide:true });
  let sequence=0, buffer='', stderr='';
  const rejectPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  browser.stderr.on('data', bytes => { stderr=(stderr+bytes).slice(-4000); });
  browser.on('error', rejectPending);
  browser.on('exit', code => rejectPending(new Error(`Settings browser exited (${code}): ${stderr}`)));
  browser.stdio[4].on('data', bytes => {
    buffer += bytes.toString(); let end;
    while ((end=buffer.indexOf('\0')) >= 0) {
      const raw=buffer.slice(0,end); buffer=buffer.slice(end+1); if (!raw) continue;
      const message=JSON.parse(raw), item=pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    }
  });
  call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{ pending.delete(id); reject(new Error(`Settings ${method} timed out: ${stderr}`)); },45000);
    pending.set(id,{resolve,reject,timer});
    browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  for (const locale of ['pl','en']) for (const width of [1280,820,360]) {
    const {targetId}=await call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false},sessionId);
    const expression=`(async()=>{const LOCALE=${JSON.stringify(locale)}, CSS_SOURCE=${JSON.stringify(css)}, SETTINGS_SOURCE=${JSON.stringify(settingsJs)}, UPDATER_SOURCE=${JSON.stringify(updaterJs)};\n${fixture}\n})()`;
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    assert.ok(!result.exceptionDetails,result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails));
    assert.equal(result.result?.value?.pass,true,'Settings DOM gate failed');
    console.log(`Settings ${locale} ${width}px: PASS ${JSON.stringify(result.result.value)}`);
    await call('Target.closeTarget',{targetId});
  }
} catch(error) { failed=true; throw error; }
finally {
  if(browser && browser.exitCode===null) {
    if(call) await call('Browser.close').catch(()=>undefined);
    if(browser.exitCode===null) {
      await new Promise(resolve=>{browser.once('exit',resolve);setTimeout(resolve,1500).unref();});
      if(browser.exitCode===null) browser.kill();
    }
  }
  for(const item of pending.values()) clearTimeout(item.timer);
  try { fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
  catch(error) { if(!failed) throw error; }
}
