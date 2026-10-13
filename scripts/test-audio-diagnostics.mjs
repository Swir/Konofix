import assert from 'node:assert/strict';

globalThis.window = globalThis;
window.requestAnimationFrame = () => 1;
window.cancelAnimationFrame = () => {};

class MockTrack extends EventTarget {
  constructor() { super(); }
  stopped = false;
  readyState = 'live';
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

const microphoneTrack = new MockTrack();
const microphoneStream = {
  getTracks() { return [microphoneTrack]; },
  getAudioTracks() { return [microphoneTrack]; },
};

let getUserMediaImpl = async constraints => {
  assert.equal(constraints.audio.echoCancellation, true);
  return microphoneStream;
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: constraints => getUserMediaImpl(constraints) } },
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
const { captureMicrophone, releaseMicrophoneStream } = await import('../src/microphone-capture.ts');

await testSpeakers();
assert.equal(MockAudioContext.contexts[0].closed, true, 'speaker test must release its audio context');

const levels = [];
const peak = await testMicrophone(level => levels.push(level), undefined, 1);
assert.ok(peak > 0.02, 'microphone test must detect a non-silent signal');
assert.ok(levels.some(level => level > 0), 'microphone test must expose a live level');
assert.equal(levels.at(-1), 0, 'microphone meter must reset after the test');
assert.equal(microphoneTrack.stopped, true, 'microphone test must release the Windows microphone');
assert.equal(MockAudioContext.contexts[1].closed, true, 'microphone test must release its audio context');

let transientCalls = 0;
const recoveredTrack = new MockTrack();
const recoveredStream = { getTracks: () => [recoveredTrack], getAudioTracks: () => [recoveredTrack] };
getUserMediaImpl = async constraints => {
  transientCalls += 1;
  if (transientCalls === 1) throw new DOMException('Could not start audio source', 'NotReadableError');
  assert.deepEqual(constraints, { audio: true, video: false }, 'a transient WebView2 failure must retry with basic constraints');
  return recoveredStream;
};
await testMicrophone(() => {}, undefined, 1);
assert.equal(transientCalls, 2, 'NotReadableError must receive one bounded recovery attempt before succeeding');
assert.equal(recoveredTrack.stopped, true, 'the recovered diagnostic stream must still be released');

for (const [name, expected] of [
  ['NotAllowedError', /access is blocked/i],
  ['NotFoundError', /no microphone is available/i],
]) {
  let calls = 0;
  getUserMediaImpl = async () => {
    calls += 1;
    throw new DOMException('mock terminal capture failure', name);
  };
  await assert.rejects(testMicrophone(() => {}, undefined, 1), expected);
  assert.equal(calls, 1, `${name} must not be hidden behind transient retries`);
}

let boundedCalls = 0;
getUserMediaImpl = async () => {
  boundedCalls += 1;
  throw new DOMException('Could not start audio source', 'AbortError');
};
await assert.rejects(testMicrophone(() => {}, undefined, 1), /microphone is busy/i);
assert.equal(boundedCalls, 3, 'a transient device error must stop after two retries');

let resolveLateCapture;
const lateTrack = new MockTrack();
const lateStream = { getTracks: () => [lateTrack], getAudioTracks: () => [lateTrack] };
getUserMediaImpl = () => new Promise(resolve => { resolveLateCapture = resolve; });
const abortController = new AbortController();
const abortedTest = testMicrophone(() => {}, abortController.signal, 1);
for (let attempt = 0; attempt < 100 && !resolveLateCapture; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.ok(resolveLateCapture, 'the abort regression must reach the pending browser capture');
abortController.abort();
resolveLateCapture(lateStream);
await assert.rejects(abortedTest, error => error?.name === 'AbortError');
assert.equal(lateTrack.stopped, true, 'an aborted diagnostic must release a microphone that resolves late');

let serializedCalls = 0;
let resolveFirstCapture;
const firstTrack = new MockTrack();
const firstStream = { getTracks: () => [firstTrack], getAudioTracks: () => [firstTrack] };
const secondTrack = new MockTrack();
const secondStream = { getTracks: () => [secondTrack], getAudioTracks: () => [secondTrack] };
getUserMediaImpl = () => {
  serializedCalls += 1;
  if (serializedCalls === 1) return new Promise(resolve => { resolveFirstCapture = resolve; });
  return Promise.resolve(secondStream);
};
const firstCapture = captureMicrophone();
const secondCapture = captureMicrophone();
for (let attempt = 0; attempt < 100 && !resolveFirstCapture; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.equal(serializedCalls, 1, 'overlapping modes must not start two browser captures concurrently');
resolveFirstCapture(firstStream);
const acquiredFirst = await firstCapture;
let secondSettled = false;
void secondCapture.finally(() => { secondSettled = true; });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(serializedCalls, 1, 'the next mode must not invoke getUserMedia while the first stream is live');
assert.equal(secondSettled, false, 'the next mode must remain pending until the microphone is released');
releaseMicrophoneStream(acquiredFirst);
const acquiredSecond = await secondCapture;
assert.equal(serializedCalls, 2, 'the queued mode may capture only after the previous stream is released');
releaseMicrophoneStream(acquiredSecond);

console.log('Audio diagnostics test passed: serialized capture, bounded WebView2 retry, terminal errors, abort and cleanup.');
