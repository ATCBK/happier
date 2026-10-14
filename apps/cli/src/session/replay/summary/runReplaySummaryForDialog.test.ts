import { describe, expect, it } from 'vitest';
import { LlmTaskRunnerConfigV1Schema } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ExecutionRunStartRequestSchema, type ExecutionRunStartRequest } from '@happier-dev/protocol/execution/runs/startRequest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { runReplaySummaryForDialog } from './runReplaySummaryForDialog';

describe('Replay summary settings to Run Action', () => {
    it.each([
        { target: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'default' },
        { target: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, modelId: 'custom/model' },
    ])('runs predecessor $target.kind selection through the real start-and-wait Action with canonical model identity', async ({ target, modelId }) => {
        const runner = LlmTaskRunnerConfigV1Schema.parse({ v: 1, backendTarget: target, modelId, permissionMode: 'no_tools' });
        const requests: ExecutionRunStartRequest[] = [];
        // The answering Run host is the external process boundary. Schema, Action admission,
        // text-prompt orchestration and Replay prompt construction all remain real.
        const executor = createActionExecutor({
            executionRunCheckProtocolV2: async () => ({ ok: true }),
            executionRunStart: async (sessionId, input) => {
                expect(sessionId).toBe('sess_parent');
                requests.push(ExecutionRunStartRequestSchema.parse(input));
                return { runId: 'summary-run', callId: 'summary-call', sidechainId: 'summary-call' };
            },
            executionRunWait: async () => ({ ok: true, status: 'succeeded', result: { latestToolResult: ' SUMMARY_OK ' } }),
        } as unknown as ActionExecutorDeps); // Unrelated host ports are absent and must remain unused.
        expect(await runReplaySummaryForDialog({ cwd: '/repo', parentSessionId: 'sess_parent', runner,
            dialog: [{ role: 'User', createdAt: 1, text: 'hello' }, { role: 'Assistant', createdAt: 2, text: 'world' }],
            deps: { executeStart: (input, context) => executor.execute('execution.run.start', input, context) },
        })).toBe('SUMMARY_OK');
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.modelSelection).toEqual(runner.modelSelection);
        expect(buildBackendTargetKeyV2(request.backendTarget)).toBe(runner.modelSelection.agentTargetKey);
        expect(request.modelId).toBeUndefined();
        expect(request).toMatchObject({ intent: 'task', permissionMode: 'no_tools', retentionPolicy: 'ephemeral', runClass: 'bounded' });
        expect(request.instructions).toContain('User: hello');
        expect(request.instructions).toContain('Assistant: world');
        // Agents and MCP callers use the same schema and dispatch owner for this selection.
        for (const surface of ['agent', 'mcp'] as const) {
            expect(await executor.execute('execution.run.start', { ...request, sessionId: 'sess_parent' },
                { surface, authority: 'account_automation' })).toMatchObject({ ok: true, result: { runId: 'summary-run' } });
            expect(requests.at(-1)?.modelSelection).toEqual(runner.modelSelection);
        }
    });
});
