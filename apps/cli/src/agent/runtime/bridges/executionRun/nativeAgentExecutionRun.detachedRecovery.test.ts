import { describe, expect, it, vi } from 'vitest';
import type {
    AgentRuntime, AgentExecutionRunOpenRequest, AgentSessionSendRequest,
    AgentExecutionRunConversationEventV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createExecutionRunHostBackendFromConversationRuntime } from '../../../../../../../packages/plugin-sdk/src/agentRuntime/executionRun';
import { createNativeAgentExecutionRunHostRuntime } from './nativeAgentExecutionRun';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';

describe.each(['accepted', 'custody-unknown', 'rejected'] as const)('detached %s native input', custody => {
it('recovers only accepted failure, never an unknown-custody input', async () => {
    const requests: AgentExecutionRunOpenRequest[] = [];
    const sends: AgentSessionSendRequest[] = [];
    // This provider-native conversation is the sole external fake. The SDK's
    // truthful detached conversation adapter and host lifecycle remain real.
    const runtime: AgentRuntime = { executionRuns: { async open(request) {
        if (request.kind === 'fork') throw new Error('Fixture does not offer fork');
        requests.push(request);
        return await createExecutionRunHostBackendFromConversationRuntime({ request,
            readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
            async openConversation() {
                let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
                return {
                    watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'detached-native-original' }); return { dispose() { listener = undefined; } }; },
                    async send(input) {
                        sends.push(input);
                        if (sends.length === 1 && custody !== 'accepted') {
                            if (custody === 'custody-unknown') listener?.({ kind: 'input-custody-unknown', inputIds: input.inputIds,
                                issue: { code: 'acp_input_custody_unknown', severity: 'error', details: { requestErrorCode: 429 } } });
                            else listener?.({ kind: 'input-rejected', inputIds: input.inputIds,
                                diagnostic: { code: 'acp_input_rejected_before_effect', severity: 'error', details: { requestErrorCode: 429 } } });
                            return { status: 'admitted' as const };
                        }
                        listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        if (sends.length === 1) {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Partial detached work. ' });
                            listener?.({ kind: 'turn-failed', turnId: input.delivery.turnId,
                                diagnostic: { code: 'provider_capacity', severity: 'error' } });
                        } else {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Detached continuation.' });
                            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                        }
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
            },
        });
    } } };
    const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({
        status: 'continue', input: 'Continue where you left off', async prepareResume() { return undefined; },
    }));
    const host = createNativeAgentExecutionRunHostRuntime({ runtime,
        lease: { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default', localAgentId: 'default', occurrenceId: 'detached-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'detached-recovery', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'resumable' }, prepareRuntimeFailureRecovery: recovery },
        supportsResume: true,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    try {
        await host.provisionRuntime({ initialPrompt: 'Perform effect once' });
        if (custody !== 'accepted') {
            await expect(host.waitForTurnCompletion?.()).rejects.toThrow(custody === 'custody-unknown' ? 'acp_input_custody_unknown' : 'acp_input_rejected_before_effect');
            expect(recovery).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            expect(sends).toHaveLength(1);
            return;
        }
        await host.waitForTurnCompletion?.();
        expect(recovery).toHaveBeenCalledOnce();
        expect(requests).toMatchObject([{ kind: 'create' }, { kind: 'resume', checkpointId: 'detached-native-original' }]);
        expect(sends.map(send => send.input.text)).toEqual(['Perform effect once', 'Continue where you left off']);
        expect(sends[1]?.inputIds).not.toEqual(sends[0]?.inputIds);
        expect(messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
        expect(JSON.stringify(messages)).toContain('Partial detached work. ');
        expect(JSON.stringify(messages)).toContain('Detached continuation.');
    } finally { await host.dispose(); }
});
});
