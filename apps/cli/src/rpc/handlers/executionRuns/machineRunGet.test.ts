import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import type { Socket } from 'socket.io-client';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';

describe('Machine Run get through the shared registered handler', () => {
    let directory: string;
    const managers: ExecutionRunHostBridge[] = [];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happier-machine-run-get-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
        reloadConfiguration();
    });
    afterEach(async () => {
        await Promise.all(managers.splice(0).map(manager => manager.dispose()));
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    });

    it('projects retained Machine output into the consumer schema and refuses a Session-owned Run', async () => {
        const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'machine-comparison',
            metadata: { sourceKey: 'machine-comparison', source: { kind: 'workingTree' } },
            comparison: { id: 'machine-comparison', source: { kind: 'workingTree' }, repository: { rootPath: directory },
                endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
            requestedOutputs: ['walkthrough'], resultId: 'machine-result', revision: 1,
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            outputs: { walkthrough: { state: 'complete', value: { title: 'Retained native output', intro: '', stops: [], otherChangeRefs: [] } } },
        });
        const run = { runId: 'machine-run', callId: 'machine-call', sidechainId: 'machine-sidechain', sessionId: null,
            depth: 0, intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
            instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
            status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: output }, latestToolResult: output,
        } satisfies ExecutionRunState;
        await retainExecutionRunState(run);
        await retainExecutionRunState({ ...run, runId: 'session-run', sessionId: 'hosting-session',
            terminalOccurrenceId: 'terminal-original' });
        await retainExecutionRunState({ ...run, runId: 'active-session-run', sessionId: 'hosting-session',
            status: 'running', finishedAtMs: undefined });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
        registerExecutionRunHandlers(rpc, {
            sessionId: null, cwd: directory, machineId: 'machine', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
            executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } } },
            }) }),
            onManagerCreated: manager => { managers.push(manager); },
        });
        const published = new Set<string>();
        // Socket.IO is the system boundary. The real daemon registration,
        // protocol packet codec, dispatch, Action executor and retained store run.
        rpc.onSocketConnect({ auth: { clientType: 'machine-scoped' },
            on() {}, emit(event: string, payload: { method: string }) {
                if (event === SOCKET_RPC_EVENTS.REGISTER) published.add(payload.method);
            },
        } as unknown as Socket);
        const socket = {
            async emitWithAck(event: string, payload: SocketRpcRequestPayload) {
                expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                if (!published.has(payload.method)) return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'RPC method not available' };
                const result = await rpc.handleRequest({ ...payload, callerAuthority: 'present_user' });
                return { ok: true, result };
            },
            emit() {}, on() {}, off() {},
            timeout() { return this; },
        };
        const invoke = (method: string, params: unknown) => callSocketRpc({ socket, target: { kind: 'machine', id: 'machine' },
            method, params, content: { mode: 'plain' } });
        const request = ExecutionRunGetRequestSchema.parse({ runId: run.runId, includeStructured: true,
            waitForInputId: 'native-input',
            waitForOutput: { kind: 'review_walkthrough', comparisonId: 'machine-comparison', resultId: 'machine-result', afterRevision: 0 } });
        const response = ExecutionRunGetResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request));
        expect(response.run).toMatchObject({ runId: run.runId, status: 'succeeded' });
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.structuredMeta?.payload)).toEqual(output);
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.latestToolResult)).toEqual(output);
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { ...request, runId: 'session-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        const frontier = await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'active-session-run' });
        expect(frontier).toEqual({ sessionId: 'hosting-session', runId: 'active-session-run', status: 'running', terminalEventId: null });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'session-run' }))
            .toEqual({ sessionId: 'hosting-session', runId: 'session-run', status: 'succeeded', terminalEventId: 'terminal-original' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'other-session', runId: 'active-session-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'machine-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: run.runId }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        // Removing the published registration must make this same front door
        // fail, even though the in-process handler remains available.
        published.delete(`machine:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
        await expect(invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request)).rejects.toMatchObject({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        rpc.onSocketDisconnect();
    });
});
