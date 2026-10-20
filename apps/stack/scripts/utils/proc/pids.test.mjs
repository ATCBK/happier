import test from 'node:test';
import assert from 'node:assert/strict';

import { observePidLiveness } from './pids.mjs';

test('observePidLiveness distinguishes absent, present, and inconclusive signal probes', () => {
  const platform = 'darwin'; // The signal boundary is independent of Linux procfs observation.
  assert.deepEqual(observePidLiveness(42, { platform, killImpl: () => {} }), {
    status: 'alive',
    reason: 'signal_probe',
  });
  assert.deepEqual(observePidLiveness(42, {
    platform,
    killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  }), {
    status: 'dead',
    reason: 'not_found',
  });
  assert.deepEqual(observePidLiveness(42, {
    platform,
    killImpl: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
  }), {
    status: 'alive',
    reason: 'permission_denied_but_present',
  });

  const inconclusive = observePidLiveness(42, {
    platform,
    killImpl: () => { throw Object.assign(new Error('unknown'), { code: 'EIO' }); },
  });
  assert.equal(inconclusive.status, 'inconclusive');
  assert.equal(inconclusive.reason, 'EIO');
});

test('Stack PID ownership rejects PID1 independently of OS process presence', () => {
  assert.deepEqual(observePidLiveness(1, { platform: 'darwin', killImpl: () => {} }),
    { status: 'dead', reason: 'invalid_pid' });
});
