// CI-only inspection of the installed app's WebView2 over a loopback debug port.
// The application does not enable remote debugging in normal operation.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Expected a loopback debug port');
const deadline = Date.now() + 30_000;
let lastError;

async function inspectPage(url) {
  const endpoint = new URL(url);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  assert.equal(endpoint.port, String(port));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error('WebView inspection timed out')), 2000);
    function finish(error, value) {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(value);
    }
    socket.addEventListener('error', () => finish(new Error('WebView socket failed')), { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `({ url: location.href, ready: document.readyState,
          nick: !!document.querySelector('#nick'),
          connect: !!document.querySelector('#connectBtn'),
          network: !!document.querySelector('#loginNetwork'),
          invoke: typeof window.__TAURI_INTERNALS__?.invoke === 'function' })`,
        returnByValue: true,
      },
    })), { once: true });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        if (message.error || message.result?.exceptionDetails) finish(new Error(JSON.stringify(message)));
        else finish(null, message.result?.result?.value);
      }
    });
  });
}

while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const pages = await response.json();
    for (const page of pages.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl)) {
      const state = await inspectPage(page.webSocketDebuggerUrl);
      if (state?.ready === 'complete' && state.nick && state.connect && state.network && state.invoke) {
        assert.match(state.url, /^https?:\/\/tauri\.localhost(?:\/|$)/, 'Must load bundled production assets');
        console.log('Installed Chat frontend: bundled login form and Tauri bridge ready.');
        process.exit(0);
      }
      lastError = new Error(`Chat page is not ready: ${JSON.stringify(state)}`);
    }
  } catch (error) { lastError = error; }
  await delay(300);
}
throw new Error(`Installed Chat did not render its login form: ${lastError?.message ?? 'no WebView page'}`);
