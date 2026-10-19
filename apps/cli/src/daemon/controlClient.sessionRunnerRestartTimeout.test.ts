import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  requestDaemonSessionRunnerRestart,
  requestDaemonSessionRunnerRestartV2,
  restartAllDaemonSessionRunners,
  type DaemonControlRequestOptions,
} from './controlClient';

afterEach(() => vi.unstubAllEnvs());

const restartRequest = { sessionId: 'session', mode: 'force_current_cli', reason: 'ui_stale_runner_banner' } as const;
const cases = [
  { name: 'single', path: '/session-runners/restart',
    request: (options: DaemonControlRequestOptions) => requestDaemonSessionRunnerRestart(restartRequest, options),
    result: { ok: true, status: 'restarted', sessionId: 'session' } },
  { name: 'provider recovery', path: '/session-runners/restart-v2',
    request: (options: DaemonControlRequestOptions) => requestDaemonSessionRunnerRestartV2({
      v: 2, ...restartRequest, reason: 'provider_binding_change_recovery', expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash', expectedRunnerEntrypointIdentity: 'runtime',
      expectedRunnerProcessIdentity: { pid: 123, processStartTimeMs: 1 },
    }, options), result: { ok: true, status: 'restarted', sessionId: 'session' } },
  { name: 'bulk', path: '/session-runners/restart-all',
    request: (options: DaemonControlRequestOptions) => restartAllDaemonSessionRunners({
      mode: 'if_stale', reason: 'daemon_restart_session_runners_command',
    }, options), result: { ok: true, mode: 'if_stale', requestedCount: 0, restartedCount: 0,
      skippedCount: 0, failedCount: 0, results: [] } },
] as const;

describe('restart observation follows its caller lifetime', () => {
  it.each(cases)('$name waits beyond the former HTTP budget, and honours caller cancellation and deadlines', async item => {
    // Accelerate the old configurable 75-second boundary without changing the
    // daemon lifecycle. Neither the old setting nor generic HTTP budget owns it.
    vi.stubEnv('HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS', '1000');
    vi.stubEnv('HAPPIER_DAEMON_HTTP_TIMEOUT', '100');
    let started!: () => void;
    let requestStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paths: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      paths.push(request.url!);
      release = () => response.end(JSON.stringify(item.result));
      started();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'test-control' };
    try {
      let settled = false;
      const observation = item.request({ target }).then(result => ({ result }), error => ({ error }))
        .finally(() => { settled = true; });
      await requestStarted;
      await new Promise<void>(resolve => setTimeout(resolve, 1100));
      expect(settled).toBe(false);
      release();
      await expect(observation).resolves.toEqual({ result: item.result });

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const cancellation = new AbortController();
      const cancelled = item.request({ target, signal: cancellation.signal });
      const cancelledAssertion = expect(cancelled).rejects.toThrow('caller retired');
      await requestStarted;
      cancellation.abort(new Error('caller retired'));
      await cancelledAssertion;

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const bounded = item.request({ target, timeoutMs: 100 });
      const boundedAssertion = expect(bounded).rejects.toThrow(/timeout/i);
      await requestStarted;
      await boundedAssertion;
      expect(paths).toEqual([item.path, item.path, item.path]);
    } finally {
      release?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
