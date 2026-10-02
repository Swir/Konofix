import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const deadline = Date.now() + 45_000;
let lastError;

async function inspect(url) {
  const endpoint = new URL(url);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  assert.equal(endpoint.port, String(port));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => done(new Error('inspection timeout')), 5000);
    let settled = false;
    function done(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      error ? reject(error) : resolve(value);
    }
    ws.addEventListener('error', () => done(new Error('inspection socket failed')), { once: true });
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const listeners = window.__TAURI_EVENT_LISTENERS__ || {};
          const names = Object.keys(listeners);
          return {
            url: location.href,
            ready: document.readyState,
            nick: !!document.querySelector('#nick'),
            connect: !!document.querySelector('#connectBtn'),
            network: !!document.querySelector('#loginNetwork'),
            names,
            critical: ['chat-message','network-status','file-transfer'].every(name => names.includes(name))
          };
        })()`,
        returnByValue: true
      }
    })), { once: true });
    ws.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) done(new Error(JSON.stringify(message)));
        else done(null, message.result?.result?.value);
      } catch (error) {
        done(error);
      }
    });
  });
}

while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const pages = await response.json();
    for (const page of pages.filter(item => item.type === 'page' && item.webSocketDebuggerUrl)) {
      const state = await inspect(page.webSocketDebuggerUrl);
      if (state?.ready === 'complete' && state.nick && state.connect && state.network && state.critical) {
        assert.match(state.url, /^https?:\/\/tauri\.localhost(?:\/|$)/);
        console.log('Installed Chat frontend and application event subscriptions are ready.');
        process.exit(0);
      }
      lastError = new Error(JSON.stringify(state));
    }
  } catch (error) {
    lastError = error;
  }
  await delay(300);
}
throw new Error(`Installed Chat startup inspection failed: ${lastError?.message || 'no page'}`);
