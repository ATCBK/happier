import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentExecutionRunEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { createWorkflowRunStorageClient, WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { logger } from '@/ui/logger';
import { createNativeAgentExecutionRunHostRuntime } from '../nativeAgentExecutionRun';
import { createExecutionRunControllerMessageHandler } from '../messages/sessionStateEmission';
import type { ExecutionRunState } from '../executionRunTypes';
import { sendBackendLongLivedRun } from './backendLongLivedPrompt';

afterEach(() => vi.restoreAllMocks());

it.each([
  { basePath: '', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, status: 409, code: 'currentness_conflict' },
  { basePath: '/wrong-workflow-owner', path: `/wrong-workflow-owner${WORKFLOW_RUN_STORAGE_HTTP_PATH}`, status: 404, code: 'route_not_found' },
])('attributes host publication HTTP $status after external native admission ($path)', async vector => {
  const warn = vi.spyOn(logger, 'warnLocalFile');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(request.url === WORKFLOW_RUN_STORAGE_HTTP_PATH ? 409 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: request.url === WORKFLOW_RUN_STORAGE_HTTP_PATH ? 'currentness_conflict' : 'route_not_found',
      message: 'private-response' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const storage = createWorkflowRunStorageClient({ token: 'private-token', machineId: 'machine', serverHttpBaseUrl: `${origin}${vector.basePath}`,
    createPublisherHeader: async () => 'private-publisher-proof' });
  let emit: ((event: AgentExecutionRunEvent) => void) | undefined;
  let nativeAdmissions = 0;
  const runtime = createNativeAgentExecutionRunHostRuntime({
    runtime: { executionRuns: { async open(request) {
      const complete = () => {
        nativeAdmissions++;
        emit?.({ kind: 'checkpoint', runId: 'publication-run', sequence: 1, emittedAtMs: 1, checkpointId: 'native-checkpoint' });
        emit?.({ kind: 'run-complete', runId: 'publication-run', sequence: 2, emittedAtMs: 2 });
      };
      return {
        async send() {
          complete();
          return { status: 'admitted' };
        },
        async stop() { return { status: 'notRunning' }; },
        watch(listener) {
          emit = listener;
          if (request.kind === 'create') queueMicrotask(complete);
          return { dispose() { emit = undefined; } };
        },
        async dispose() {},
      };
    } } },
    lease: { pluginId: 'acme.http-agent', pluginVersion: '1.0.0', agentId: 'acme.http-agent/default',
      localAgentId: 'default', occurrenceId: 'publication', isCurrent: () => true },
    options: { cwd: '/repo', runId: 'publication-run', scope: 'detached', backendId: 'acme.http-agent/default',
      permissionMode: 'read_only', start: { intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable' } },
    supportsResume: true,
  });
  const run: ExecutionRunState = { runId: 'publication-run', callId: 'call', sidechainId: 'side', sessionId: null,
    depth: 0, intent: 'agent', backendId: 'acme.http-agent/default',
    backendTarget: { kind: 'builtInAgent', agentId: 'acme.http-agent/default' },
    instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
    ioMode: 'request_response', status: 'running', startedAtMs: 1 };
  const runs = new Map([[run.runId, run]]);
  const sink = { commit: async () => {
    await storage.execute({ operation: 'invocations.fact', runId: 'workflow-run', invocationId: 'invocation',
      contentEnvelope: 'private-envelope' });
  } };
  const controller: ExecutionRunBackendController = {
    kind: 'backend', controllerOccurrenceId: 'publication', backend: runtime, backendSupportsResume: true,
    runtimeId: 'publication-run', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
    cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
    admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
    pendingHostBarrier: Promise.resolve(), terminalPromise: Promise.resolve(), resolveTerminal: () => {},
    workflowObservation: { localInputId: 'workflow-input', sink, usage: createExactTurnUsageAccumulator() },
  };
  const controllers = new Map([[run.runId, controller]]);
  const unsubscribe = runtime.subscribeMessages(createExecutionRunControllerMessageHandler({ ctrl: controller,
    runId: run.runId, sidechainId: run.sidechainId, ioMode: run.ioMode, computeSidechainStreamText: () => null,
    sendAcp: async () => {}, parentProvider: 'codex', runs, backendSupportsResume: true,
    writeActivityMarker: async () => {}, getNowMs: () => 3 }));
  const finish = vi.fn(async (_id: string, next: Parameters<Parameters<typeof sendBackendLongLivedRun>[0]['finishRun']>[1]) => {
    runs.set(run.runId, { ...runs.get(run.runId)!, ...next });
  });
  try {
    await runtime.provisionRuntime();
    const admission = await sendBackendLongLivedRun({ runId: run.runId, params: { message: 'private-prompt', localInputId: 'workflow-input' },
      runs, controllers, budgetRegistry: null, createRuntime: () => runtime, maxTurns: null, getNowMs: () => 3,
      finishRun: finish, sendAcp: async () => {}, parentProvider: 'codex', streamedTranscriptSession: null,
      writeActivityMarker: async () => {} });
    await vi.waitFor(() => expect(finish, JSON.stringify({ admission, nativeAdmissions, requests })).toHaveBeenCalled());
    expect(nativeAdmissions).toBe(1);
    expect(requests).toEqual([vector.path]);
    const publicError = ExecutionRunErrorSchema.parse(runs.get(run.runId)?.error);
    expect(publicError).toMatchObject({ code: 'ERR_BAD_REQUEST' });
    const records = warn.mock.calls.filter(([message]) => message === '[EXECUTION RUN] HTTP request failed');
    expect(records).toEqual([['[EXECUTION RUN] HTTP request failed', {
      runId: run.runId, method: 'POST', origin, path: vector.path, status: vector.status, domainCode: vector.code,
    }]]);
    const serialized = JSON.stringify({ records, publicError });
    for (const secret of ['private-token', 'private-publisher-proof', 'private-envelope', 'private-body', 'private-prompt', 'private-response']) {
      expect(serialized).not.toContain(secret);
    }
  } finally {
    unsubscribe();
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
