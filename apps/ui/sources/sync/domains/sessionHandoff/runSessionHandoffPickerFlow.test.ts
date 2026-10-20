import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';

const openSessionHandoffPickerMock = vi.hoisted(() => vi.fn());
const executeSessionHandoffActionMock = vi.hoisted(() => vi.fn());
const releaseUserRequestLeaseMock = vi.hoisted(() => vi.fn());
const acquireUserRequestLeaseMock = vi.hoisted(() => vi.fn(() => releaseUserRequestLeaseMock));
const presentationRegisterMock = vi.hoisted(() => vi.fn());
const progressCloseMock = vi.hoisted(() => vi.fn());
const showRequestFailureMock = vi.hoisted(() => vi.fn());
const openConflictDetailsMock = vi.hoisted(() => vi.fn());
const openObservedProgressMock = vi.hoisted(() => vi.fn((_input: unknown) => ({
    close: progressCloseMock,
    isAttached: () => true,
    showRequestFailure: showRequestFailureMock,
})));
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'new-request-id'));
const routerPushMock = vi.hoisted(() => vi.fn());
const getStorageMock = vi.hoisted(() => vi.fn(() => ({
    getState: () => ({ profileScope: { serverId: 'server', accountId: 'account' } }),
})));

vi.mock('@/components/sessions/handoff/openSessionHandoffPicker', () => ({
    openSessionHandoffPicker: (...args: unknown[]) => openSessionHandoffPickerMock(...args),
}));
vi.mock('./executeSessionHandoffAction', () => ({
    executeSessionHandoffAction: (...args: unknown[]) => executeSessionHandoffActionMock(...args),
}));
vi.mock('@/sync/sync', () => ({
    sync: { acquireUserRequestLease: acquireUserRequestLeaseMock },
}));
vi.mock('@/components/inbox/actionOperations/actionOperationPresentationRuntime', () => ({
    actionOperationPresentationCoordinator: { register: presentationRegisterMock },
}));
vi.mock('@/components/sessions/handoff/openSessionHandoffProgressModal', () => ({
    openObservedSessionHandoffProgressModal: (input: unknown) => openObservedProgressMock(input),
}));
vi.mock('@/components/workspaces/sync/openWorkspaceSyncRelationshipDetails', () => ({
    openWorkspaceSyncConflictDetails: (resource: unknown) => openConflictDetailsMock(resource),
}));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: randomUUIDMock }));
vi.mock('expo-router', () => ({ router: { push: routerPushMock } }));
vi.mock('@/sync/domains/state/storageStore', () => ({ getStorage: getStorageMock }));

const policyFields = {
    v: 1 as const,
    selection: 'git_worktree' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
};
const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
const completedStatus = {
    handoffId: 'handoff_1',
    status: 'completed' as const,
    phase: 'finalizing' as const,
    recoveryActions: [],
};
const completedResult = (workspace: { kind: 'none' } | {
    kind: 'relationship'; relationshipId: string; created: boolean;
    cleanupWarning?: { code: string; message: string };
} = { kind: 'none' as const }) => ({
    ok: true as const,
    result: { handoffId: 'handoff_1', status: completedStatus, workspace },
});

describe('runSessionHandoffPickerFlow', () => {
    beforeEach(() => {
        openSessionHandoffPickerMock.mockReset();
        executeSessionHandoffActionMock.mockReset();
        acquireUserRequestLeaseMock.mockClear();
        releaseUserRequestLeaseMock.mockClear();
        presentationRegisterMock.mockReset();
        progressCloseMock.mockReset();
        showRequestFailureMock.mockReset();
        openConflictDetailsMock.mockReset();
        openObservedProgressMock.mockClear();
        randomUUIDMock.mockClear();
        routerPushMock.mockClear();
    });

    it('keeps an unavailable source out of the picker and transfer admission', async () => {
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
            availability: { available: false, reason: 'runtime_direct_peer_unavailable' },
        })).resolves.toBeNull();
        expect(openSessionHandoffPickerMock).not.toHaveBeenCalled();
        expect(acquireUserRequestLeaseMock).not.toHaveBeenCalled();
    });

    it('keeps deferred approval out of operation progress and opens its exact artifact', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({ targetMachineId: 'target', workspaceAction: { kind: 'none' } });
        executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: true, kind: 'approval_required', artifactId: 'approval-1' });
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual({ ok: true, kind: 'approval_required', artifactId: 'approval-1' });
        expect(openObservedProgressMock).not.toHaveBeenCalled();
        expect(routerPushMock).toHaveBeenCalledWith('/inbox/approvals/approval-1?serverId=server');
    });

    it('shows awaiting admission on the retained picker until the request resolves', async () => {
        let resolveExecution!: (value: ReturnType<typeof completedResult>) => void;
        executeSessionHandoffActionMock.mockImplementationOnce(() => new Promise((resolve) => { resolveExecution = resolve; }));
        const setAwaitingAdmission = vi.fn();
        openSessionHandoffPickerMock.mockImplementationOnce(async (input) => {
            input.onRetained(vi.fn(), setAwaitingAdmission, () => true, vi.fn());
            return { targetMachineId: 'target', workspaceAction: { kind: 'none' } };
        });
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        const flow = runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });
        await vi.waitFor(() => expect(executeSessionHandoffActionMock).toHaveBeenCalledOnce());
        expect(setAwaitingAdmission).toHaveBeenCalledWith(true);
        expect(openObservedProgressMock).not.toHaveBeenCalled();
        resolveExecution(completedResult({ kind: 'relationship', relationshipId: 'relationship-1', created: true }));
        await flow;
        expect(setAwaitingAdmission).toHaveBeenCalledWith(false);
        expect(openObservedProgressMock).toHaveBeenCalledOnce();
    });

    it('does not reopen progress after the picker is deliberately dismissed before admission', async () => {
        let resolveExecution!: (value: ReturnType<typeof completedResult>) => void;
        executeSessionHandoffActionMock.mockImplementationOnce(() => new Promise((resolve) => { resolveExecution = resolve; }));
        let pickerOpen = true;
        openSessionHandoffPickerMock.mockImplementationOnce(async (input) => {
            input.onRetained(() => { pickerOpen = false; }, vi.fn(), () => pickerOpen, vi.fn());
            return { targetMachineId: 'target', workspaceAction: { kind: 'none' } };
        });
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const flow = runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });
        await vi.waitFor(() => expect(executeSessionHandoffActionMock).toHaveBeenCalledOnce());
        pickerOpen = false;
        resolveExecution(completedResult({ kind: 'relationship', relationshipId: 'relationship-1', created: true }));
        await flow;
        expect(openObservedProgressMock).not.toHaveBeenCalled();
    });

    it('keeps a newly selected destination separate from an existing recoverable operation', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', targetPath: '/target/repo',
            workspaceAction: { kind: 'copy_once', contentPolicy },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const operationStore = {
            subscribe: () => () => {},
            getSnapshot: () => ({
                operationsByKey: new Map([['operation', {
                    serverId: 'server',
                    snapshot: {
                        version: 1, operationId: 'operation-1', revision: 3,
                        actionId: 'session.handoff', state: 'running',
                        scope: { accountId: 'account', machineId: 'source', sessionId: 'sess_1' },
                        title: 'Handoff', requestId: 'retained-request-id', createdAt: 1,
                        startedAt: 2, cancellation: 'supported',
                    },
                }]]),
            }),
        };
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server',
            placement: 'session_info', operationStore: operationStore as never,
        });

        expect(randomUUIDMock).toHaveBeenCalledOnce();
        expect(executeSessionHandoffActionMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({ actionRequestId: 'new-request-id' }),
        }));
        expect(openObservedProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'new-request-id',
        }));
    });

    it('returns null when the picker is dismissed', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce(null);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        })).resolves.toBeNull();
        expect(executeSessionHandoffActionMock).not.toHaveBeenCalled();
    });

    it('submits relationship creation intent without generating identity or writing settings', async () => {
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy, flushBeforeCommit: true as const };
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', targetPath: '/target/repo', sourceRootPath: '/source/repo',
            targetSessionStorageMode: 'persisted', workspaceAction,
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const execute = vi.fn();
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute, sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_action_menu',
        });

        expect(executeSessionHandoffActionMock).toHaveBeenCalledWith(expect.objectContaining({
            execute,
            sessionId: 'sess_1',
            targetMachineId: 'target',
            targetPath: '/target/repo',
            workspaceAction,
        }));
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });

    it('submits an ordinary active-session handoff without a second generic confirmation', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target',
            targetSessionStorageMode: 'persisted',
            workspaceAction: { kind: 'none' },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_active', sourceMachineId: 'source', serverId: 'server', placement: 'session_action_menu',
        });

        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });

    it('opens one live progress surface and registers the same surface for active-operation reentry', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target',
            targetSessionStorageMode: 'persisted',
            workspaceAction: { kind: 'none' },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });

        expect(openObservedProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: expect.any(String),
            sessionId: 'sess_1',
            workspaceSyncEnabled: false,
        }));
        expect(presentationRegisterMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: expect.any(String),
            onStart: 'current',
            origin: expect.objectContaining({ resolve: expect.any(Function) }),
        }));
        const registration = presentationRegisterMock.mock.calls[0]?.[0];
        const running = { state: 'running' } as const;
        const succeeded = { state: 'succeeded' } as const;
        const reopen = registration.origin.resolve(running);
        expect(reopen).toEqual(expect.any(Function));
        reopen();
        expect(openObservedProgressMock).toHaveBeenCalledTimes(1);
        expect(registration.origin.resolve(succeeded)).toBeNull();
        expect(progressCloseMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the single mirror confirmation to the daemon-bound Action approval', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target-id',
            targetMachineLabel: 'Build Mac',
            targetPath: '/target/repo',
            sourceRootPath: '/source/repo',
            workspaceAction: {
                kind: 'create_relationship',
                mode: 'mirror_exactly',
                contentPolicy,
                flushBeforeCommit: true,
            },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const execute = vi.fn();
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute, sessionId: 'sess_1', sourceMachineId: 'source-id', serverId: 'server', placement: 'session_info',
        });

        // The destination approval is stamped by the target daemon inside the
        // Action corridor, so the picker must not raise its own unbound prompt.
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
        expect(executeSessionHandoffActionMock).toHaveBeenCalledWith(expect.objectContaining({
            execute,
            targetMachineId: 'target-id',
            targetPath: '/target/repo',
            workspaceAction: expect.objectContaining({ mode: 'mirror_exactly' }),
        }));
        expect(executeSessionHandoffActionMock.mock.calls[0]?.[0]?.workspaceAction)
            .not.toHaveProperty('destructiveTargetReuseApproved');
    });

    it('confirms the daemon-owned committed workspace outcome on the same progress surface', async () => {
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy, flushBeforeCommit: true as const };
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', targetPath: '/target/repo', workspaceAction,
        });
        const workspace = {
            kind: 'relationship' as const,
            relationshipId: 'relationship-1',
            created: true,
            cleanupWarning: { code: 'staging_release_failed', message: 'Staging could not be released.' },
        };
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult(workspace));
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        const result = await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });

        expect(result).toEqual(completedResult(workspace));
        expect(progressCloseMock).not.toHaveBeenCalled();
    });

    it('closes the progress surface when the daemon reports no workspace outcome', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', workspaceAction: { kind: 'none' },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });

        expect(progressCloseMock).toHaveBeenCalledTimes(1);
    });

    it('shows admission failure without claiming an observed operation', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({ targetMachineId: 'target', workspaceAction: { kind: 'none' } });
        executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: false, error: 'target_unavailable' });
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual({ ok: false, error: 'target_unavailable' });

        expect(openObservedProgressMock).toHaveBeenCalledOnce();
        expect(showRequestFailureMock).toHaveBeenCalledWith({ ok: false, error: 'target_unavailable' });
    });

    it('opens the same set from a validated blocked link and returns to the retained picker without dispatch', async () => {
        const closePicker = vi.fn();
        const resource = { kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'workspace-a',
            workspaceRefId: 'workspace-c', controllerMachineId: 'machine-a', serverId: 'server' };
        openSessionHandoffPickerMock.mockImplementationOnce(async (params: { onRetained: (close: () => void, setAwaiting: (awaiting: boolean) => void, isOpen: () => boolean, setInlineError: (code: string | null) => void) => void }) => {
            params.onRetained(closePicker, vi.fn(), () => true, vi.fn());
            return { targetMachineId: 'machine-b', targetPath: '/target', workspaceAction: { kind: 'linked_workspace' },
                workspaceSyncReviewResource: resource, workspaceSyncReviewRelationshipIds: ['a-c', 'a-b'] };
        });
        const failure = { ok: false as const, error: 'blocked', errorCode: 'workspace_sync_partial_route_blocked',
            workspacePreparation: { ok: false as const, errorCode: 'relationship_conflicted', completed: [], blockedRelationshipId: 'a-b' } };
        executeSessionHandoffActionMock.mockResolvedValueOnce(failure);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'machine-c', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual(failure);
        expect(showRequestFailureMock).toHaveBeenCalledWith(failure);
        const progressArgs = openObservedProgressMock.mock.calls[0]?.[0] as {
            onOpenConflicts: (id: string) => void; onDismiss: () => void;
        };
        progressArgs.onOpenConflicts('a-b');
        expect(openConflictDetailsMock).toHaveBeenCalledWith({ ...resource, initialRelationshipId: 'a-b' });
        progressArgs.onDismiss();
        expect(closePicker).not.toHaveBeenCalled();
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });

    it('shows an immediate linked-route failure without claiming an unverified blocked link', async () => {
        const resource = { kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'workspace-a',
            workspaceRefId: 'workspace-c', controllerMachineId: 'machine-a', serverId: 'server' };
        openSessionHandoffPickerMock.mockResolvedValueOnce({ targetMachineId: 'machine-b',
            workspaceAction: { kind: 'linked_workspace' }, workspaceSyncReviewResource: resource,
            workspaceSyncReviewRelationshipIds: ['a-c', 'a-b'] });
        const failure = { ok: false as const, error: 'unavailable', errorCode: 'workspace_sync_unavailable' };
        executeSessionHandoffActionMock.mockResolvedValueOnce(failure);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        await runSessionHandoffPickerFlow({ execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'machine-c',
            serverId: 'server', placement: 'session_info' });
        expect(showRequestFailureMock).toHaveBeenCalledWith(failure);
        const progressArgs = openObservedProgressMock.mock.calls[0]?.[0] as { onOpenConflicts: (id: string | null) => void };
        progressArgs.onOpenConflicts(null);
        expect(openConflictDetailsMock).toHaveBeenCalledWith(resource);
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });
});
