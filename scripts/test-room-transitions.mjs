import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function createRoom()'), source.indexOf('function offerFile()'));
assert.ok(functions.includes("invoke('enter_room'"));

function harness() {
  const pending = [];
  const alerts = [];
  const state = {
    connected: true, room: 'world',
    rooms: new Map(['world', 'alpha', 'beta'].map(id => [id, { id, users: 0 }])),
    messages: new Map(),
  };
  const context = vm.createContext({
    state, sessionRevision: 1, roomChangePending: false,
    invoke: (command, args) => new Promise((resolve, reject) => pending.push({ command, args, resolve, reject })),
    renderChat() {}, prompt: () => 'new room', t: key => key,
    alert: message => alerts.push(message),
  });
  vm.runInContext(stripTypeScriptTypes(functions), context);
  return { context, pending, alerts, state };
}

{
  const h = harness();
  const switched = h.context.switchRoom('alpha');
  assert.equal(h.state.room, 'world', 'selection must wait for backend acceptance');
  assert.equal(h.pending[0].command, 'enter_room');
  assert.equal(h.pending[0].args.roomId, 'alpha');
  await h.context.switchRoom('beta');
  assert.equal(h.pending.length, 1, 'concurrent selections must not diverge from backend order');
  h.pending[0].resolve();
  await switched;
  assert.equal(h.state.room, 'alpha');
  const rejected = h.context.switchRoom('beta');
  h.pending[1].reject(new Error('room closed'));
  await rejected;
  assert.equal(h.state.room, 'alpha', 'failed selection preserves active room');
  assert.equal(h.alerts.length, 1);
}
{
  const h = harness();
  const switched = h.context.switchRoom('alpha');
  h.state.rooms.delete('alpha');
  h.pending[0].resolve();
  await switched;
  assert.equal(h.state.room, 'world', 'closed room cannot be resurrected by an acknowledgement');
}
{
  const h = harness();
  const switched = h.context.switchRoom('alpha');
  h.context.sessionRevision += 1;
  h.pending[0].resolve();
  await switched;
  assert.equal(h.state.room, 'world', 'stale session cannot change room');
}
{
  const h = harness();
  const created = h.context.createRoom();
  h.pending[0].reject(new Error('room already owned'));
  await created;
  assert.equal(h.state.room, 'world');
  assert.equal(h.state.rooms.has('new-room'), false, 'rejected create must not produce a phantom room');
}
{
  const h = harness();
  const created = h.context.createRoom();
  h.context.sessionRevision += 1;
  h.pending[0].resolve({ id: 'new-room', users: 1 });
  await created;
  assert.equal(h.state.rooms.has('new-room'), false, 'stale create response cannot repopulate a session');
}
console.log('Room transitions: backend acknowledgement, rejection, concurrency and stale-session checks passed.');
