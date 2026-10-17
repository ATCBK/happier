import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { InvalidAskUserQuestionInputError } from '@/agent/questions/normalizeAskUserQuestionInput';

import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from './agentStateRequestStore';
import { createPermissionRequestCoordinator } from './permissionRequestCoordinator';

class FakeSession {
    sessionId = 'session-test';
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

      await this.updateAgentState(updater);

    }


    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
    }
}

type TestPermissionResult = Readonly<{ decision: string; answers?: Readonly<Record<string, string>> }>;

function createHarness() {
    const session = new FakeSession();
    const store = new AgentStateRequestStore({
        session,
        logPrefix: '[CoordinatorTest]',
    });
    const coordinator = createPermissionRequestCoordinator<TestPermissionResult>({
        store,
    });
    return { coordinator, session, store };
}

const bashRequest = {
    requestId: 'toolu_test',
    toolName: 'Bash',
    toolInput: { command: ['bash', '-lc', 'echo hi'] },
    createdAt: 100,
};

function approve(requestId = bashRequest.requestId): TestPermissionResult {
    return { decision: `approved:${requestId}` };
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    return Promise.race([
        promise.then(
            () => 'fulfilled' as const,
            () => 'rejected' as const,
        ),
        Promise.resolve('pending' as const),
    ]);
}

describe('PermissionRequestCoordinator', () => {
    it('does not apply an approval after cancellation retired its pending entry', async () => {
        const { coordinator, store } = createHarness();
        let approveAdmission!: () => void;
        store.completeRequest = ({ status }) => status === 'approved'
            ? new Promise<void>((resolve) => { approveAdmission = resolve; })
            : Promise.resolve();
        const pending = coordinator.requestDecision(bashRequest);
        const rejected = expect(pending).rejects.toThrow('canceled');
        let granted = false;
        coordinator.completeResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        });
        await coordinator.cancelAll('canceled');
        await rejected;
        approveAdmission();
        await Promise.resolve();
        await Promise.resolve();
        expect(granted).toBe(false);
    });
    it('does not grant approval while its cancellation is awaiting durable admission', async () => {
        const { coordinator, store } = createHarness();
        const admissions = new Map<string, () => void>();
        store.completeRequest = ({ status }) => new Promise<void>((resolve) => { admissions.set(status, resolve); });
        const pending = coordinator.requestDecision(bashRequest);
        const rejected = expect(pending).rejects.toThrow('canceled');
        let granted = false;
        coordinator.completeResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        });
        const cancellation = coordinator.cancelAll('canceled');
        admissions.get('approved')!();
        await Promise.resolve();
        await Promise.resolve();
        expect(granted).toBe(false);
        admissions.get('canceled')!();
        await cancellation;
        await rejected;
    });
    it('does not release a provider waiter claimed while durable admission is pending', async () => {
        const { coordinator, store } = createHarness();
        let claimed = false;
        store.isOutstandingRequestClaimed = () => claimed;
        let admit!: () => void;
        store.completeRequest = () => new Promise<void>((resolve) => { admit = resolve; });
        const pending = coordinator.requestDecision(bashRequest);
        let resumed = false;
        void pending.then(() => { resumed = true; }, () => {});
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        coordinator.completeResponse({ context, completion: { result: approve(), completedRequest: { status: 'approved' } } });
        claimed = true;
        admit();
        await Promise.resolve();
        await Promise.resolve();
        expect(resumed).toBe(false);
        coordinator.cancelRequest(bashRequest.requestId, 'test cleanup');
        await expect(pending).rejects.toThrow('test cleanup');
    });
    it('holds the provider waiter until request settlement obtains durable custody', async () => {
        const { coordinator, store } = createHarness();
        let admit!: () => void;
        store.completeRequest = () => new Promise<void>((resolve) => { admit = resolve; });
        const provider = coordinator.requestDecision(bashRequest);
        let providerResumed = false;
        void provider.then(() => { providerResumed = true; });
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        expect(coordinator.completeResponse({ context, completion: {
            result: approve(), completedRequest: { status: 'approved' },
        } })).toBe(true);
        await Promise.resolve();
        expect(providerResumed).toBe(false);
        admit();
        await expect(provider).resolves.toEqual(approve());
    });
    it('rejects invalid AskUserQuestion input before request publication or waiter insertion', async () => {
        const { coordinator, session } = createHarness();
        const invalid = {
            requestId: 'invalid-question',
            toolName: 'ask_user_question',
            toolInput: { questions: [{ question: 'x'.repeat(16_385), options: [] }] },
            createdAt: 1,
        };

        expect(() => coordinator.requestDecision(invalid)).toThrow(InvalidAskUserQuestionInputError);
        expect(session.agentState.requests!['invalid-question']).toBeUndefined();
        expect(coordinator.getResponseContext('invalid-question')).toBeNull();

        const valid = coordinator.requestDecision({
            ...invalid,
            toolInput: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
        });
        expect(coordinator.getResponseContext('invalid-question')).toEqual(expect.objectContaining({ status: 'live' }));
        coordinator.cancelRequest('invalid-question', 'test complete');
        await expect(valid).rejects.toThrow('test complete');
    });

    it('rolls back the pending record when publication rejects a second-pass input check', async () => {
        let rejectPublication = true;
        let publishCount = 0;
        const coordinator = createPermissionRequestCoordinator<TestPermissionResult>({
            store: {
                publishRequest: () => {
                    publishCount += 1;
                    if (rejectPublication) throw new InvalidAskUserQuestionInputError();
                },
                completeRequest: async () => {},
                hasOutstandingRequest: () => false,
                isOutstandingRequestClaimed: () => false,
                readOutstandingRequest: () => null,
            },
        });
        const request = {
            requestId: 'second-pass-invalid',
            toolName: 'ask_user_question',
            toolInput: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
            createdAt: 1,
        };

        expect(() => coordinator.requestDecision(request)).toThrow(InvalidAskUserQuestionInputError);
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();

        rejectPublication = false;
        const retry = coordinator.requestDecision(request);
        expect(publishCount).toBe(2);
        expect(coordinator.getResponseContext(request.requestId)).toEqual(expect.objectContaining({ status: 'live' }));
        coordinator.cancelRequest(request.requestId, 'test complete');
        await expect(retry).rejects.toThrow('test complete');
    });

    it('fences opaque claims from persisted and already-live coordinator response paths', async () => {
        const { coordinator, session } = createHarness();
        const opaqueClaim = { malformed: [true, { unexpected: 'shape' }] };

        const claimedRequest: NonNullable<AgentState['requests']>[string] & Record<'permissionResponseClaimV1', unknown> = {
            tool: 'Bash',
            kind: 'permission',
            arguments: bashRequest.toolInput,
            createdAt: 1,
            permissionResponseClaimV1: opaqueClaim,
        };
        session.agentState.requests!.persisted = claimedRequest;

        expect(coordinator.getResponseContext('persisted')).toBeNull();
        await expect(coordinator.requestDecision({ ...bashRequest, requestId: 'persisted' })).rejects.toThrow(/reserved/i);
        expect(coordinator.handleResponse({
            requestId: 'persisted',
            buildCompletion: () => ({
                result: approve('persisted'),
                completedRequest: { status: 'approved', decision: 'approved_for_session', allowedTools: ['Bash(*)'] },
            }),
        })).toBe(false);
        expect(session.agentState.completedRequests!.persisted).toBeUndefined();

        const controller = new AbortController();
        const live = coordinator.requestDecision({ ...bashRequest, requestId: 'live-claim' }, { signal: controller.signal });
        const staleContext = coordinator.getResponseContext('live-claim');
        expect(staleContext).not.toBeNull();
        (session.agentState.requests!['live-claim'] as Record<string, unknown>).permissionResponseClaimV1 = opaqueClaim;

        expect(coordinator.getResponseContext('live-claim')).toBeNull();
        expect(coordinator.completeResponse({
            context: staleContext!,
            completion: {
                result: approve('live-claim'),
                completedRequest: { status: 'approved', decision: 'approved_for_session', allowedTools: ['Bash(*)'] },
            },
        })).toBe(false);

        controller.abort();
        await expect(live).rejects.toThrow('Permission request aborted');
        coordinator.cancelAll('reset after claim');

        const retained = session.agentState.requests!['live-claim'] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
        expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
        expect(session.agentState.completedRequests!['live-claim']).toBeUndefined();
    });

    it('attaches duplicate request ids to one UI request and resolves every live waiter', async () => {
        const { coordinator, session } = createHarness();

        const first = coordinator.requestDecision(bashRequest);
        const second = coordinator.requestDecision({
            ...bashRequest,
            createdAt: 200,
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([bashRequest.requestId]);
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
                createdAt: 100,
            }),
        );

        const handled = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: {
                    status: 'approved',
                    decision: 'approved',
                },
            }),
        });

        expect(handled).toBe(true);
        await expect(first).resolves.toEqual(approve());
        await expect(second).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('removes only the aborted waiter while other waiters remain live', async () => {
        const { coordinator } = createHarness();
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();

        const first = coordinator.requestDecision(bashRequest, { signal: firstAbort.signal });
        const second = coordinator.requestDecision(bashRequest, { signal: secondAbort.signal });

        firstAbort.abort();

        await expect(first).rejects.toThrow('Permission request aborted');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                status: 'live',
                correlation: 'record',
            }),
        );

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        await expect(second).resolves.toEqual(approve());
    });

    it('exposes structured-response ownership only while a local waiter is live', async () => {
        const { coordinator } = createHarness();
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });

        expect(coordinator.getLocallyOwnedLiveResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                correlation: 'record',
                status: 'live',
            }),
        );

        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(coordinator.getLocallyOwnedLiveResponseContext(bashRequest.requestId)).toBeNull();
    });

    it('retains all-aborted requests as detached and satisfies a compatible same-id retry after late approval', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();

        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                status: 'detached',
                correlation: 'record',
                toolName: 'Bash',
                toolInput: bashRequest.toolInput,
            }),
        );

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: (context) => ({
                    result: approve(context.requestId),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({ status: 'approved', decision: 'approved' }),
        );

        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('keeps a failed detached UI response retryable and waits for persistence after reattachment', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        const completion = {
            result: approve(),
            completedRequest: { status: 'approved', decision: 'approved' },
        };
        const updateState = session.updateAgentState.bind(session);
        session.updateAgentState = async () => { throw new Error('state transport unavailable'); };
        await expect(coordinator.completeRpcResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!, completion,
        })).rejects.toThrow('state transport unavailable');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toMatchObject({
            status: 'detached', correlation: 'record',
        });
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        let release!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
        session.updateAgentState = async (updater) => {
            await acknowledgement;
            updateState(updater);
        };
        const response = coordinator.completeRpcResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!, completion,
        });
        const retry = coordinator.requestDecision(bashRequest);
        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        release();
        await expect(response).resolves.toBe(true);
        await expect(retry).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('replays a late cached decision for multiple compatible same-id retry callers', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: (context) => ({
                    result: approve(context.requestId),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('does not consume a cached decision when the same id is retried with different input', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        const retryAbort = new AbortController();
        await expect.poll(() => coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        const retry = coordinator.requestDecision(
            {
                ...bashRequest,
                toolInput: { command: ['bash', '-lc', 'echo different'] },
                createdAt: 300,
            },
            { signal: retryAbort.signal },
        );

        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                arguments: { command: ['bash', '-lc', 'echo different'] },
                createdAt: 300,
            }),
        );

        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('prioritizes an incompatible pending retry over an older cached decision', async () => {
        const { coordinator } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        const incompatibleAbort = new AbortController();
        await expect.poll(() => coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        const incompatible = coordinator.requestDecision(
            {
                ...bashRequest,
                toolInput: { command: ['bash', '-lc', 'echo different'] },
            },
            { signal: incompatibleAbort.signal },
        );
        incompatibleAbort.abort();
        await expect(incompatible).rejects.toThrow('Permission request aborted');

        const originalRetryAbort = new AbortController();
        const originalRetry = coordinator.requestDecision(bashRequest, { signal: originalRetryAbort.signal });
        await expect(originalRetry).rejects.toThrow('already pending with different tool input');
    });

    it('rejects incompatible duplicate waiters while an existing request id is live', async () => {
        const { coordinator } = createHarness();

        const first = coordinator.requestDecision(bashRequest);
        const incompatible = coordinator.requestDecision({
            ...bashRequest,
            toolInput: { command: ['bash', '-lc', 'echo different'] },
        });

        await expect(incompatible).rejects.toThrow('already pending with different tool input');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);
        await expect(first).resolves.toEqual(approve());
    });

    it('rejects incompatible duplicate waiters while an existing request id is detached', async () => {
        const { coordinator } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        const incompatible = coordinator.requestDecision({
            ...bashRequest,
            toolInput: { command: ['bash', '-lc', 'echo different'] },
        });

        await expect(incompatible).rejects.toThrow('already pending with different tool input');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                status: 'detached',
                toolInput: bashRequest.toolInput,
            }),
        );
    });

    it('keeps a failed agent-state-only UI response retryable and preserves independent requests', async () => {
        const { coordinator, session, store } = createHarness();

        store.publishRequest({
            requestId: 'agent-state-only',
            toolName: 'AskUserQuestion',
            toolInput: { questions: [{ id: 'q1', question: 'q1' }] },
            createdAt: 500,
            kind: 'user_action',
        });
        store.publishRequest({
            requestId: 'independent', toolName: 'Bash', toolInput: { command: 'pwd' }, createdAt: 600,
        });

        const context = coordinator.getResponseContext('agent-state-only')!;
        expect(context).toMatchObject({ correlation: 'agent_state', status: 'agent_state_only' });
        const completion = {
            result: { decision: 'approved', answers: { q1: 'yes' } },
            completedRequest: {
                status: 'approved', decision: 'approved', extraCompletedFields: { answers: { q1: 'yes' } },
            },
        };
        const updateState = session.updateAgentState.bind(session);
        session.updateAgentState = async () => { throw new Error('state transport unavailable'); };
        await expect(coordinator.completeRpcResponse({ context, completion })).rejects.toThrow('state transport unavailable');
        expect(session.agentState.requests!['agent-state-only']).toBeDefined();
        expect(session.agentState.requests!.independent).toBeDefined();
        expect(session.agentState.completedRequests!['agent-state-only']).toBeUndefined();
        session.updateAgentState = updateState;

        await expect(coordinator.completeRpcResponse({ context, completion })).resolves.toBe(true);

        expect(session.agentState.requests!['agent-state-only']).toBeUndefined();
        expect(session.agentState.requests!.independent).toBeDefined();
        expect(session.agentState.completedRequests!['agent-state-only']).toEqual(
            expect.objectContaining({
                tool: 'AskUserQuestion',
                kind: 'user_action',
                status: 'approved',
                answers: { q1: 'yes' },
            }),
        );
    });

    it('ignores uncorrelated responses without building a completion', () => {
        const { coordinator, session } = createHarness();
        let built = false;

        expect(
            coordinator.handleResponse({
                requestId: 'stale',
                buildCompletion: () => {
                    built = true;
                    return {
                        result: approve('stale'),
                        completedRequest: { status: 'approved', decision: 'approved' },
                    };
                },
            }),
        ).toBe(false);

        expect(built).toBe(false);
        expect(Object.keys(session.agentState.completedRequests ?? {})).toEqual([]);
    });

    it('clears pending detached and cached state on lifecycle cancellation', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        await coordinator.cancelAll('Session ended');

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(bashRequest, { signal: retryAbort.signal });
        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
            }),
        );

        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
        coordinator.dispose();
    });

    it('does not use timer APIs for permission correctness', () => {
        const currentDir = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(currentDir, 'permissionRequestCoordinator.ts'), 'utf8');

        expect(source).not.toContain('setTimeout');
        expect(source).not.toContain('setInterval');
    });
});
