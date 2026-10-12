import { describe, expect, it } from 'vitest';

import {
  resolveLogRetention,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
} from './logRetention';

describe('logRetention', () => {
  it('only caps counts when the operator explicitly supplies a valid override', () => {
    expect(resolveDaemonLogKeepCount({})).toBeUndefined();
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: 'nope' })).toBeUndefined();
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '' })).toBeUndefined();
    expect(resolveLogRetention({ settings: { logRetentionDays: null }, env: {} })).toMatchObject({ days: null, crashedSessionKeepCount: 20 });
  });

  it('accepts zero and integer env keep counts', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '2.9' })).toBe(2);
  });
});
