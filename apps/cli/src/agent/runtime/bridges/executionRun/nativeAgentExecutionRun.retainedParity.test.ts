import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
} from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';

describe('native Session Run parity', () => {
    it.each(['finite', 'retained'] as const)('publishes %s Run usage to the Session and exact Workflow owners', async adapter => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const publishUsage = vi.fn(async () => undefined);
        const observeWorkflowUsage = vi.fn();
        // The native Agent is the external boundary. Its accepted lifecycle reaches the real host owner.
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sequence: 1, sessionId: 'session-parent', emittedAtMs: 10,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sequence: 2, sessionId: 'session-parent', emittedAtMs: 10,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                return { status: 'admitted' as const };
            },
            watch(listener) { publishRuntimeEvent = listener; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const createHost = adapter === 'finite'
            ? createNativeAgentSessionExecutionRunHostRuntime
            : createNativeAgentSessionInteractionHostRuntime;
        const host = createHost({
            runtime,
            lease: { pluginId: 'acme.finite', pluginVersion: '1.0.0', agentId: 'acme.finite/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-usage', scope: 'session_owned', backendId: 'acme.finite/default',
                permissionMode: 'read_only', start: {
                    intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral', observeWorkflowUsage,
                } },
            supportsResume: false,
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => ({
                ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                usagePublisher: { provider: 'acme.finite/default', publish: publishUsage },
            }),
        });
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-usage', { text: 'measure this run' }, { turnId: 'run-usage-turn-1' });
            publishRuntimeEvent!({ sequence: 3, sessionId: 'session-parent', emittedAtMs: 20,
                turnId: 'run-usage-turn-1', kind: 'usage-observed', observationId: 'usage-attached-1',
                source: 'provider', scope: 'turn_delta', modelId: 'model-a',
                tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 } });
            await vi.waitFor(() => expect(publishUsage).toHaveBeenCalledOnce());
            expect(publishUsage).toHaveBeenCalledWith(expect.objectContaining({
                externalKey: 'usage-attached-1', turnId: 'run-usage-turn-1',
                observation: expect.objectContaining({ provider: 'acme.finite/default',
                    tokens: expect.objectContaining({ total: 12 }) }),
            }));
            expect(observeWorkflowUsage).toHaveBeenCalledWith({
                turnId: 'run-usage-turn-1', observation: expect.objectContaining({
                    provider: 'acme.finite/default', scope: 'turn_delta',
                    tokens: expect.objectContaining({ input: 8, output: 4 }),
                    availability: { inputTokens: true, outputTokens: true, reportedCostUsd: false },
                }),
            });
        } finally { await host.dispose(); }
    });

    it('sanitizes retained failure completion while preserving native recovery evidence', async () => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 1, emittedAtMs: 10,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 2, emittedAtMs: 10,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                return { status: 'admitted' as const };
            },
            watch(listener) { publishRuntimeEvent = listener; return { dispose() {} }; },
            async dispose() {},
        }; } } };
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: { pluginId: 'acme.retained', pluginVersion: '1.0.0', agentId: 'acme.retained/default',
                localAgentId: 'default', occurrenceId: 'fixture-occurrence', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-failure', scope: 'session_owned', backendId: 'acme.retained/default',
                permissionMode: 'read_only', sanitizeProviderDiagnosticText: text => text.replaceAll('provider-secret', '[REDACTED]') },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-failure', { text: 'perform work' }, { turnId: 'run-failure-turn-1' });
            publishRuntimeEvent!({ sessionId: 'session-parent', sequence: 3, emittedAtMs: 20,
                kind: 'turn-failed', turnId: 'run-failure-turn-1',
                diagnostic: { code: 'provider_capacity', severity: 'error', message: 'busy provider-secret',
                    details: { retryAfterMs: 2000 } } });
            const completionError = await host.waitForTurnCompletion!().catch((error: unknown) => error);
            expect(completionError).toMatchObject({ message: expect.stringContaining('busy [REDACTED]') });
            expect(readRuntimeTurnFailureAlreadySurfacedEvent(completionError)).toMatchObject({
                kind: 'turn-failed', turnId: 'run-failure-turn-1',
                diagnostic: { code: 'provider_capacity', severity: 'error', message: 'busy [REDACTED]',
                    details: { retryAfterMs: 2000 } },
            });
        } finally { await host.dispose(); }
    });
});
