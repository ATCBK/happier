import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler } from '@/api/rpc/types';
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
        await retainExecutionRunState({ ...run, runId: 'session-run', sessionId: 'hosting-session' });
        const handlers = new Map<string, RpcHandler>();
        registerExecutionRunHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
            sessionId: null, cwd: directory, machineId: 'machine', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
            executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } } },
            }) }),
            onManagerCreated: manager => { managers.push(manager); },
        });
        const get = handlers.get(SESSION_RPC_METHODS.EXECUTION_RUN_GET);
        expect(get).toBeTypeOf('function');
        const request = ExecutionRunGetRequestSchema.parse({ runId: run.runId, includeStructured: true,
            waitForInputId: 'native-input',
            waitForOutput: { kind: 'review_walkthrough', comparisonId: 'machine-comparison', resultId: 'machine-result', afterRevision: 0 } });
        const response = ExecutionRunGetResponseSchema.parse(await get!(request, {
            callerAuthority: 'present_user', signal: new AbortController().signal,
        }));
        expect(response.run).toMatchObject({ runId: run.runId, status: 'succeeded' });
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.structuredMeta?.payload)).toEqual(output);
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.latestToolResult)).toEqual(output);
        expect(await get!({ ...request, runId: 'session-run' }, {
            callerAuthority: 'present_user', signal: new AbortController().signal,
        })).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    });
});
