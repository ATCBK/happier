import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { writeDaemonState } from '@/persistence';
import { registerMachineRpcHandlers } from './rpcHandlers';

const request = { sessionId: 'session', mode: 'force_current_cli', reason: 'ui_stale_runner_banner' } as const;
const cases = [
  { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, path: '/session-runners/restart', input: request },
  { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, path: '/session-runners/restart-v2', input: {
    ...request, v: 2, reason: 'provider_binding_change_recovery', expectedRunnerPid: 123,
    expectedProcessCommandHash: 'hash', expectedRunnerEntrypointIdentity: 'runtime',
    expectedRunnerProcessIdentity: { pid: 123, processStartTimeMs: 1 },
  } },
  { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, path: '/session-runners/restart-all', input: {
    mode: 'if_stale', reason: 'daemon_restart_session_runners_command',
  } },
] as const;

describe('registered Machine restart observation lifetime', () => {
  it.each(cases)('$method aborts its real control HTTP observation when its RPC caller retires', async item => {
    await withConfiguredDaemonTestHome({ prefix: 'restart-rpc-lifetime-' }, async () => {
      let started!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      let path: string | undefined;
      const server = createServer((request, response) => {
        path = request.url; request.resume();
        release = () => response.end(JSON.stringify({ ok: true, status: 'restarted', sessionId: 'session' }));
        started();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
      writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'test-control',
        startedAt: Date.now(), startedWithCliVersion: 'test' });
      const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
      const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
        stopSession: async () => true, requestShutdown: () => {},
      } });
      const cancellation = new AbortController();
      try {
        const observation = manager.invokeLocal(item.method, item.input, { signal: cancellation.signal })
          .then(result => ({ result }), error => ({ error: error instanceof Error ? error.message : String(error) }));
        await requestStarted;
        expect(path).toBe(item.path);
        cancellation.abort(new Error('RPC caller retired'));
        const outcome = await Promise.race([
          observation,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 150)),
        ]);
        // Release only after observing cancellation: successful daemon work may
        // still finish after its caller leaves, but must not hold this observer.
        release();
        await observation;
        expect(outcome).toEqual({ error: expect.stringContaining('RPC caller retired') });
      } finally {
        release?.(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await registration.dispose();
      }
    });
  });
});
