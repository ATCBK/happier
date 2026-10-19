import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { timeWebLatencyPhase, withWebLatencyTrace } from './webLatencyTrace';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('daemon web latency request correlation', () => {
  it('reports the active phase before a pending boundary settles, with the same correlation at settlement', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    const requestId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
    let settle!: () => void;
    const boundary = new Promise<void>(resolve => { settle = resolve; });
    const pending = withWebLatencyTrace(requestId, () => timeWebLatencyPhase('workspaceSync.controller.flush', () => boundary));
    try {
      expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
        phase: 'workspaceSync.controller.flush', requestId, status: 'started', spanId: 1,
      }));
    } finally { settle(); await pending; }
    expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
      phase: 'workspaceSync.controller.flush', requestId, status: 'completed', spanId: 1,
    }));
  });

  it.each([
    ['Action', '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6'],
    ['new Session attempt', 'new-session-attempt-23b2ed82-2ef7-4e4e-af0f-f64d599a08c6'],
    // Actual MCP child-spawn root from QA-R37h: the producer hashes the parent/creation-key tuple.
    ['MCP child spawn', 'ca287f82fdd83fd583f9459812b579ce6013223d4e819f4656c40d0cf9ae1ed2'],
  ])('retains the %s request identity across asynchronous execution', async (_kind, requestId) => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    // Only the file logging sink is replaced; execution and async context remain real.
    const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    const failure = new Error('execution failed');

    await expect(withWebLatencyTrace(requestId, async () => {
      await Promise.resolve();
      return await timeWebLatencyPhase('daemon.action.execute', async () => { throw failure; });
    })).rejects.toBe(failure);

    expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
      phase: 'daemon.action.execute', requestId,
    }));
  });

  it('omits arbitrary input and leaves tracing disabled unless requested', async () => {
    const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    await withWebLatencyTrace('private free-form input'.padEnd(64, 'x'), () => timeWebLatencyPhase('execute', () => 'ok'));
    expect(sink).toHaveBeenCalledWith('[web-latency]', expect.not.objectContaining({ requestId: expect.anything() }));
    sink.mockClear();
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
    expect(await withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', () => timeWebLatencyPhase('execute', () => 'ok'))).toBe('ok');
    expect(sink).not.toHaveBeenCalled();
  });

  it.each([
    '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6',
    'ca287f82fdd83fd583f9459812b579ce6013223d4e819f4656c40d0cf9ae1ed2',
  ])('preserves the current span when a boundary re-enters the same admitted root %s', async (rootId) => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    await withWebLatencyTrace(rootId, () => timeWebLatencyPhase('outer', () =>
      withWebLatencyTrace(rootId, () => timeWebLatencyPhase('inner', () => 'ok'))));
    expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
      phase: 'inner', requestId: rootId, spanId: 2, parentSpanId: 1, status: 'completed',
    }));
  });

  it('keeps diagnostic sink failures from changing boundary results', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => { throw new Error('file unavailable'); });
    await expect(withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', () =>
      timeWebLatencyPhase('boundary', () => 42))).resolves.toBe(42);
  });
});
