import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRestartCompletionWaiters } from './completionWaiters';

describe('createRestartCompletionWaiters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets later requests join the in-flight completion of the same runner', async () => {
    const waiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
    expect(waiters.join('sess-1', 42)).toBeNull();

    const waiter = waiters.create('sess-1', 42);
    const joined = waiters.join('sess-1', 42);
    expect(waiters.join('sess-1', 43)).toBeNull();

    waiters.settle('sess-1', 42, { ok: true });

    await expect(waiter.promise).resolves.toEqual({ ok: true });
    await expect(joined).resolves.toEqual({ ok: true });
    expect(waiters.join('sess-1', 42)).toBeNull();
  });

  it('settles a restart that never completes as a timed-out partial failure', async () => {
    vi.useFakeTimers();
    const waiters = createRestartCompletionWaiters({ timeoutMs: 1_000 });
    const waiter = waiters.create('sess-1', 42);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiter.promise).resolves.toEqual({
      ok: false,
      status: 'partial_failure',
      diagnostics: { respawnTerminalReason: 'timeout', timeoutMs: 1_000 },
    });
    expect(waiters.join('sess-1', 42)).toBeNull();
  });

  it('resolves joiners with the cancellation when the creator never signals', async () => {
    const waiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
    const waiter = waiters.create('sess-1', 42);
    const joined = waiters.join('sess-1', 42);

    waiter.cancel();

    const cancelled = {
      ok: false,
      status: 'partial_failure',
      diagnostics: { respawnTerminalReason: 'cancelled_before_signal' },
    };
    await expect(waiter.promise).resolves.toEqual(cancelled);
    await expect(joined).resolves.toEqual(cancelled);
    expect(waiters.join('sess-1', 42)).toBeNull();
  });
});
