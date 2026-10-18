import { describe, expect, it } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, createActionExecutor, type ApprovalRequest, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createDaemonApprovalExecutionOriginCurrentness } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { registerApprovalRpcHandlers } from './approvals';

function createBoundaryDeps(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps {
    const unused = async (): Promise<never> => { throw new Error('unexpected_boundary'); };
    return {
        executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
        detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
        sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
        pathsListRecent: unused, machinesList: unused, serversList: unused, reviewEnginesList: unused,
        agentsBackendsList: unused, agentsModelsList: unused, sessionSendMessage: unused,
        sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
        sessionModeSet: unused, sessionModesList: unused,
        sessionTargetPrimarySet: unused, sessionTargetTrackedSet: unused, sessionList: unused,
        sessionActivityGet: unused, sessionRecentMessagesGet: unused,
        daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        resetGlobalVoiceAgent: unused,
        ...overrides,
    };
}

describe('approved directory consent replay authority', () => {
    it('refuses forged token-creation human authority with real daemon currentness', async () => {
        const tokenId = '11111111-1111-4111-8111-111111111111';
        let request: ApprovalRequest = {
            v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'agent', caller: { kind: 'host' },
                serverId: 'home-a', serverIdentityId: 'srv_home_a', accountId: 'account-a',
                actionId: 'account.apiTokens.create', requestId: 'forged-token-create' },
            actionId: 'account.apiTokens.create', actionArgs: { tokenId, label: 'Forged approval' },
            summary: 'Create token', decision: { kind: 'approve', decidedAtMs: 2 },
        };
        const currentness = createDaemonApprovalExecutionOriginCurrentness({
            accountId: 'account-a', machineId: 'machine-a', serverId: 'home-a',
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-a', serverIdentityId: 'srv_home_a' }),
            resolveTarget: async () => { throw new Error('account_request_has_no_runtime_target'); },
            isAccountCurrent: async () => true,
            listAccountApiTokens: async () => ({ tokens: [] }),
        });
        if (request.v !== 2) throw new Error('approval_v2_fixture_required');
        expect(await currentness({ origin: request.executionOriginV1, request })).toBe(true);
        const minted: unknown[] = [];
        const executor = createActionExecutor(createBoundaryDeps({
            approvalsGet: async () => request,
            approvalsUpdate: async ({ request: next }) => { request = next; return { ok: true }; },
            isApprovalExecutionOriginCurrent: currentness,
            accountApiTokensCreateAction: async args => {
                minted.push(args);
                return { token: `hap_v1_${tokenId}_${'A'.repeat(43)}`, apiToken: {
                    tokenId, label: 'Forged approval', displayPrefix: 'hap_v1_11111111',
                    createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
                    hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
                    parentTokenId: null, activeChildCount: 0, embedConfig: null,
                } };
            },
        }));
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
            actionExecutor: executor });
        const replay = handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        if (!replay) throw new Error('replay_handler_missing');
        for (const callerAuthority of [undefined, 'account_automation'] as const) {
            expect(await replay({ artifactId: 'forged-token', callerAuthority: 'present_user' },
                { signal: new AbortController().signal, callerAuthority }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(request.status).toBe('approved');
            expect(minted).toEqual([]);
        }
    });

    it('rejects caller-authored consent and accepts only verified human RPC authority', async () => {
        let request: ApprovalRequest = {
            v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'home-a', serverIdentityId: 'srv_home_a', accountId: 'account-a', machineId: 'machine-a',
                sessionId: 'session-a',
                actionId: 'session.open', requestId: 'directory-consent' },
            actionId: 'session.open', actionArgs: { sessionId: 'session-a', approvedNewDirectoryCreation: true },
            summary: 'Continue in a fresh folder', decision: { kind: 'approve', decidedAtMs: 2 },
        };
        const opened: unknown[] = [];
        const observed: Parameters<NonNullable<ActionExecutorDeps['observeActionExecution']>>[0][] = [];
        // Persistence, OS Session open and live Machine/Account queries are boundaries.
        // Authority admission, Artifact parsing/claim and origin currentness run for real.
        const deps = createBoundaryDeps({
            sessionOpen: async args => { opened.push(args); return { status: 'opened' }; },
            approvalsGet: async () => request,
            approvalsUpdate: async ({ request: next }) => { request = next; return { ok: true }; },
            observeActionExecution: async event => { observed.push(event); },
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
                accountId: 'account-a', machineId: 'machine-a', serverId: 'home-a',
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-a', serverIdentityId: 'srv_home_a' }),
                resolveTarget: async ({ target, currentMachineId }) => target?.kind === 'machine'
                    && target.machineId === currentMachineId ? target
                    : target?.kind === 'session' && target.sessionId === 'session-a' ? target : null,
                isAccountCurrent: async () => true,
                listAccountApiTokens: async () => ({ tokens: [] }),
            }),
        });
        const executor = createActionExecutor(deps);
        // Direct human admission is the control for the replayed invocation:
        // both reach the same loaded Session-open owner and OS boundary.
        const control = await executor.execute('session.open', request.actionArgs, {
            surface: 'agent', authority: 'present_user', serverId: 'home-a', defaultSessionId: 'session-a', bypassApprovals: true,
        });
        expect(control).toEqual({ ok: true, result: { status: 'opened' } });
        expect(request.status).toBe('approved');
        opened.length = 0;
        observed.length = 0;
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
            actionExecutor: executor });
        const replay = handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        if (!replay) throw new Error('replay_handler_missing');
        const payload = { artifactId: 'approved-body', callerAuthority: 'present_user', authority: 'present_user' };
        for (const callerAuthority of [undefined, 'account_automation'] as const) {
            expect(await replay(payload, { signal: new AbortController().signal, callerAuthority }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(request.status).toBe('approved');
            expect(opened).toEqual([]);
        }
        const humanResult = await replay(payload, { signal: new AbortController().signal, callerAuthority: 'present_user' });
        expect(observed).toMatchObject([{ actionId: 'session.open',
            input: { sessionId: 'session-a', approvedNewDirectoryCreation: true },
            context: { authority: 'present_user', serverId: 'home-a', bypassApprovals: true },
            result: { ok: true, result: { status: 'opened' } } }]);
        expect(request.execution && !request.execution.ok ? request.execution : undefined).toBeUndefined();
        expect(humanResult)
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ sessionId: 'session-a', approvedNewDirectoryCreation: true });
    });
});
