import assert from 'node:assert/strict';
import { PrivateAudioOutput } from '../src/private-audio-output.ts';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class MockAudio {
  dataset = {};
  attributes = new Map();
  srcObject = null;
  appended = false;
  removed = false;
  paused = false;
  playCount = 0;
  pending = [];
  setAttribute(key, value) { this.attributes.set(key, value); }
  play() {
    assert.equal(this.appended, true, 'native media must be attached before starting remote playback');
    assert.ok(this.srcObject, 'native media must own the remote stream before playback');
    this.playCount += 1;
    this.paused = false;
    const attempt = deferred();
    this.pending.push(attempt);
    return attempt.promise;
  }
  pause() { this.paused = true; }
  remove() { this.removed = true; }
}

function fixture() {
  const elements = [];
  const updates = [];
  const output = new PrivateAudioOutput({
    createAudio() {
      const audio = new MockAudio();
      elements.push(audio);
      return audio;
    },
    appendAudio(audio) { audio.appended = true; },
    onPlaybackState(peerId, blocked) { updates.push({ peerId, blocked }); },
  });
  return { output, elements, updates };
}

{
  const { output, elements, updates } = fixture();
  const stream = { id: 'remote-a' };
  output.attach('peer-a', stream);
  const audio = elements[0];
  assert.equal(audio.srcObject, stream);
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 1);
  assert.equal(audio.autoplay, true);
  assert.equal(audio.hidden, true);
  assert.equal(audio.attributes.has('playsinline'), true);
  assert.equal(audio.dataset.peerId, 'peer-a');
  audio.pending[0].resolve();
  await settle();
  assert.deepEqual(updates, [{ peerId: 'peer-a', blocked: false }]);
  output.attach('peer-a', stream);
  output.retry();
  assert.equal(audio.playCount, 1, 'duplicate track notifications and gestures must not restart healthy playback');
  output.stop('peer-b');
  output.attach('peer-b', null);
  assert.equal(audio.srcObject, stream, 'late cleanup for another peer must not silence the current call');
  output.stop('peer-a');
  assert.equal(audio.paused, true);
  assert.equal(audio.srcObject, null);
  assert.equal(audio.removed, true);
  assert.equal(output.isBlocked('peer-a'), false);
}

{
  const { output, elements, updates } = fixture();
  output.attach('peer-a', { id: 'blocked' });
  const audio = elements[0];
  audio.pending[0].reject(new DOMException('Autoplay denied', 'NotAllowedError'));
  await settle();
  assert.equal(output.isBlocked('peer-a'), true);
  assert.deepEqual(updates, [{ peerId: 'peer-a', blocked: true }]);
  output.retry();
  output.retry();
  assert.equal(audio.playCount, 2, 'a gesture retries once without racing an in-flight play request');
  audio.pending[1].resolve();
  await settle();
  assert.equal(output.isBlocked('peer-a'), false);
  assert.deepEqual(updates.at(-1), { peerId: 'peer-a', blocked: false });
  output.stop();
}

for (const outcome of ['resolve', 'reject']) {
  const { output, elements, updates } = fixture();
  output.attach('peer-a', { id: `ended-${outcome}` });
  const ended = elements[0];
  output.stop('peer-a');
  ended.pending[0][outcome](new Error('Late settlement'));
  await settle();
  assert.deepEqual(updates, [], `a late play ${outcome} after hangup must not revive call UI`);
  output.retry();
  assert.equal(ended.playCount, 1);
  assert.equal(ended.srcObject, null);
}

for (const replacementPeer of ['peer-a', 'peer-b']) {
  const { output, elements, updates } = fixture();
  output.attach('peer-a', { id: 'old-call' });
  const old = elements[0];
  const replacement = { id: 'replacement-call' };
  output.attach(replacementPeer, replacement);
  const active = elements[1];
  assert.equal(old.removed, true);
  assert.equal(old.srcObject, null);
  active.pending[0].resolve();
  await settle();
  old.pending[0].reject(new Error('Old call was stopped'));
  await settle();
  assert.deepEqual(updates, [{ peerId: replacementPeer, blocked: false }],
    'a replaced stream must not overwrite the new call playback state');
  assert.equal(active.srcObject, replacement);
  assert.equal(output.isBlocked(replacementPeer), false);
  output.stop();
}

console.log('Private audio output: native playback, gesture retry, peer cleanup and stale settlement guards passed.');
