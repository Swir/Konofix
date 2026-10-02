import assert from 'node:assert/strict';

// Shared by the existing compiled-media/controller harness. These are
// deterministic lifecycle tests, not physical microphone or Internet evidence.
export async function testCaptureLifecycle(media) {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const stream = name => {
    const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
    return { name, track, getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const devices = pending => ({
    getUserMedia: async () => {
      assert(pending.length, 'Unexpected capture request');
      return pending.shift().promise;
    },
    enumerateDevices: async () => [],
  });
  const isCancelled = error => error instanceof media.AudioMediaError && error.code === 'capture_failed';

  // A permission grant arriving after Leave/Stop must not resurrect capture.
  {
    const request = deferred();
    const capture = new media.AudioCaptureController(devices([request]));
    const late = stream('late permission');
    const rejected = assert.rejects(capture.start(), isCancelled);
    capture.stop();
    request.resolve(late);
    await rejected;
    assert(late.track.stopped);
    assert.equal(capture.currentStream(), null);
  }

  // Out-of-order device changes are latest-request-wins without leaking tracks.
  for (const newestFirst of [false, true]) {
    const first = deferred();
    const second = deferred();
    const capture = new media.AudioCaptureController(devices([first, second]));
    const stale = stream('superseded');
    const current = stream('latest');
    const rejected = assert.rejects(capture.start(), isCancelled);
    const accepted = capture.switchInput('latest-device');
    if (newestFirst) {
      second.resolve(current);
      await accepted;
      first.resolve(stale);
      await rejected;
    } else {
      first.resolve(stale);
      await rejected;
      assert.equal(capture.currentStream(), null);
      second.resolve(current);
      await accepted;
    }
    assert(stale.track.stopped);
    assert.equal(capture.currentStream(), current);
    assert(!current.track.stopped);
    capture.stop();
    assert(current.track.stopped);
  }

  // Mute/unmute during permission/device waits must use the newest user intent.
  {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const capture = new media.AudioCaptureController(devices([first, second, third]));
    capture.setMuted(true);
    const pending = capture.start();
    const initial = stream('initial muted');
    first.resolve(initial);
    await pending;
    assert(!initial.track.enabled);
    const switching = capture.switchInput('second');
    capture.setMuted(false);
    const next = stream('unmuted while switching');
    second.resolve(next);
    await switching;
    assert(next.track.enabled);
    assert(initial.track.stopped);
    const switchingAgain = capture.switchInput('third');
    capture.setMuted(true);
    const last = stream('muted while switching');
    third.resolve(last);
    await switchingAgain;
    assert(!last.track.enabled);
    assert(next.track.stopped);
    capture.stop();
    assert(last.track.stopped);
  }

  // Failure must retain the working device; obsolete requests still lose.
  {
    const first = deferred();
    const staleRequest = deferred();
    const failedRequest = deferred();
    const emptyRequest = deferred();
    const capture = new media.AudioCaptureController(devices([first, staleRequest, failedRequest, emptyRequest]));
    const initial = stream('working');
    const pending = capture.start();
    first.resolve(initial);
    await pending;
    const stale = stream('obsolete');
    const staleRejected = assert.rejects(capture.switchInput('obsolete'), isCancelled);
    const failed = assert.rejects(capture.switchInput('busy'), error => error.code === 'device_busy');
    failedRequest.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    await failed;
    staleRequest.resolve(stale);
    await staleRejected;
    assert(stale.track.stopped);
    assert.equal(capture.currentStream(), initial);
    assert(!initial.track.stopped);
    const empty = stream('invalid source');
    empty.getAudioTracks = () => [];
    const missing = assert.rejects(capture.switchInput('empty'), error => error.code === 'device_missing');
    emptyRequest.resolve(empty);
    await missing;
    assert(empty.track.stopped);
    assert.equal(capture.currentStream(), initial);
    capture.stop();
    assert(initial.track.stopped);
  }

  // A stopped controller may start afresh; its old pending result stays revoked.
  {
    const oldRequest = deferred();
    const newRequest = deferred();
    const capture = new media.AudioCaptureController(devices([oldRequest, newRequest]));
    const oldStream = stream('previous session');
    const newStream = stream('new session');
    const oldRejected = assert.rejects(capture.start(), isCancelled);
    capture.stop();
    const newAccepted = capture.start();
    newRequest.resolve(newStream);
    await newAccepted;
    oldRequest.resolve(oldStream);
    await oldRejected;
    assert(oldStream.track.stopped);
    assert(!newStream.track.stopped);
    assert.equal(capture.currentStream(), newStream);
    capture.stop();
  }

  // Permission-only device lookup is cancellable too, before and after capture.
  for (const permissionAlreadyGranted of [false, true]) {
    const permission = deferred();
    const enumeration = deferred();
    const enumerationStarted = deferred();
    const fake = devices([permission]);
    fake.enumerateDevices = () => { enumerationStarted.resolve(); return enumeration.promise; };
    const capture = new media.AudioCaptureController(fake);
    const temporary = stream('device lookup');
    const rejected = assert.rejects(capture.listInputDevices(true), isCancelled);
    if (permissionAlreadyGranted) {
      permission.resolve(temporary);
      await enumerationStarted.promise;
      capture.stop();
      assert(temporary.track.stopped, 'Stop must release lookup capture without waiting for enumeration');
      enumeration.resolve([]);
    } else {
      capture.stop();
      permission.resolve(temporary);
    }
    await rejected;
    assert(temporary.track.stopped);
    assert.equal(capture.currentStream(), null);
  }
  console.log('Audio capture lifecycle: cancelled permission, out-of-order switches, mute intent, rollback and lookup cleanup PASS.');
}
