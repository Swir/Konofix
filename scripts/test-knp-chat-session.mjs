import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync('src/knp-chat-session.ts', 'utf8'), { mode: 'transform' });
const { KnpChatSession } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const snapshot = (id, revision = 0) => ({ session_id: id, revision, node_id: 'node', nick: 'Alice', local_addr: '0.0.0.0:1234', contacts: [], messages: [] });
const calls = [];
const pending = [];
const changes = [];
const invoke = (command, args) => { const d = deferred(); calls.push({ command, args }); pending.push(d); return d.promise; };
const client = new KnpChatSession(invoke, value => changes.push(value));

const opening = client.start('Alice', 'default');
await assert.rejects(client.start('Alice', 'duplicate'), /already active/);
pending.shift().resolve(snapshot('first')); await opening;
assert.equal(client.snapshot.session_id, 'first');

// Native u64 message IDs stay lossless strings, even above Number.MAX_SAFE_INTEGER.
const refreshing = client.refresh();
await client.refresh();
assert.equal(pending.length, 1, 'only one poll may be in flight');
const value = snapshot('first', 1);
value.messages.push({ id: 'message', transport_id: '18446744073709551615' });
pending.shift().resolve(value); await refreshing;
assert.equal(client.snapshot.messages[0].transport_id, '18446744073709551615');

// Reject a response belonging to a different session and a regressing revision.
for (const value of [snapshot('foreign', 99), snapshot('first', 0)]) {
  const polling = client.refresh(); pending.shift().resolve(value); await polling;
  assert.equal(client.snapshot.revision, 1);
}

const sending = client.send('contact', 'draft stays until accepted');
assert.deepEqual(calls.at(-1), { command: 'send_knp_chat_message', args: { sessionId: 'first', peerNodeId: 'contact', text: 'draft stays until accepted' } });
pending.shift().reject(new Error('queue full'));
await assert.rejects(sending, /queue full/);
assert.equal(client.snapshot.session_id, 'first');

// A queued result arriving after logout cannot change the next session.
const poll = client.refresh(); const oldPoll = pending.shift();
const send = client.send('contact', 'old send'); const oldSend = pending.shift();
const closing = client.stop(); pending.shift().resolve(); await closing;
const reopened = client.start('Alice', 'default'); pending.shift().resolve(snapshot('second')); await reopened;
oldPoll.resolve(snapshot('first', 999)); oldSend.resolve('old-message');
await poll; assert.equal(await send, undefined);
assert.equal(client.snapshot.session_id, 'second');
assert.equal(changes.at(-1).session_id, 'second');

// Failed native shutdown must leave an active, recoverable session visible.
const failedClose = client.stop(); pending.shift().reject(new Error('shutdown failed'));
await assert.rejects(failedClose, /shutdown failed/);
assert.equal(client.snapshot.session_id, 'second');
const retry = client.stop(); pending.shift().resolve(); await retry;
assert.equal(client.snapshot, null);

// Cancellation during startup releases the actual late-created native session.
const late = client.start('Bob', 'isolated'); const lateStart = pending.shift();
await client.stop(); lateStart.resolve(snapshot('late'));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls.at(-1), { command: 'stop_knp_chat', args: { sessionId: 'late' } });
pending.shift().resolve(); await late;
assert.equal(client.snapshot, null);
console.log('KNP chat session: IPC routing, u64 strings, poll bounds, stale response fencing, send errors and shutdown recovery PASS.');
