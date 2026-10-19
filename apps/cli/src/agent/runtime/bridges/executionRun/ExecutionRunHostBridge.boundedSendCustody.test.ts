import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController, ExecutionRunLiveIntervention } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { settleExecutionRunController } from './settleExecutionRunController';
import { createTestExecutionRunHostRuntime } from './testkit/runtime';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function createBoundedSendHarness() {
  const { runtime } = createTestExecutionRunHostRuntime({
    steerInput: async () => ({ status: 'admitted' }),
  });
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const runId = 'run-bounded-send-custody';
  const run: ExecutionRunState = {
    runId,
    callId: 'call-bounded-send-custody',
    sidechainId: 'side-bounded-send-custody',
    sessionId: null,
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: 'Keep working.',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  };
  const controller: ExecutionRunBackendController = {
    kind: 'backend',
    controllerOccurrenceId: 'controller-bounded-send-custody',
    backend: runtime,
    backendSupportsResume: false,
    runtimeId: 'child-bounded-send-custody',
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: null,
    cancelled: false,
    turnCount: 1,
    turnEpoch: 1,
    turnInFlight: true,
    turnCancelReason: null,
    turnCancelEpoch: null,
    admittedLiveInterventions: [],
    admittedLiveInterventionsSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalPromise,
    resolveTerminal,
  };
  const bridge = new ExecutionRunHostBridge({
    parentProvider: 'codex',
    cwd: process.cwd(),
    sendAcp: async () => {},
    getNowMs: () => 2,
  });
  const bridgeState = bridge as unknown as {
    runs: Map<string, ExecutionRunState>;
    controllers: Map<string, ExecutionRunBackendController>;
  };
  bridgeState.runs.set(runId, run);
  bridgeState.controllers.set(runId, controller);
  return { bridge, controller, runId };
}

describe('ExecutionRunHostBridge bounded send custody', () => {
  it('keeps the sender attached after the runner adopts a slow provider steer', async () => {
    const { bridge, controller, runId } = createBoundedSendHarness();
    vi.useFakeTimers();

    let settled = false;
    const attribution = materializeActionRequestAttributionV1({ requestRef: 'steer-request',
      requester: { serverId: 'home', accountId: 'carol' }, persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null });
    const send = bridge.send(runId, {
      message: 'Use the updated direction.',
      delivery: 'steer_if_supported',
      actionRequestAttributionV1: attribution,
    });
    void send.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(controller.admittedLiveInterventions).toHaveLength(1));
    const adopted = controller.admittedLiveInterventions.shift();
    expect(adopted).toBeDefined();
    expect(adopted?.actionRequestAttributionV1).toEqual(attribution);

    vi.advanceTimersByTime(120_001);
    await Promise.resolve();
    expect(settled).toBe(false);

    adopted!.resolve();
    await expect(send).resolves.toEqual({ ok: true });
  });

  it('keeps an admitted intervention available until caller cancellation', async () => {
    const { bridge, controller, runId } = createBoundedSendHarness();
    vi.useFakeTimers();
    const cancellation = new AbortController();

    const send = bridge.send(runId, {
      message: 'No consumer adopts this.',
      delivery: 'steer_if_supported',
      signal: cancellation.signal,
    });
    await vi.waitFor(() => expect(controller.admittedLiveInterventions).toHaveLength(1));

    vi.advanceTimersByTime(120_001);
    await Promise.resolve();
    expect(controller.admittedLiveInterventions).toHaveLength(1);

    cancellation.abort();
    await Promise.resolve();
    await expect(send).resolves.toMatchObject({
      ok: false,
      errorCode: 'cancelled',
    });
    expect(controller.admittedLiveInterventions).toHaveLength(0);
  });

  it('settles an adopted sender when its controller retires', async () => {
    const { bridge, controller, runId } = createBoundedSendHarness();
    vi.useFakeTimers();
    let settled = false;
    const send = bridge.send(runId, {
      message: 'Adopt this steer.',
      delivery: 'steer_if_supported',
    });
    void send.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(controller.admittedLiveInterventions).toHaveLength(1));
    const adopted = controller.admittedLiveInterventions.shift();
    expect(adopted).toBeDefined();
    (controller as ExecutionRunBackendController & {
      activeLiveIntervention?: ExecutionRunLiveIntervention;
    }).activeLiveIntervention = adopted;

    try {
      await settleExecutionRunController({
        runId,
        controller,
        controllers: new Map([[runId, controller]]),
      });
      await Promise.resolve();
      expect(settled).toBe(true);
      await expect(send).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_not_allowed',
      });
    } finally {
      adopted!.reject(new Error('test cleanup'));
      await send;
    }
  });

  it('does not enqueue another provider effect while outcome custody is unknown', async () => {
    const { bridge, controller, runId } = createBoundedSendHarness();
    controller.turnCancelReason = 'outcome_unknown';
    controller.turnCancelEpoch = controller.turnEpoch;
    vi.useFakeTimers();
    let result: Awaited<ReturnType<ExecutionRunHostBridge['send']>> | null = null;
    const send = bridge.send(runId, {
      message: 'Must not redrive.',
      delivery: 'steer_if_supported',
    }).then((value) => {
      result = value;
      return value;
    });

    try {
      await vi.waitFor(() => expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_busy' }));
      expect(controller.admittedLiveInterventions).toHaveLength(0);
    } finally {
      vi.advanceTimersByTime(120_001);
      await Promise.resolve();
      await send;
    }
  });
});
