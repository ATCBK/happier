import { describe, expect, it, vi } from 'vitest';

import { createVersionRuntimeRefreshAttemptHandoff } from './versionRuntimeRefreshAttemptHandoff';
import type { TrackedSession } from '../types';

function makeTracked(): TrackedSession {
  return { pid: 111, startedBy: 'daemon', happySessionId: 'sess-1' };
}

describe('createVersionRuntimeRefreshAttemptHandoff', () => {
  it('moves a one-shot transient spawn override with wrapper PID promotion and consumes it once', async () => {
    const tracked = makeTracked();
    vi.useFakeTimers();
    try {
      const transientSpawnOptions = { directory: '/repo', resume: 'vendor-1' };
      const handoff = createVersionRuntimeRefreshAttemptHandoff({
        timeoutMs: 100,
        timeoutCompletion: 'timeout',
        supersededCompletion: 'superseded',
        cancelledCompletion: 'cancelled',
      });
      const attempt = handoff.create({
        sessionId: 'sess-1',
        previousPid: 111,
        tracked,
        transientSpawnOptions,
      });

      handoff.transferPid('sess-1', 111, 222);

      expect(handoff.takeTransientSpawnOptions('sess-1', 111)).toBeUndefined();
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBe(transientSpawnOptions);
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBeUndefined();
      handoff.settle('sess-1', 222, 'success');
      await expect(attempt.promise).resolves.toBe('success');
      await vi.advanceTimersByTimeAsync(100);
      await expect(attempt.promise).resolves.toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out through the promoted PID key without retaining the transient spawn override', async () => {
    const tracked = makeTracked();
    vi.useFakeTimers();
    try {
      const handoff = createVersionRuntimeRefreshAttemptHandoff({
        timeoutMs: 100,
        timeoutCompletion: 'timeout',
        supersededCompletion: 'superseded',
        cancelledCompletion: 'cancelled',
      });
      const attempt = handoff.create({
        sessionId: 'sess-1',
        previousPid: 111,
        tracked,
        transientSpawnOptions: { directory: '/repo' },
      });

      handoff.transferPid('sess-1', 111, 222);
      await vi.advanceTimersByTimeAsync(100);

      await expect(attempt.promise).resolves.toBe('timeout');
      expect(handoff.takeTransientSpawnOptions('sess-1', 111)).toBeUndefined();
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an explicitly deadline-free attempt pending until the canonical owner settles it', async () => {
    const tracked = makeTracked();
    vi.useFakeTimers();
    try {
      const handoff = createVersionRuntimeRefreshAttemptHandoff({
        timeoutMs: 100,
        timeoutCompletion: 'timeout',
        supersededCompletion: 'superseded',
        cancelledCompletion: 'cancelled',
      });
      const attempt = handoff.create({
        sessionId: 'sess-1',
        previousPid: 111,
        tracked,
        timeoutMs: null,
      });
      let settled = false;
      void attempt.promise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);

      handoff.settle('sess-1', 111, 'success');
      await expect(attempt.promise).resolves.toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins only an equivalent finite target and follows its promoted PID through completion', async () => {
    const tracked = makeTracked();
    const handoff = createVersionRuntimeRefreshAttemptHandoff({
      timeoutMs: 60_000, timeoutCompletion: 'timeout', supersededCompletion: 'superseded', cancelledCompletion: 'cancelled',
    });
    const transientSpawnOptions = { directory: '/repo', resume: 'vendor-1', providerBindingSecurityChangeConfirmationV1: {
      v: 1 as const, sessionId: 'sess-1', connectionId: 'connection-1',
      previousBindingSecurityFingerprint: 'binding-old', nextBindingSecurityFingerprint: 'binding-new',
    } };
    const target = { sessionId: 'sess-1', previousPid: 111, tracked, transientSpawnOptions };
    const attempt = handoff.create(target);
    expect(handoff.join({ ...target, transientSpawnOptions: {
      ...transientSpawnOptions, providerBindingSecurityChangeConfirmationV1: {
        ...transientSpawnOptions.providerBindingSecurityChangeConfirmationV1, nextBindingSecurityFingerprint: 'binding-other',
      },
    } })).toBeNull();
    const joined = handoff.join({ ...target, transientSpawnOptions: structuredClone(transientSpawnOptions) });
    expect(joined).not.toBeNull();
    handoff.transferPid('sess-1', 111, 222);
    expect(handoff.join(target)).toBeNull();
    expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toEqual(transientSpawnOptions);
    expect(handoff.join({ ...target, previousPid: 222 })).toBe(joined);
    handoff.settle('sess-1', 222, 'success');
    await expect(attempt.promise).resolves.toBe('success');
    await expect(joined).resolves.toBe('success');
    expect(handoff.join({ ...target, previousPid: 222 })).toBeNull();
  });

  it('keeps deadline-free source cutover equivalence with its existing pending-attempt owner', async () => {
    const tracked = makeTracked();
    const handoff = createVersionRuntimeRefreshAttemptHandoff({
      timeoutMs: 60_000, timeoutCompletion: 'timeout', supersededCompletion: 'superseded', cancelledCompletion: 'cancelled',
    });
    const target = { sessionId: 'sess-1', previousPid: 111, tracked, timeoutMs: null };
    const attempt = handoff.create(target);
    expect(handoff.join(target)).toBeNull();
    expect(handoff.join({ sessionId: 'sess-1', previousPid: 111, tracked })).toBeNull();
    handoff.settle('sess-1', 111, 'success');
    await expect(attempt.promise).resolves.toBe('success');
  });


  it('does not join a replacement tracked runner that reuses the same PID and spawn target', async () => {
    const tracked = makeTracked();
    const handoff = createVersionRuntimeRefreshAttemptHandoff({
      timeoutMs: 60_000, timeoutCompletion: 'timeout', supersededCompletion: 'superseded', cancelledCompletion: 'cancelled',
    });
    const target = { sessionId: 'sess-1', previousPid: 111, tracked };
    const attempt = handoff.create(target);
    try {
      expect(handoff.join({ ...target, tracked: { ...tracked } })).toBeNull();
    } finally {
      handoff.settle('sess-1', 111, 'success');
      await expect(attempt.promise).resolves.toBe('success');
    }
  });

});
