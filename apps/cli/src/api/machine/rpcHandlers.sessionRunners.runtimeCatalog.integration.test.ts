import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveSessionRunnerRuntimeState } from '@/daemon/sessionRunnerRuntime/resolveRuntimeState';
import { resolveSessionRunnerRuntimeStatusV2 } from '@/daemon/sessionRunnerRuntime/resolveRuntimeStatusV2';

import { registerMachineRpcHandlers } from './rpcHandlers';
import type { MachineRpcHandlerDeps } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

const { requestDaemonSessionRunnerRestartMock, requestDaemonSessionRunnerRestartV2Mock, restartAllDaemonSessionRunnersMock } = vi.hoisted(() => ({
  requestDaemonSessionRunnerRestartMock: vi.fn(),
  requestDaemonSessionRunnerRestartV2Mock: vi.fn(),
  restartAllDaemonSessionRunnersMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    requestDaemonSessionRunnerRestart: requestDaemonSessionRunnerRestartMock,
    requestDaemonSessionRunnerRestartV2: requestDaemonSessionRunnerRestartV2Mock,
    restartAllDaemonSessionRunners: restartAllDaemonSessionRunnersMock,
  };
});

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

function registerHandlers(sessionRunnerStatus?: MachineRpcHandlerDeps['sessionRunnerStatus']): Map<string, Handler> {
  const mgr = createRpcHandlerManager();
  registerMachineRpcHandlers({
    rpcHandlerManager: mgr as any,
    handlers: {
      spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
      stopSession: async () => true,
      requestShutdown: () => {},
    },
    ...(sessionRunnerStatus ? { deps: { sessionRunnerStatus } } : {}),
  });
  return mgr.handlers;
}

describe('rpcHandlers (session runner restarts)', () => {
  beforeEach(() => {
    requestDaemonSessionRunnerRestartMock.mockReset();
    requestDaemonSessionRunnerRestartV2Mock.mockReset();
    restartAllDaemonSessionRunnersMock.mockReset();
  });

  it('resolves both status RPC versions at the in-process daemon owner', async () => {
    const resolveStatus = ({ sessionId }: { sessionId: string }) => resolveSessionRunnerRuntimeState({
      sessionId,
      tracked: null,
      currentIdentity: { status: 'unknown', source: 'unknown', reason: 'empty_command' },
      observedAtMs: 100,
    });
    const handlers = registerHandlers({
      get: async (request) => resolveStatus(request),
      getV2: async (request) => resolveSessionRunnerRuntimeStatusV2({
        state: resolveStatus(request),
        tracked: null,
      }),
    });

    const status = await handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET)!({ sessionId: ' sess-1 ' });
    const statusV2 = await handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET)!({ sessionId: ' sess-1 ' });
    expect(status).toMatchObject({ v: 1, sessionId: 'sess-1', observedAtMs: 100 });
    expect(statusV2).toMatchObject({ v: 2, state: status, runnerProcessIdentity: null });
  });

  it('validates and forwards single session-runner restart RPC requests', async () => {
    requestDaemonSessionRunnerRestartMock.mockResolvedValueOnce({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: ' sess-1 ',
      mode: 'force_current_cli',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toEqual({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess-1',
    });

    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    }, { signal: undefined });
  });

  it('fails closed for public V1 mutation requests without a process-birth witness', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
    })).resolves.toEqual({
      ok: false,
      status: 'ineligible',
      sessionId: 'sess-1',
      reasonCode: 'runner_generation_unattested',
    });
    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('preserves ordinary public V1 explicit restart compatibility', async () => {
    requestDaemonSessionRunnerRestartMock.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);

    await expect(handler!({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toMatchObject({ status: 'restarted' });
    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    }, { signal: undefined });
  });

  it('validates and forwards process-attested Provider recovery only on restart V2', async () => {
    requestDaemonSessionRunnerRestartV2Mock.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2);
    expect(handler).toBeDefined();
    const request = {
      v: 2,
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'provider_binding_change_recovery',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-1',
      expectedRunnerEntrypointIdentity: 'runtime-1',
      expectedRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    } as const;

    await expect(handler!(request)).resolves.toMatchObject({ status: 'restarted' });
    expect(requestDaemonSessionRunnerRestartV2Mock).toHaveBeenCalledWith(request, { signal: undefined });
    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('rejects malformed single restart RPC requests before calling the daemon client', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: '',
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow();

    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('validates and forwards bulk session-runner restart RPC requests', async () => {
    restartAllDaemonSessionRunnersMock.mockResolvedValueOnce({
      ok: true,
      mode: 'if_stale',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);
    expect(handler).toBeDefined();

    await expect(handler!({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toEqual({
      ok: true,
      mode: 'if_stale',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });

    expect(restartAllDaemonSessionRunnersMock).toHaveBeenCalledWith({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    }, { signal: undefined });
  });

  it('fails a public bulk rollout restart closed because it has no per-session pending owner', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);

    await expect(handler!({
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
    })).resolves.toEqual({
      ok: false,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });
    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
  });

  it('rejects malformed bulk restart RPC requests before calling the daemon client', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);
    expect(handler).toBeDefined();

    await expect(handler!({
      mode: 'sometimes',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow();

    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
  });
});
