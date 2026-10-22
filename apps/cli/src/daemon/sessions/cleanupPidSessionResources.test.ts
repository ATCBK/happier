import { describe, expect, it, vi } from 'vitest';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { logger } from '@/ui/logger';
import { cleanupPidSessionResources, registerPidSpawnResourceCleanup, retireUpstreamAuthorityBeforeProcessStop } from './cleanupPidSessionResources';

describe('registerPidSpawnResourceCleanup', () => {
  it('identifies the failed resource rather than a later registration that only joins its cleanup', async () => {
    const boundaryError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const cleanups = new Map<number, () => void | Promise<void>>();
    registerPidSpawnResourceCleanup({
      pid: 45,
      label: 'provider_broker.binding.open',
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: async () => { throw boundaryError; },
    });
    registerPidSpawnResourceCleanup({
      pid: 45,
      label: 'mcp.plugin.prepare',
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: async () => {},
    });

    const result = cleanups.get(45)!();
    await expect(result).rejects.toMatchObject({
      message: 'Session resource cleanup failed: provider_broker.binding.open',
      cause: boundaryError,
    });
    expect(cleanups.has(45)).toBe(true);
    // File logging is a system boundary. Keep the labelled Error nested so the
    // logger's canonical structured serializer retains the original cause.
    const diagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      expect(await retireUpstreamAuthorityBeforeProcessStop({ pid: 45, spawnResourceCleanupByPid: cleanups })).toBe(false);
      expect(diagnostic).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to retire upstream authority before process stop',
        expect.objectContaining({ pid: 45, error: expect.objectContaining({
          message: 'Session resource cleanup failed: provider_broker.binding.open', cause: boundaryError,
        }) }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('retries failed retirement through PID cleanup while retaining completed stages and concurrent joining', async () => {
    const events: string[] = [];
    // A failed filesystem removal is a retryable system boundary. All cleanup
    // composition, resource custody, and retirement logic below remain real.
    let removeAttempts = 0;
    let failRemoval: (() => void) | undefined;
    const failedRemoval = new Promise<void>((_resolve, reject) => {
      failRemoval = () => reject(new Error('filesystem unavailable'));
    });
    const scope = createProviderLaunchResourceScope();
    scope.register(async () => {
      events.push('remove');
      removeAttempts += 1;
      if (removeAttempts === 1) await failedRemoval;
    });
    const cleanups = new Map<number, () => void | Promise<void>>();
    cleanups.set(44, scope.transfer()!);
    registerPidSpawnResourceCleanup({
      pid: 44,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: async () => { events.push('authority'); },
    });
    const retirement = { pid: 44, spawnResourceCleanupByPid: cleanups };
    const first = retireUpstreamAuthorityBeforeProcessStop(retirement);
    const concurrent = retireUpstreamAuthorityBeforeProcessStop(retirement);
    failRemoval!();
    expect(await Promise.all([first, concurrent])).toEqual([false, false]);
    expect(cleanups.has(44)).toBe(true);
    expect(events).toEqual(['authority', 'remove']);

    const attachCleanups = new Map<number, () => Promise<void>>([
      [44, async () => { events.push('attach'); }],
    ]);
    expect(await cleanupPidSessionResources({ ...retirement, sessionAttachCleanupByPid: attachCleanups })).toBe(true);
    expect(events).toEqual(['authority', 'remove', 'remove', 'attach']);
    expect(cleanups.has(44)).toBe(false);
    expect(attachCleanups.has(44)).toBe(false);
  });

  it('composes exact recovered Provider cleanup before existing PID resources', async () => {
    const events: string[] = [];
    const previousCleanup = vi.fn(async () => {
      events.push('previous');
    });
    const providerCleanup = vi.fn(async () => {
      events.push('provider');
    });
    const cleanups = new Map<number, () => void | Promise<void>>([
      [41, previousCleanup],
    ]);

    const release = registerPidSpawnResourceCleanup({
      pid: 41,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: providerCleanup,
    });
    const cleanup = cleanups.get(41);

    expect(release).not.toBeNull();
    expect(cleanup).not.toBe(previousCleanup);
    await Promise.all([cleanup?.(), cleanup?.()]);
    expect(events).toEqual(['provider', 'previous']);
    expect(providerCleanup).toHaveBeenCalledOnce();
    expect(previousCleanup).toHaveBeenCalledOnce();
  });

  it('restores only the exact prior PID cleanup when an unconsumed claim rolls back', () => {
    const previousCleanup = vi.fn();
    const replacementCleanup = vi.fn();
    const cleanups = new Map<number, () => void | Promise<void>>([
      [42, previousCleanup],
    ]);
    const release = registerPidSpawnResourceCleanup({
      pid: 42,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: vi.fn(),
    });

    release?.();
    expect(cleanups.get(42)).toBe(previousCleanup);

    const secondRelease = registerPidSpawnResourceCleanup({
      pid: 42,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: vi.fn(),
    });
    cleanups.set(42, replacementCleanup);
    secondRelease?.();
    expect(cleanups.get(42)).toBe(replacementCleanup);
  });

  it('publishes no cleanup when exact PID ownership changes during registration', () => {
    const previousCleanup = vi.fn();
    const cleanups = new Map<number, () => void | Promise<void>>([
      [43, previousCleanup],
    ]);
    let ownerCheck = 0;

    const release = registerPidSpawnResourceCleanup({
      pid: 43,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => {
        ownerCheck += 1;
        return ownerCheck === 1;
      },
      cleanup: vi.fn(),
    });

    expect(release).toBeNull();
    expect(cleanups.get(43)).toBe(previousCleanup);
  });
});
