import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
} from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import type { AgentMessage } from '@/agent/core/AgentMessage';

describe('native Session Run parity', () => {
    it.each(['finite', 'retained'] as const)('projects only proven foreground text into a %s Run', async adapter => {
        let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        const turnId = 'run-scope-turn-1';
        // An arbitrary installed Agent is the external boundary; host admission and projection stay real.
        const runtime: AgentRuntime = { sessions: { async open() { return {
            async send(request) {
                publishRuntimeEvent!({ sequence: 1, sessionId: 'session-parent', emittedAtMs: 1,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                publishRuntimeEvent!({ sequence: 2, sessionId: 'session-parent', emittedAtMs: 2,
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
            lease: { pluginId: 'acme.scope', pluginVersion: '1.0.0', agentId: 'acme.scope/default',
                localAgentId: 'default', occurrenceId: 'scope-fixture', isCurrent: () => true },
            options: { cwd: '/repo', runId: 'run-scope', scope: 'session_owned', backendId: 'acme.scope/default',
                permissionMode: 'read_only', start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
            supportsResume: false,
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        });
        const messages: AgentMessage[] = [];
        const unsubscribe = host.subscribeMessages(message => messages.push(message));
        try {
            await host.provisionRuntime();
            await host.deliverInput('run-scope', { text: 'perform foreground work' }, { turnId });
            let sequence = 2;
            for (const { label, scope } of [
                { label: 'session', scope: {} },
                { label: 'sidechain', scope: { turnId, sidechainId: 'child' } },
                { label: 'older', scope: { turnId: 'older-turn' } },
                { label: 'foreground', scope: { turnId } },
            ]) {
                for (const channel of ['assistant', 'reasoning'] as const) {
                    publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                        kind: 'message-delta', channel, text: `${label} ${channel} draft`, messageId: `${label}-${channel}`, ...scope });
                }
                publishRuntimeEvent!({ sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence,
                    kind: 'transcript-message-committed', role: 'assistant', text: `${label} final answer`, messageId: `${label}-assistant`, ...scope });
            }
            expect(messages.filter(message => message.type === 'model-output' || (message.type === 'event' && message.name === 'thinking'))).toEqual([
                { type: 'model-output', textDelta: 'foreground assistant draft', messageId: 'foreground-assistant' },
                { type: 'event', name: 'thinking', payload: { textDelta: 'foreground reasoning draft' } },
                { type: 'model-output', fullText: 'foreground final answer', messageId: 'foreground-assistant' },
            ]);
        } finally {
            unsubscribe();
            await host.dispose();
        }
    });

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
