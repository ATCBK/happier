import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { AgentState } from '@/api/types';
import { logger } from '@/ui/logger';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { AgentStateRequestStore, type PermissionResponseClaim } from './agentStateRequestStore';

const localPermissionBridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

class FakeSession {
    sessionId = 'session-test';
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
    }
}

class AsyncFakeSession extends FakeSession {
    override updateAgentState(updater: (state: AgentState) => AgentState): Promise<void> {
        return Promise.resolve().then(() => {
            this.agentState = updater(this.agentState);
        });
    }
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('AgentStateRequestStore', () => {
    it.each<PermissionResponseClaim>([
        { version: 1, origin: 'automaticPolicy' },
        { version: 1, origin: 'approvalReviewer', turnId: 'turn-1', decision: 'approved', scope: 'request' },
        { version: 1, origin: 'presentUser', turnId: 'turn-1', actor: { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' }, decision: 'approved', scope: 'request' },
        { version: 1, origin: 'remoteMediation', turnId: 'turn-1', actor: { kind: 'externalHuman', assurance: 'pluginAsserted', namespace: 'discord', principalId: 'person-1', assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' } }, mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42', idempotencyKey: 'retry-1', decision: 'allow', scope: 'request' },
    ])('rejoins and releases the retained $origin claim without granting meaning to extra fields', async (claim) => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        store.publishRequest({ requestId: 'retained', toolName: 'Bash', toolInput: {}, createdAt: 1 });
        const retained = { ...claim, retired: true, ...('actor' in claim ? { actor: { ...claim.actor, retired: true, ...('assertedBy' in claim.actor ? { assertedBy: { ...claim.actor.assertedBy, retired: true } } : {}) } } : {}) };
        session.agentState.requests!['retained'].permissionResponseClaimV1 = retained;
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'rejoined' });
        await expect(store.rejoinPermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'rejoined' });
        const freshWithExtra = { ...claim, retired: true };
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim: freshWithExtra })).rejects.toThrow();
        const mismatch = claim.origin === 'remoteMediation'
            ? { ...retained, mediatorPluginId: 'another.plugin' }
            : claim.origin === 'presentUser'
                ? { ...retained, actor: { ...claim.actor, accountId: 'another-account' } }
                : claim.origin === 'approvalReviewer'
                    ? { ...retained, scope: 'session' }
                    : { ...retained, origin: 'retiredOrigin' };
        session.agentState.requests!['retained'].permissionResponseClaimV1 = mismatch;
        await expect(store.acquirePermissionResponseClaim({ requestId: 'retained', claim })).resolves.toEqual({ status: 'conflict' });
        session.agentState.requests!['retained'].permissionResponseClaimV1 = retained;
        await store.releasePermissionResponseClaim({ requestId: 'retained', claim });
        expect(session.agentState.requests!['retained']).not.toHaveProperty('permissionResponseClaimV1');
    });

    it('reads retained completed actors but refuses a different known actor identity', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const actor = { kind: 'accountUser', accountId: 'account-owner', relationship: 'owner' } as const;
        const claim = { version: 1, origin: 'presentUser', actor, decision: 'approved', scope: 'request' } as const;
        session.agentState.completedRequests!.retained = { tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved', decision: 'approved', permissionDecisionActorV1: { ...actor, retired: true } };
        expect(store.readCompletedPermissionResponseClaim({ requestId: 'retained', claim })).toEqual({ status: 'rejoined' });
        expect(store.readCompletedPermissionResponseClaim({ requestId: 'retained', claim: { ...claim, actor: { ...actor, accountId: 'another-account' } } })).toEqual({ status: 'conflict' });
    });

    it('projects persisted request owner authority during reload and plugin cancellation', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const sourceAuthority = { kind: 'mediatedExternal', mediatorPluginId: 'happier.channels', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '42', admittedPermissionCeiling: 'default', remoteApprovalMaxScope: 'session' } as const;
        session.agentState.requests!.retained = { tool: 'Bash', arguments: {}, createdAt: 1, owner: { kind: 'plugin', pluginId: 'provider.codex', sourceAuthority: { ...sourceAuthority, retired: true } } };
        expect(store.readOutstandingRequest('retained')?.owner).toEqual({ kind: 'plugin', pluginId: 'provider.codex', sourceAuthority });
        await store.cancelRequestsByOwner({ owner: { kind: 'plugin', pluginId: 'provider.codex' }, reason: 'Plugin stopped', requestIds: ['retained'] });
        expect(session.agentState.requests!.retained).toBeUndefined();
        expect(session.agentState.completedRequests!.retained?.status).toBe('canceled');
    });

    it('surfaces durable publication failure to an interaction producer', async () => {
        const persistenceError = new Error('workflow interaction exceeds durable content capacity');
        const store = new AgentStateRequestStore({
            target: {
                scopeId: 'workflow-invocation:capacity-failure',
                readState: () => ({ requests: Object.create(null), completedRequests: Object.create(null) }),
                updateState: async () => {
                    throw persistenceError;
                },
            },
            logPrefix: '[WorkflowTest]',
        });

        await expect(store.publishRequestAndWait({
            requestId: 'req-too-large',
            toolName: 'Bash',
            toolInput: { command: 'large command' },
            createdAt: 123,
        })).rejects.toBe(persistenceError);
    });

    it('persists and notifies through a non-Session request-state target', async () => {
        let state: AgentState = {
            requests: Object.create(null),
            completedRequests: Object.create(null),
        };
        const notifyRequest = vi.fn();
        const markRequestCompleted = vi.fn();
        const store = new AgentStateRequestStore({
            target: {
                scopeId: 'workflow-invocation:test',
                readState: () => state,
                updateState: (updater) => {
                    state = updater(state);
                },
                notifyRequest,
                markRequestCompleted,
            },
            logPrefix: '[WorkflowTest]',
        });

        store.publishRequest({
            requestId: 'req-run-1',
            toolName: 'Bash',
            toolInput: { command: 'git status' },
            createdAt: 123,
        });
        expect(state.requests?.['req-run-1']).toEqual(expect.objectContaining({ tool: 'Bash' }));
        expect(notifyRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-run-1' }));

        await store.completeRequest({ requestId: 'req-run-1', status: 'approved', decision: 'approved' });
        expect(state.requests?.['req-run-1']).toBeUndefined();
        expect(state.completedRequests?.['req-run-1']).toEqual(expect.objectContaining({ status: 'approved' }));
        expect(markRequestCompleted).toHaveBeenCalledWith('req-run-1');
    });

    it('retires only the selected request source when an Action continuation cannot be restored', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        for (const [requestId, source] of [['action', 'happier_action'], ['native', 'native_tool']] as const) {
            store.publishRequest({ requestId, source, toolName: 'Review', toolInput: {}, createdAt: 1 });
        }
        await store.cancelRequestsBySource?.({
            source: 'happier_action', reason: 'continuation unavailable', decision: 'abort', requestIds: [],
        });
        expect(store.hasOutstandingRequest('action')).toBe(false);
        expect(store.hasOutstandingRequest('native')).toBe(true);
        expect(session.agentState.completedRequests?.action?.status).toBe('canceled');
    });

    it('does not let automatic native policy claim a Happier Action confirmation', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        store.publishRequest({
            requestId: 'action-confirmation',
            toolName: 'Bash',
            toolInput: { command: 'echo hi' },
            createdAt: 1,
            source: 'happier_action',
        });
        await expect(store.acquirePermissionResponseClaim({
            requestId: 'action-confirmation',
            claim: { version: 1, origin: 'automaticPolicy' },
        })).resolves.toEqual({ status: 'conflict' });
        expect(store.hasPermissionResponseClaim('action-confirmation')).toBe(false);
        expect(store.hasOutstandingRequest('action-confirmation')).toBe(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('publishes and completes a request', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            source: 'test-source',
        });

        expect(session.agentState.requests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: ['bash', '-lc', 'echo hi'] },
                createdAt: 123,
                source: 'test-source',
            }),
        );

        store.completeRequest({
            requestId: 'req-1',
            status: 'approved',
            decision: 'approved',
            extraCompletedFields: { answers: { a: 'b' } },
        });

        expect(session.agentState.requests!['req-1']).toBeUndefined();
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                status: 'approved',
                decision: 'approved',
                answers: { a: 'b' },
            }),
        );
    });

    it('does not rejoin a present-user response from a canceled completed request', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const claim = {
            version: 1,
            origin: 'presentUser',
            actor: {
                kind: 'accountUser',
                accountId: 'account-owner',
                relationship: 'owner',
            },
            decision: 'abort',
            scope: 'request',
        } satisfies PermissionResponseClaim;

        store.publishRequest({
            requestId: 'canceled-present-response',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
        });
        await store.completeRequest({
            requestId: 'canceled-present-response',
            status: 'denied',
            decision: 'abort',
            extraCompletedFields: { permissionDecisionActorV1: claim.actor },
        });
        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: ['canceled-present-response'],
        });

        expect(store.readCompletedPermissionResponseClaim({
            requestId: 'canceled-present-response',
            claim,
        })).toEqual({ status: 'conflict' });
    });

    it('skips publishing a generated local-bridge request covered by a recent canonical cancellation', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        session.agentState.completedRequests!['toolu_canonical'] = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: question,
            createdAt: 1_000,
            completedAt: 10_000,
            status: 'canceled',
            reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        } as any;

        store.publishRequest({
            requestId: 'perm_generated',
            toolName: 'AskUserQuestion',
            toolInput: question,
            createdAt: 10_500,
            kind: 'user_action',
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        });

        expect(session.agentState.requests!['perm_generated']).toBeUndefined();
    });

    it('does not send a permission push for an async publish skipped by completed request coverage', async () => {
        const session = new AsyncFakeSession();
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const settings = accountSettingsParse({
            notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        });
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
            pushSender: { sendToAllDevicesAsync, fetchSessionNotificationContext: async (sessionId) => createSessionNotificationContextFixture(sessionId) },
            getAccountSettings: () => settings,
            getSessionTitle: () => 'Session',
            getAgentDisplayName: () => 'Agent',
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        session.agentState.completedRequests!['toolu_canonical'] = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: question,
            createdAt: 1_000,
            completedAt: 10_000,
            status: 'canceled',
            reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        } as any;

        store.publishRequest({
            requestId: 'perm_generated',
            toolName: 'AskUserQuestion',
            toolInput: question,
            createdAt: 10_500,
            kind: 'user_action',
            source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        });
        await flushMicrotasks();

        expect(session.agentState.requests!['perm_generated']).toBeUndefined();
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });

    it('removes an equivalent generated local-bridge request when the canonical request is canceled', () => {
        const now = new Date('2026-06-19T18:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

        try {
            store.publishRequest({
                requestId: 'perm_generated',
                toolName: 'AskUserQuestion',
                toolInput: question,
                createdAt: now.getTime(),
                kind: 'user_action',
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            });
            store.publishRequest({
                requestId: 'toolu_canonical',
                toolName: 'AskUserQuestion',
                toolInput: question,
                createdAt: 1_000,
                kind: 'user_action',
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            });

            store.completeRequest({
                requestId: 'toolu_canonical',
                status: 'canceled',
                reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            });

            expect(session.agentState.requests!['perm_generated']).toBeUndefined();
            expect(session.agentState.completedRequests!['perm_generated']).toEqual(
                expect.objectContaining({
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves response target metadata through outstanding and completed records', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const responseTarget = {
            kind: 'test_target',
            requestOwner: 'owner-1',
        };
        const subagentRef = {
            runId: 'run-1',
            callId: 'call-1',
        };

        store.publishRequest({
            requestId: 'req-targeted',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget,
            subagentRef,
            sidechainId: 'sidechain-1',
        });

        expect(session.agentState.requests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );
        expect(store.readOutstandingRequest('req-targeted')).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );

        store.completeRequest({
            requestId: 'req-targeted',
            status: 'approved',
            decision: 'approved',
        });

        expect(session.agentState.completedRequests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('dispatches completed requests through the registered response target handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-dispatch',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        });

        store.completeRequest({
            requestId: 'req-dispatch',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-dispatch',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    tool: 'Bash',
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('dispatches response target handlers after asynchronous state updates settle', async () => {
        const session = new AsyncFakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        session.agentState.requests!['req-async'] = {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        };
        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });

        store.completeRequest({
            requestId: 'req-async',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        await flushMicrotasks();

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-async',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('treats async response target handler failures as non-fatal', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        let handled = false;

        store.registerResponseTargetHandler('test_target', async () => {
            handled = true;
            throw new Error('handler failed');
        });
        store.publishRequest({
            requestId: 'req-async-handler',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.completeRequest({
            requestId: 'req-async-handler',
            status: 'approved',
            decision: 'approved',
        });
        await flushMicrotasks();

        expect(handled).toBe(true);
        expect(session.agentState.completedRequests!['req-async-handler']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('retains a failed response delivery for replay and clears its target after later success', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const failedDelivery = vi.fn(async () => false);
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

        const unregisterFailedDelivery = store.registerResponseTargetHandler('test_target', failedDelivery);
        store.publishRequest({
            requestId: 'req-recoverable-delivery',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target', requestOwner: 'owner-1' },
        });
        await store.completeRequest({
            requestId: 'req-recoverable-delivery',
            status: 'approved',
            decision: 'approved',
        });
        await flushMicrotasks();

        expect(failedDelivery).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('Response target handler did not deliver'));
        unregisterFailedDelivery();

        const recoveredDelivery = vi.fn(async () => true as never);
        const unregisterRecoveredDelivery = store.registerResponseTargetHandler('test_target', recoveredDelivery);
        await flushMicrotasks();

        expect(recoveredDelivery).toHaveBeenCalledTimes(1);
        expect(recoveredDelivery).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'req-recoverable-delivery',
            responseTarget: { kind: 'test_target', requestOwner: 'owner-1' },
            completedRequest: expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        }));

        unregisterRecoveredDelivery();
        const repeatDelivery = vi.fn(async () => true as never);
        store.registerResponseTargetHandler('test_target', repeatDelivery);
        await flushMicrotasks();

        expect(repeatDelivery).not.toHaveBeenCalled();
        expect(session.agentState.completedRequests!['req-recoverable-delivery']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
        expect(session.agentState.completedRequests!['req-recoverable-delivery']?.responseTarget).toBeUndefined();
        debug.mockRestore();
    });

    it('retires only completed records for an exact terminal turn after delivery while preserving grants', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        for (const [requestId, turnId, decision] of [
            ['prior-plain', 'turn-a', 'approved'],
            ['prior-grant', 'turn-a', 'approved_for_session'],
            ['current-plain', 'turn-b', 'approved'],
        ] as const) {
            store.publishRequest({ requestId, turnId, toolName: 'Bash', toolInput: { command: requestId }, createdAt: 1 });
            await store.completeRequest({ requestId, status: 'approved', decision });
        }

        await store.retireCompletedRequestsForTurn('turn-a');

        expect(session.agentState.completedRequests?.['prior-plain']).toBeUndefined();
        expect(session.agentState.completedRequests?.['prior-grant']).toMatchObject({
            turnId: 'turn-a',
            decision: 'approved_for_session',
        });
        expect(session.agentState.completedRequests?.['current-plain']).toMatchObject({ turnId: 'turn-b' });
    });

    it('compacts a terminal turn when its in-flight response delivery later succeeds', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const deliveryControl: { finish: (() => void) | null } = { finish: null };
        store.registerResponseTargetHandler('test_target', async () => {
            await new Promise<void>((resolve) => { deliveryControl.finish = resolve; });
            return true;
        });
        store.publishRequest({
            requestId: 'terminal-delivery',
            turnId: 'turn-terminal',
            toolName: 'Bash',
            toolInput: { command: 'echo done' },
            createdAt: 1,
            responseTarget: { kind: 'test_target' },
        });
        await store.completeRequest({
            requestId: 'terminal-delivery',
            status: 'approved',
            decision: 'approved',
        });

        const retirement = store.retireCompletedRequestsForTurn('turn-terminal');
        await flushMicrotasks();
        expect(session.agentState.completedRequests?.['terminal-delivery']).toBeDefined();
        deliveryControl.finish?.();
        await retirement;
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-delivery']).toBeUndefined();
    });

    it('retains a failed terminal-turn delivery for replay and compacts it after later success', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const releaseFailed = store.registerResponseTargetHandler('test_target', () => false);
        store.publishRequest({
            requestId: 'terminal-replay',
            turnId: 'turn-terminal',
            toolName: 'Bash',
            toolInput: { command: 'echo replay' },
            createdAt: 1,
            responseTarget: { kind: 'test_target' },
        });
        await store.completeRequest({
            requestId: 'terminal-replay',
            status: 'approved',
            decision: 'approved',
        });
        await store.retireCompletedRequestsForTurn('turn-terminal');
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-replay']).toMatchObject({
            responseTarget: { kind: 'test_target' },
        });
        releaseFailed();
        store.registerResponseTargetHandler('test_target', () => true);
        await flushMicrotasks();

        expect(session.agentState.completedRequests?.['terminal-replay']).toBeUndefined();
    });

    it('does not deliver another Session completed response to the old Session handler', async () => {
        const sessionA = new FakeSession();
        const sessionB = new FakeSession();
        sessionB.sessionId = 'another-session';
        sessionB.agentState.completedRequests!.other = {
            tool: 'Review', arguments: {}, createdAt: 1, completedAt: 2,
            status: 'approved', decision: 'approved', responseTarget: { kind: 'test_target' },
        };
        const store = new AgentStateRequestStore({ session: sessionA, logPrefix: '[Test]' });
        const delivered: string[] = [];
        store.registerResponseTargetHandler('test_target', (dispatch) => { delivered.push(dispatch.requestId); });
        store.updateSession(sessionB);
        await flushMicrotasks();
        expect(delivered).toEqual([]);
    });

    it('replays only undelivered completed response targets after an authoritative session rebind', async () => {
        const sessionA = new FakeSession();
        const sessionB = new FakeSession();
        sessionA.sessionId = 'session-a';
        sessionB.sessionId = 'session-a';
        sessionB.agentState.completedRequests!['delivered'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo delivered'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['returned-false'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo returned-false'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['throws'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo throws'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['rejects'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo rejects'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'test_target' },
        };
        sessionB.agentState.completedRequests!['other-target'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo other-target'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: 'other_target' },
        };
        sessionB.agentState.completedRequests!['malformed-target'] = {
            tool: 'Bash',
            arguments: { command: ['bash', '-lc', 'echo malformed-target'] },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            decision: 'approved',
            responseTarget: { kind: '   ' },
        };

        const store = new AgentStateRequestStore({
            session: sessionA,
            logPrefix: '[Test]',
        });
        const dispatches: string[] = [];
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const unsubscribe = store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch.requestId);
            if (dispatch.requestId === 'returned-false') return false;
            if (dispatch.requestId === 'throws') throw new Error('delivery failed');
            if (dispatch.requestId === 'rejects') return Promise.reject(new Error('delivery rejected'));
            return true;
        });

        store.updateSession(sessionB);
        await flushMicrotasks();

        expect(dispatches.sort()).toEqual(['delivered', 'rejects', 'returned-false', 'throws']);

        // Successful delivery removes only its response target. Failed
        // deliveries retain their exact durable replay obligation.
        store.updateSession(sessionB);
        await flushMicrotasks();

        expect(dispatches.sort()).toEqual([
            'delivered',
            'rejects',
            'rejects',
            'returned-false',
            'returned-false',
            'throws',
            'throws',
        ]);

        unsubscribe();
        store.updateSession(sessionB);
        await flushMicrotasks();
        expect(dispatches).toHaveLength(7);

        const disposedStore = new AgentStateRequestStore({
            session: sessionA,
            logPrefix: '[Disposed Test]',
        });
        const disposedHandler = vi.fn();
        disposedStore.registerResponseTargetHandler('test_target', disposedHandler);
        disposedStore.dispose();
        disposedStore.updateSession(sessionB);
        await flushMicrotasks();
        expect(disposedHandler).not.toHaveBeenCalled();
        debug.mockRestore();
    });

    it('preserves response target metadata when recording completed requests directly', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        await store.recordCompletedRequest({
            requestId: 'req-recorded',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            status: 'approved',
            decision: 'approved',
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
            subagentRef: {
                runId: 'run-1',
                callId: 'call-1',
            },
            sidechainId: 'sidechain-1',
            permissionSuggestions: [{ mode: 'allow' }],
        });
        await flushMicrotasks();

        expect(session.agentState.completedRequests!['req-recorded']).toEqual(
            expect.objectContaining({
                subagentRef: {
                    runId: 'run-1',
                    callId: 'call-1',
                },
                sidechainId: 'sidechain-1',
                permissionSuggestions: [{ mode: 'allow' }],
            }),
        );
        expect(session.agentState.completedRequests!['req-recorded']?.responseTarget).toBeUndefined();
        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-recorded',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
            }),
        ]);
    });

    it('rejects duplicate response target handlers and unregisters only the exact handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: string[] = [];
        const firstUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('first');
        });

        expect(() => store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('duplicate');
        })).toThrow(/test_target/);

        firstUnsubscribe();
        const secondUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('second');
        });
        firstUnsubscribe();

        store.publishRequest({
            requestId: 'req-second',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });
        store.completeRequest({
            requestId: 'req-second',
            status: 'approved',
            decision: 'approved',
        });

        secondUnsubscribe();
        store.publishRequest({
            requestId: 'req-after-unsubscribe',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo bye'] },
            createdAt: 124,
            responseTarget: { kind: 'test_target' },
        });

        expect(() => store.completeRequest({
            requestId: 'req-after-unsubscribe',
            status: 'approved',
            decision: 'approved',
        })).not.toThrow();
        expect(dispatches).toEqual(['second']);
        expect(session.agentState.completedRequests!['req-after-unsubscribe']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('clears response target handlers when disposed', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-after-dispose',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.dispose();
        store.completeRequest({
            requestId: 'req-after-dispose',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        expect(session.agentState.completedRequests!['req-after-dispose']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('cancels all outstanding requests', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
        });
        store.publishRequest({
            requestId: 'req-2',
            toolName: 'Write',
            toolInput: { path: '/tmp/x', content: 'hi' },
            createdAt: 2,
        });

        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: [],
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);
        expect(Object.keys(session.agentState.completedRequests ?? {}).sort()).toEqual(['req-1', 'req-2']);
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({ status: 'canceled', decision: 'abort', reason: 'Session ended' }),
        );
        expect(session.agentState.completedRequests!['req-2']).toEqual(
            expect.objectContaining({ status: 'canceled', decision: 'abort', reason: 'Session ended' }),
        );
    });

    it('makes lifecycle cancellation durably nonauthorizing even for an opaque first-answer claim', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const owner = { kind: 'plugin' as const, pluginId: 'happier.channels', runtimeId: 'channels-runtime' };
        store.publishRequest({
            requestId: 'opaque-claim',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
            owner,
        });
        const opaqueClaim = { predecessor: 'unrecognized-first-answer-claim' };
        session.agentState.requests!['opaque-claim'].permissionResponseClaimV1 = opaqueClaim;

        await store.cancelAllRequests({
            reason: 'Session ended',
            decision: 'abort',
            requestIds: ['opaque-claim'],
        });
        await store.cancelRequestsByOwner({
            owner,
            reason: 'plugin_deactivated',
            decision: 'abort',
            requestIds: ['opaque-claim'],
        });
        await expect(store.completeRequest({
            requestId: 'opaque-claim',
            status: 'canceled',
            decision: 'abort',
            reason: 'caller_aborted',
            fallback: {
                toolName: 'Bash',
                toolInput: { command: ['bash', '-lc', 'echo hi'] },
                createdAt: 1,
                owner,
            },
        })).resolves.toBe(false);
        await expect(store.recordCompletedRequest({
            requestId: 'opaque-claim',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            status: 'approved',
            decision: 'approved',
            owner,
        })).resolves.toBe(false);

        expect(session.agentState.requests!['opaque-claim']).toBeUndefined();
        expect(session.agentState.completedRequests!['opaque-claim']).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            reason: 'Session ended',
            owner,
        }));
        expect(session.agentState.completedRequests!['opaque-claim']).not.toHaveProperty('permissionResponseClaimV1');
    });
});
