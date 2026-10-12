import assert from 'node:assert/strict';

globalThis.window = globalThis;
window.requestAnimationFrame = () => 1;
window.cancelAnimationFrame = () => {};

class MockTrack {
  stopped = false;
  stop() { this.stopped = true; }
}

const microphoneTrack = new MockTrack();
const microphoneStream = {
  getTracks() { return [microphoneTrack]; },
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { async getUserMedia(constraints) {
    assert.equal(constraints.audio.echoCancellation, true);
    return microphoneStream;
  } } },
});

class MockParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class MockAudioContext {
  static contexts = [];
  currentTime = 1;
  destination = {};
  closed = false;
  constructor() { MockAudioContext.contexts.push(this); }
  async resume() {}
  createGain() { return { gain: new MockParam(), connect() {} }; }
  createOscillator() {
    return { type: 'sine', frequency: new MockParam(), connect() {}, start() {}, stop() {} };
  }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 16,
      getByteTimeDomainData(samples) { samples.fill(150); },
    };
  }
  async close() { this.closed = true; }
}

globalThis.AudioContext = MockAudioContext;
const { testMicrophone, testSpeakers } = await import('../src/audio-diagnostics.ts');

await testSpeakers();
assert.equal(MockAudioContext.contexts[0].closed, true, 'speaker test must release its audio context');

const levels = [];
const peak = await testMicrophone(level => levels.push(level), undefined, 1);
assert.ok(peak > 0.02, 'microphone test must detect a non-silent signal');
assert.ok(levels.some(level => level > 0), 'microphone test must expose a live level');
assert.equal(levels.at(-1), 0, 'microphone meter must reset after the test');
assert.equal(microphoneTrack.stopped, true, 'microphone test must release the Windows microphone');
assert.equal(MockAudioContext.contexts[1].closed, true, 'microphone test must release its audio context');

console.log('Audio diagnostics test passed: speaker playback, microphone meter and device cleanup.');
