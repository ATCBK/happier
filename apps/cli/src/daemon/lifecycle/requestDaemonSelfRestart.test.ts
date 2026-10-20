import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonLocallyPersistedState } from '@/persistence';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { requestDaemonSelfRestart, waitForReplacementDaemon } from './requestDaemonSelfRestart';
import { requestDaemonSelfRestartWithLockHandoff } from './requestDaemonSelfRestartWithLockHandoff';

function makeState(overrides: Partial<DaemonLocallyPersistedState> = {}): DaemonLocallyPersistedState {
  return {
    pid: process.pid + 100,
    httpPort: 5001,
    startedAt: Date.now(),
    startedWithCliVersion: '2.0.0',
    controlToken: 'control-token',
    ...overrides,
  };
}

describe('requestDaemonSelfRestart', () => {
  it.each(['version', 'runtime'] as const)('resumes the incumbent after a live successor publishes an incompatible %s', async (mismatch) => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    await once(child, 'spawn');
    if (!child.pid) throw new Error('Missing successor PID');
    const successorPid = child.pid;
    const events: string[] = [];
    let currentLock: string | null = 'incumbent-lock';
    let result: Awaited<ReturnType<typeof requestDaemonSelfRestartWithLockHandoff>> | undefined;
    const exitProcess = vi.fn();
    vi.useFakeTimers();
    const restarting = requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => { currentLock = lock; },
      quiesceBeforeLockRelease: async () => {
        events.push('quiesce');
        return { resume: () => { events.push(`resume:${currentLock}`); } };
      },
      releaseDaemonLock: async () => { events.push('release'); },
      acquireDaemonLock: async () => {
        events.push('reacquire');
        return 'reacquired-lock';
      },
      requestShutdown: () => { throw new Error('Incumbent must remain available'); },
      selfRestartParams: {
        ownPid: process.pid, expectedCliVersion: '2.0.0', runtimeId: 'runtime-1',
        timeoutMs: 5, pollMs: 1,
        spawnDetachedDaemonStartSyncImpl: async () => Object.assign(child, { detachedDaemonPid: successorPid }),
        readDaemonStateImpl: async () => makeState({
          pid: successorPid,
          startedWithCliVersion: mismatch === 'version' ? '1.0.0' : '2.0.0',
          runtimeId: mismatch === 'runtime' ? 'runtime-other' : 'runtime-1',
        }),
        exitProcess,
        env: {},
      },
    }).then((settled) => { result = settled; });
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(result).toEqual({ status: 'replacement_not_confirmed' });
      expect(currentLock).toBe('reacquired-lock');
      expect(events).toEqual(['quiesce', 'release', 'reacquire', 'resume:reacquired-lock']);
      expect(exitProcess).not.toHaveBeenCalled();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      await vi.advanceTimersByTimeAsync(25);
      await restarting;
      vi.useRealTimers();
    }
  });

  it('confirms replacement daemon pings with close-socket control headers', async () => {
    const observedHeaders: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      observedHeaders.push(init?.headers);
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true }),
      } as Response;
    });

    try {
      await expect(waitForReplacementDaemon({
        ownPid: process.pid + 10_000,
        expectedCliVersion: '2.0.0',
        timeoutMs: 25,
        pollMs: 1,
        readDaemonStateImpl: vi.fn(async () => makeState({
          pid: process.pid,
          httpPort: 5001,
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-1',
          controlToken: 'control-token',
        })),
      })).resolves.toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((observedHeaders[0] as Record<string, string>).Connection).toBe('close');
      expect((observedHeaders[0] as Record<string, string>)['x-happier-daemon-token']).toBe('control-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('spawns a takeover replacement with the inherited runtime id and exits only after confirmation', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-1' }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();
    const onReplacementConfirmed = vi.fn(async () => {});

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      onReplacementConfirmed,
      env: { KEEP_ME: '1' },
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        KEEP_ME: '1',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-1',
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
    }));
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(onReplacementConfirmed).toHaveBeenCalledTimes(1);
    expect(onReplacementConfirmed.mock.invocationCallOrder[0]).toBeLessThan(
      exitProcess.mock.invocationCallOrder[0]!,
    );
    expect(result.status).toBe('exited');
  });

  it('counts successor spawn against the same restart confirmation deadline', async () => {
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-1' }));
    const exitProcess = vi.fn();
    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1', expectedCliVersion: '2.0.0',
      ownPid: process.pid, timeoutMs: 30_000, pollMs: 1,
      deadlineAtMs: Date.now() - 1,
      spawnDetachedDaemonStartSyncImpl: vi.fn(async () => ({ unref: vi.fn() })),
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: vi.fn(async () => true),
      exitProcess,
      env: {},
    });
    expect(result.status).toBe('replacement_not_confirmed');
    expect(readDaemonState).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('keeps the current daemon alive when the replacement is not confirmed', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ pid: process.pid, startedWithCliVersion: '1.0.0' }));
    const exitProcess = vi.fn();

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      exitProcess,
      env: {},
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('requires authenticated ping details before confirming a runtime-id replacement', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      pid: process.pid + 100,
      startedWithCliVersion: '2.0.0',
      runtimeId: 'runtime-1',
      controlToken: undefined,
    }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    expect(confirmReplacementState).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });
});
