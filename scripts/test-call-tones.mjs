import assert from 'node:assert/strict';

globalThis.window = globalThis;

class MockAudioParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class MockOscillator {
  frequency = new MockAudioParam();
  listeners = new Map();
  started = false;
  stopped = false;
  connect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

class MockMediaSource {
  connected = false;
  disconnected = false;
  connect() { this.connected = true; }
  disconnect() { this.disconnected = true; }
}

class MockAudioContext {
  state = 'suspended';
  currentTime = 1;
  destination = {};
  resumeCount = 0;
  oscillators = [];
  mediaSources = [];
  async resume() {
    this.resumeCount += 1;
    this.state = 'running';
  }
  createGain() {
    return { gain: new MockAudioParam(), connect() {} };
  }
  createOscillator() {
    const oscillator = new MockOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createMediaStreamSource() {
    const source = new MockMediaSource();
    this.mediaSources.push(source);
    return source;
  }
}

const { CallTonePlayer } = await import('../src/call-tones.ts');
const context = new MockAudioContext();
const tones = new CallTonePlayer(() => context);

await tones.unlock();
assert.equal(context.resumeCount, 1, 'the audio context must be unlocked by a user gesture');

tones.start('incoming');
await Promise.resolve();
assert.equal(tones.activeMode(), 'incoming');
assert.equal(context.oscillators.length, 2, 'incoming cadence starts with a two-frequency ringtone');

tones.start('outgoing');
await Promise.resolve();
assert.equal(tones.activeMode(), 'outgoing');
assert.equal(context.oscillators.length, 4, 'outgoing cadence starts with a two-frequency ringback chord');
assert.ok(context.oscillators.slice(0, 2).every(oscillator => oscillator.stopped), 'changing cadence stops the previous ringtone');

const remoteStream = { id: 'remote-audio-test' };
assert.equal(await tones.playRemoteAudio(remoteStream), true, 'remote audio must use the already-unlocked audio output');
assert.equal(context.mediaSources[0].connected, true);

tones.stop();
assert.equal(tones.activeMode(), undefined);
assert.ok(context.oscillators.every(oscillator => oscillator.stopped), 'ending a call stops every active tone');
assert.equal(context.mediaSources[0].disconnected, false, 'stopping a ring tone must not silence an active call');

tones.stopRemoteAudio();
assert.equal(context.mediaSources[0].disconnected, true, 'ending a call must disconnect remote audio output');

console.log('Call tone unit test passed: playful ringtone, ringback, unlocked remote audio and cleanup.');
