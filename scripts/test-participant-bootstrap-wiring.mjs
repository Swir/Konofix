import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { mergeBootstrapSources } from '../src/bootstrap-discovery.ts';

const main = readFileSync(process.env.KONOFIX_CONNECT_SOURCE ?? new URL('../src/main.ts', import.meta.url), 'utf8');
const start = main.indexOf('async function connect() {');
const end = main.indexOf('\nfunction renderChat()', start);
assert.ok(start >= 0 && end > start, 'production connect function must exist');
const code = stripTypeScriptTypes(main.slice(start, end));
// Executes the actual connect function, but DOM and IPC are injected. This proves
// argument/lifecycle wiring only, NOT native networking or installed-app startup.
function fixture() {
  const calls = [], input = { value: 'Tester' }, error = { textContent: '' }, button = {};
  const context = {
    connectPending: false, sessionRevision: 0, state: { connected: false, nickColor: '#62E5FF' },
    document: { querySelector: selector => ({ '#nick': input, '#loginError': error, '#connectBtn': button })[selector] },
    normalizeNick: value => value.trim(), normalizeNickColor: value => value,
    t: value => value, localStorage: { setItem() {} }, renderChat() {}, addSystem() {},
    mergeBootstrapSources, loadRemoteBootstraps: async () => ['participant-a', 'participant-b'],
    loadBootstraps: () => ['manual-contact', 'participant-a'],
    invoke: async (name, args) => {
      calls.push({ name, args });
      return { peer_id: 'local-peer', nick: 'Tester', nick_color: '#62E5FF', version: '0.6.0' };
    },
  };
  return { context, calls, error, button, run: () => runInNewContext(code + '\nconnect();', context, { timeout: 1000 }) };
}

test('existing connect forwards the resolved contacts and saved contacts to start_network', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, 'start_network');
  assert.deepEqual(f.calls[0].args.bootstraps, ['participant-a', 'participant-b', 'manual-contact']);
  assert.equal(f.context.state.peerId, 'local-peer');
});

test('cancelled connection generation cannot forward late discovery into a new native session', async () => {
  const f = fixture();
  f.context.loadRemoteBootstraps = async () => { f.context.sessionRevision++; return ['stale-contact']; };
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.state.connected, false);
});

test('native start rejection is still surfaced without claiming an established session', async () => {
  const f = fixture();
  f.context.invoke = async () => { throw Error('native rejection'); };
  await f.run();
  assert.equal(f.context.state.connected, false);
  assert.equal(f.context.connectPending, false);
  assert.equal(f.button.disabled, false);
  assert.match(f.error.textContent, /native rejection/);
});
