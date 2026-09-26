// CI-only inspection of the installed app's WebView2 over a loopback debug port.
// The application does not enable remote debugging in normal operation.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Expected a loopback debug port');
const deadline = Date.now() + 45_000;
let lastError;

async function inspectPage(url) {
  const endpoint = new URL(url);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  assert.equal(endpoint.port, String(port));

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    let finished = false;
    const timer = setTimeout(() => finish(new Error('WebView inspection timed out')), 5000);

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const request of pending.values()) {
        request.reject(new Error('WebView inspection finished before command response'));
      }
      pending.clear();
      socket.close();
      if (error) reject(error); else resolve(value);
    }

    function evaluate(expression) {
      return new Promise((resolveCommand, rejectCommand) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
          },
        }));
      });
    }

    socket.addEventListener('error', () => finish(new Error('WebView socket failed')), { once: true });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        finish(error);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) {
        request.reject(new Error(JSON.stringify(message)));
      } else {
        request.resolve(message.result?.result?.value);
      }
    });

    socket.addEventListener('open', async () => {
      try {
        // WebView2 153 can stall a CDP Runtime.evaluate call that uses
        // awaitPromise while the evaluated Promise crosses Tauri's event IPC.
        // Start the real listen/unlisten round-trip in page context without
        // awaiting it from CDP, then poll only a plain synchronous state object.
        // This keeps the runtime event-bridge assertion without making the
        // startup gate depend on DevTools awaiting the IPC Promise itself.
        let state = await evaluate(`(() => {
          const existing = window.__KONOFIX_CI_STARTUP_PROBE__;
          if (existing?.eventProbe === 'pending' || existing?.eventProbe === 'ok') return existing;

          const state = {
            url: location.href,
            ready: document.readyState,
            nick: !!document.querySelector('#nick'),
            connect: !!document.querySelector('#connectBtn'),
            network: !!document.querySelector('#loginNetwork'),
            invoke: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
            eventApi: typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener === 'function',
            events: false,
            eventProbe: 'not-started',
          };
          window.__KONOFIX_CI_STARTUP_PROBE__ = state;

          const api = window.__TAURI_INTERNALS__;
          if (!state.nick || !state.connect || !state.network || !state.invoke || !state.eventApi ||
              typeof api.transformCallback !== 'function' || typeof api.unregisterCallback !== 'function') {
            return state;
          }

          const handler = api.transformCallback(() => {});
          state.eventProbe = 'pending';
          (async () => {
            try {
              const event = 'konofix-ci-startup';
              const eventId = await api.invoke('plugin:event|listen', {
                event,
                target: { kind: 'Any' },
                handler,
              });
              window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
              await api.invoke('plugin:event|unlisten', { event, eventId });
              state.events = true;
              state.eventProbe = 'ok';
            } catch (error) {
              state.eventProbe = 'error: ' + String(error);
            } finally {
              api.unregisterCallback(handler);
            }
          })();
          return state;
        })()`);

        const pollDeadline = Date.now() + 4000;
        while (state?.eventProbe === 'pending' && Date.now() < pollDeadline) {
          await delay(150);
          state = await evaluate('window.__KONOFIX_CI_STARTUP_PROBE__');
        }
        finish(null, state);
      } catch (error) {
        finish(error);
      }
    }, { once: true });
  });
}

while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const pages = await response.json();
    for (const page of pages.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl)) {
      const state = await inspectPage(page.webSocketDebuggerUrl);
      if (state?.ready === 'complete' && state.nick && state.connect && state.network &&
          state.invoke && state.eventApi && state.events && state.eventProbe === 'ok') {
        assert.match(state.url, /^https?:\/\/tauri\.localhost(?:\/|$)/, 'Must load bundled production assets');
        console.log('Installed Chat frontend: bundled login form, Tauri bridge and live event subscriptions ready.');
        process.exit(0);
      }
      lastError = new Error(`Chat page is not ready: ${JSON.stringify(state)}`);
    }
  } catch (error) {
    lastError = error;
  }
  await delay(300);
}
throw new Error(`Installed Chat did not render its login form: ${lastError?.message ?? 'no WebView page'}`);
