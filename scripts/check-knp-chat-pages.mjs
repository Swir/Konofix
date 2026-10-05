// CI-only: drive two copies of the installed Windows application through their
// bundled UI and real Tauri IPC. CDP is restricted to runner loopback policies.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const [portA, portB] = process.argv.slice(2, 4).map(Number);
const [profileA, profileB] = process.argv.slice(4, 6);
for (const port of [portA, portB]) assert(Number.isInteger(port) && port > 0 && port < 65536);
assert.notEqual(portA, portB);
for (const profile of [profileA, profileB]) assert.match(profile, /^ci-[a-f0-9]+-[ab]$/);
assert.notEqual(profileA, profileB);

async function until(fn, label, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await delay(150);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

async function page(port) {
  const info = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const pages = await response.json();
    return pages.find(p => p.type === 'page' && /^https?:\/\/tauri\.localhost(?:\/|$)/.test(p.url));
  }, 'Bundled installed page');
  const endpoint = new URL(info.webSocketDebuggerUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  assert.equal(endpoint.port, String(port));
  const socket = new WebSocket(endpoint);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error || message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result?.result?.value);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Installed page evaluation timed out')); }, 15_000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    },
    close() { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Page closed')); } pending.clear(); socket.close(); },
  };
}

const a = await page(portA);
const b = await page(portB);
const snapshot = p => p.evaluate(`(async () => {
  const sessionId = document.querySelector('[data-session-id]')?.dataset.sessionId;
  if (!sessionId) return null;
  return window.__TAURI_INTERNALS__.invoke('knp_chat_snapshot', { sessionId });
})()`);
async function login(p, nick, profile) {
  await p.evaluate(`(() => {
    document.querySelector('#nick').value = ${JSON.stringify(nick)};
    document.querySelector('#knpProfile').value = ${JSON.stringify(profile)};
    document.querySelector('#chatTransport').value = 'knp';
    document.querySelector('#connectBtn').click();
  })()`);
}
async function contact(p, peer, label) {
  const port = Number(peer.local_addr.split(':').at(-1));
  await p.evaluate(`(() => {
    document.querySelector('#knpContacts').click();
    document.querySelector('#knpContactLabel').value = ${JSON.stringify(label)};
    document.querySelector('#knpContactNodeId').value = ${JSON.stringify(peer.node_id)};
    document.querySelector('#knpContactEndpoint').value = ${JSON.stringify(`127.0.0.1:${port}`)};
    document.querySelector('#knpAddContact').click();
  })()`);
  await until(async () => (await snapshot(p))?.contacts.some(c => c.node_id === peer.node_id), 'Contact admission');
  await until(() => p.evaluate(`!document.querySelector('#knpContactModal') && !document.querySelector('#msg').disabled`), 'Contact UI');
}
async function message(sender, receiver, text) {
  await sender.evaluate(`(() => { document.querySelector('#msg').value = ${JSON.stringify(text)}; document.querySelector('#send').click(); })()`);
  const outgoing = await until(async () => (await snapshot(sender))?.messages.find(m => m.outgoing && m.text === text && m.delivery === 'received'), 'Recipient application acknowledgement');
  const incoming = await until(async () => (await snapshot(receiver))?.messages.find(m => !m.outgoing && m.id === outgoing.id && m.text === text), 'Authenticated received text');
  assert.equal(typeof outgoing.transport_id, 'string');
  assert.equal(typeof incoming.transport_id, 'string');
  await until(() => sender.evaluate(`!!document.querySelector('[data-knp-message="${outgoing.id}"][data-delivery="received"]')`), 'Rendered application receipt');
  await until(() => receiver.evaluate(`!!document.querySelector('[data-knp-message="${outgoing.id}"]')`), 'Rendered incoming chat message');
  assert.equal(await receiver.evaluate(`Boolean(window.__knpInjected || document.querySelector('#messages img, #messages script'))`), false);
  return outgoing.id;
}

try {
  await login(a, 'Tester_A', profileA);
  const firstA = await until(() => snapshot(a), 'First KNP session');
  assert.match(firstA.node_id, /^knp1[0-9a-f]{40}$/);

  // A second process may not open the same persistent identity concurrently.
  await login(b, 'Tester_B', profileA);
  await until(() => b.evaluate(`document.querySelector('#loginError')?.textContent.includes('profile is in use')`), 'Exclusive Windows profile lock');
  await login(b, 'Tester_B', profileB);
  const firstB = await until(() => snapshot(b), 'Second KNP session');
  assert.notEqual(firstA.node_id, firstB.node_id);
  assert.notEqual(firstA.session_id, firstB.session_id);
  for (const p of [a, b]) {
    const result = await p.evaluate(`(async () => {
      try { await window.__TAURI_INTERNALS__.invoke('send_message', {room:'world',text:'must not enter legacy transport'}); return 'unexpected success'; }
      catch { return 'legacy inactive'; }
    })()`);
    assert.equal(result, 'legacy inactive');
  }
  await contact(a, firstB, 'Tester_B');
  await contact(b, firstA, 'Tester_A');
  const nonce = crypto.randomUUID();
  await message(a, b, `A to B ${nonce} <img src=x onerror="window.__knpInjected=1"> 🙂`);
  await message(b, a, `B to A ${nonce} hello`);

  // Logout must release the profile/socket and fence old IPC against the next session.
  await a.evaluate(`document.querySelector('#disconnect').click()`);
  await until(() => a.evaluate(`!!document.querySelector('#connectBtn')`), 'Logout UI');
  await login(a, 'Tester_A', profileA);
  const secondA = await until(() => snapshot(a), 'Reopened KNP session');
  assert.equal(secondA.node_id, firstA.node_id);
  assert.notEqual(secondA.session_id, firstA.session_id);
  assert.equal(secondA.messages.length, 0);
  assert.equal(secondA.contacts.length, 0);
  const stale = await a.evaluate(`(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('stop_knp_chat', {sessionId:${JSON.stringify(firstA.session_id)}}); return false; }
    catch { return true; }
  })()`);
  assert.equal(stale, true);
  assert.equal((await snapshot(a)).session_id, secondA.session_id);
  await contact(a, firstB, 'Tester_B');
  await contact(b, secondA, 'Tester_A');
  await message(a, b, `after reconnect ${nonce}`);
  for (const p of [a, b]) {
    await p.evaluate(`document.querySelector('#disconnect').click()`);
    await until(() => p.evaluate(`!!document.querySelector('#connectBtn')`), 'Final logout');
  }
  console.log('Installed KNP chat PASS: two real app processes, exclusive profiles, KNP-only bidirectional UI text, application receipts, escaped content, identity-preserving reconnect and stale-session rejection.');
  console.log('Evidence scope: two instances on one Windows runner over real loopback UDP; not two physical devices, NAT traversal or WAN.');
} finally { a.close(); b.close(); }
