import type { ChildProcess } from 'node:child_process';
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

function createMachineConnection(initialOnline: boolean) {
  let online = initialOnline;
  const listeners = new Set<(online: boolean) => void>();
  return {
    observe: (listener: (online: boolean) => void) => {
      listeners.add(listener);
      listener(online);
      return () => { listeners.delete(listener); };
    },
    // The server's same-runtime ownership registry disconnects the older socket
    // when the successor's machine socket claims the machine.
    setOnline(next: boolean) {
      online = next;
      for (const listener of [...listeners]) listener(next);
    },
    get listenerCount() { return listeners.size; },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('daemon self-restart machine connection handover (composed lock handoff + restart)', () => {
  function startHandoff(params: Readonly<{
    successorPid: number;
    child: ChildProcess;
    connection: ReturnType<typeof createMachineConnection>;
    exitProcess: (code: number) => void;
    events: string[];
    lock: { current: string | null };
    confirmReplacementStateImpl?: (state: DaemonLocallyPersistedState) => Promise<boolean>;
    timeoutMs?: number;
  }>) {
    return requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => params.lock.current,
      setCurrentDaemonLockHandle: (lock) => { params.lock.current = lock; },
      quiesceBeforeLockRelease: async () => {
        params.events.push('quiesce');
        return { resume: () => { params.events.push('resume'); } };
      },
      releaseDaemonLock: async () => { params.events.push('release'); },
      acquireDaemonLock: async () => {
        params.events.push('reacquire');
        return 'reacquired-lock';
      },
      requestShutdown: () => { throw new Error('Incumbent must not shut down through the shutdown path'); },
      selfRestartParams: {
        ownPid: process.pid, expectedCliVersion: '', runtimeId: 'runtime-1',
        timeoutMs: params.timeoutMs ?? 2_000, pollMs: 5, postConfirmationOverlapMs: 0,
        spawnDetachedDaemonStartSyncImpl: async () => Object.assign(params.child, { detachedDaemonPid: params.successorPid }),
        readDaemonStateImpl: async () => makeState({ pid: params.successorPid, runtimeId: 'runtime-1' }),
        // The real confirmation pings the successor's control server; only a live process answers.
        confirmReplacementStateImpl: params.confirmReplacementStateImpl ?? (async (state) => isAlive(state.pid)),
        observeMachineConnectionOnline: params.connection.observe,
        exitProcess: (code: number) => {
          params.events.push(`exit:${code}`);
          params.exitProcess(code);
        },
        env: {},
      },
    });
  }

  it('keeps the incumbent connected after successor confirmation until the server moves the machine connection to the successor', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    await once(child, 'spawn');
    if (!child.pid) throw new Error('Missing successor PID');
    const connection = createMachineConnection(true);
    const events: string[] = [];
    const lock = { current: 'incumbent-lock' as string | null };
    const exitProcess = vi.fn();
    let confirmations = 0;
    try {
      const restarting = startHandoff({
        successorPid: child.pid, child, connection, exitProcess, events, lock,
        confirmReplacementStateImpl: async (state) => { confirmations += 1; return isAlive(state.pid); },
      });
      await waitUntil(() => confirmations > 0);
      // The successor is ready but has not claimed the machine socket: the incumbent keeps serving.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(exitProcess).not.toHaveBeenCalled();
      expect(events).toEqual(['quiesce', 'release']);

      connection.setOnline(false);
      await expect(restarting).resolves.toEqual({ status: 'exited' });
      expect(exitProcess).toHaveBeenCalledWith(0);
      // Handover does not reacquire the lock, resume the incumbent, or stop Sessions.
      expect(events).toEqual(['quiesce', 'release', 'exit:0']);
      expect(lock.current).toBeNull();
      expect(connection.listenerCount).toBe(0);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  it('exits without resuming when the confirmed successor stops before it takes the connection', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    await once(child, 'spawn');
    if (!child.pid) throw new Error('Missing successor PID');
    const connection = createMachineConnection(true);
    const events: string[] = [];
    const lock = { current: 'incumbent-lock' as string | null };
    const exitProcess = vi.fn();
    let confirmations = 0;
    const restarting = startHandoff({
      successorPid: child.pid, child, connection, exitProcess, events, lock,
      confirmReplacementStateImpl: async (state) => { confirmations += 1; return isAlive(state.pid); },
    });
    await waitUntil(() => confirmations > 0);
    expect(exitProcess).not.toHaveBeenCalled();
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await expect(restarting).resolves.toEqual({ status: 'exited' });
    expect(events).toEqual(['quiesce', 'release', 'exit:0']);
    expect(connection.listenerCount).toBe(0);
  });

  it('leaves the incumbent running and connected when the successor fails before confirmation', async () => {
    const child = spawnInlineNodeTestProcess('process.exit(3)');
    await once(child, 'exit');
    const connection = createMachineConnection(true);
    const events: string[] = [];
    const lock = { current: 'incumbent-lock' as string | null };
    const exitProcess = vi.fn();
    const result = await startHandoff({
      successorPid: child.pid ?? 999_999, child, connection, exitProcess, events, lock,
    });
    expect(result).toEqual({ status: 'replacement_not_confirmed' });
    expect(exitProcess).not.toHaveBeenCalled();
    expect(events).toEqual(['quiesce', 'release', 'reacquire', 'resume']);
    expect(lock.current).toBe('reacquired-lock');
    expect(connection.listenerCount).toBe(0);
  });

  it('exits once the restart verification budget elapses when a live successor never takes the connection', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    await once(child, 'spawn');
    if (!child.pid) throw new Error('Missing successor PID');
    const connection = createMachineConnection(true);
    const events: string[] = [];
    const lock = { current: 'incumbent-lock' as string | null };
    const exitProcess = vi.fn();
    try {
      const startedAt = Date.now();
      await expect(startHandoff({ successorPid: child.pid, child, connection, exitProcess, events, lock, timeoutMs: 150 }))
        .resolves.toEqual({ status: 'exited' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      expect(events).toEqual(['quiesce', 'release', 'exit:0']);
      expect(connection.listenerCount).toBe(0);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  it('exits after confirmation when there is no live machine connection to hand over', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    await once(child, 'spawn');
    if (!child.pid) throw new Error('Missing successor PID');
    const connection = createMachineConnection(false);
    const events: string[] = [];
    const lock = { current: 'incumbent-lock' as string | null };
    const exitProcess = vi.fn();
    try {
      await expect(startHandoff({ successorPid: child.pid, child, connection, exitProcess, events, lock }))
        .resolves.toEqual({ status: 'exited' });
      expect(events).toEqual(['quiesce', 'release', 'exit:0']);
      expect(connection.listenerCount).toBe(0);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
});

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
