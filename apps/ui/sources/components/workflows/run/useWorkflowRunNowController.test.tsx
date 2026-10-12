import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import type { WorkflowRunNowRequest } from './useWorkflowRunNowController';

const executeMock = vi.hoisted(() => vi.fn<(
    request: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0],
) => Promise<unknown>>());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(executeMock);
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
let homeA: string;
let homeB: string;

function startInput(index = 0) {
    return WorkflowRunStartRequestV1Schema.parse(executeMock.mock.calls[index]?.[0].payload);
}

function setAccountScope(scope: { serverId: string; accountId: string } | null): void {
    // Model the host reset using the real lifetime owner, not a fake generation.
    retireActiveServerAccountScopeLifetime();
    const serverId = scope?.serverId === 'server-b' ? homeB : homeA;
    if (scope) setActiveServerId(serverId);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), scope !== null);
    storage.setState({ profileScope: scope ? { ...scope, serverId } : null });
}

/** The one Run UUID the caller allocates for an explicit admission attempt. */
const RUN_ID = '00000000-0000-4000-8000-000000000001';

// Not `as const`: the canonical ingress request takes mutable arrays, and a
// readonly literal would only be assignable through a cast.
const source: WorkflowRunNowRequest['source'] = {
    kind: 'inline',
    definition: { blocks: ['Do the thing'] },
};

function admitted(admission: 'created' | 'existing') {
    return {
        run: createWorkflowRunSummaryFixture({ id: RUN_ID, ownerAccountId: 'account-a', origin: { kind: 'direct' } }),
        admission,
    };
}

describe('useWorkflowRunNowController', () => {
    it('admits the reviewed role overrides rather than silently using the Account roles', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        const roleOverrides = [{ roleId: 'builder', runsAs: { kind: 'background_run' as const, intent: 'delegate' as const } }];
        await act(async () => {
            await hook.getCurrent().runNow({ runId: RUN_ID, source, roleOverrides });
        });
        expect(executeMock.mock.calls[0]?.[0].payload).toMatchObject({ roleOverrides });
    });
    beforeEach(async () => {
        homeA = await homes.addHome({ name: 'A', serverUrl: 'https://workflow-a.test', accountId: 'account-a', currentAccount: true });
        homeB = await homes.addHome({ name: 'B', serverUrl: 'https://workflow-b.test', accountId: 'account-b', currentAccount: true, active: false });
        homes.answer(homeA, '/v1/features', { body: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: true } } }) });
        setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        storage.setState({ workflowRunsById: {}, machines: { 'machine-1': createMachineFixture({ activeAt: 0 }) } });
    });

    afterEach(() => {
        vi.useRealTimers();
        executeMock.mockReset();
        modalAlertSpy.mockClear();
        setAccountScope(null);
        storage.setState({ workflowRunsById: {} });
        homes.reset();
        standardCleanup();
    });

    it('returns the exact admitted handle and stores that Run by its own runId', async () => {
        vi.useFakeTimers();
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let outcome: Awaited<ReturnType<ReturnType<typeof useWorkflowRunNowController>['runNow']>>;
        await act(async () => {
            outcome = await hook.getCurrent().runNow({ runId: RUN_ID, source, metadata: { title: 'Frozen title' } });
        });

        expect(outcome!?.run.id).toBe(RUN_ID);
        expect(outcome!?.admission).toBe('created');
        expect(executeMock.mock.calls[0]?.[0].method).toBe('workflow.run.start');
        expect(startInput().runId).toBe(RUN_ID);
        expect(executeMock.mock.calls[0]?.[0].payload).toMatchObject({ metadata: { title: 'Frozen title' } });
        // The admitted Run reaches the one Account-scoped row map keyed by runId,
        // so the exact route can open it without any list being loaded.
        expect(storage.getState().workflowRunsById[RUN_ID]?.summary?.id).toBe(RUN_ID);
        expect(storage.getState().workflowRunsById[RUN_ID]?.metadata)
            .toEqual({ kind: 'available', value: { title: 'Frozen title' } });
        // An acknowledgement is command state, not a Run state.
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('acknowledged');
        await act(async () => {
            vi.advanceTimersByTime(2_500);
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });

    it('owns an ordinary start identity until admission settles, then permits a new explicit start', async () => {
        const reply = createDeferred<unknown>();
        executeMock.mockImplementation(async ({ payload }) =>
            WorkflowRunStartRequestV1Schema.parse(payload).runId === RUN_ID ? admitted('created') : reply.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        let first!: Promise<unknown>;
        await act(async () => { first = hook.getCurrent().runNow({ source }); });
        const firstId = startInput().runId;
        expect(firstId).toBeTypeOf('string');
        expect(hook.getCurrent().pendingRunId).toBe(firstId);
        await act(async () => { expect(await hook.getCurrent().runNow({ source })).toBeNull(); });
        expect(executeMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            reply.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: firstId, ownerAccountId: 'account-a', origin: { kind: 'direct' } }) });
            await first;
        });
        expect(hook.getCurrent().pendingRunId).toBeNull();
        executeMock.mockImplementation(async ({ payload }) => ({
            admission: 'created', run: createWorkflowRunSummaryFixture({ id: WorkflowRunStartRequestV1Schema.parse(payload).runId, ownerAccountId: 'account-a', origin: { kind: 'direct' } }) }));
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        expect(startInput(1).runId).not.toBe(firstId);
    });

    it('releases its owned identity after a confirmed refusal without affecting explicit recovery IDs', async () => {
        executeMock.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Confirmed not sent' });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        const refusedId = startInput().runId;
        expect(hook.getCurrent().pendingRunId).toBeNull();
        await act(async () => { await hook.getCurrent().runNow({ source }); });
        expect(startInput(1).runId).not.toBe(refusedId);
        await act(async () => { await hook.getCurrent().runNow({ runId: RUN_ID, source }); });
        expect(startInput(2).runId).toBe(RUN_ID);
    });

    it('keeps a known refusal for the composer instead of interrupting with an alert', async () => {
        executeMock.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Confirmed not sent' });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        await act(async () => { await hook.getCurrent().runNow({ source, refusal: 'inline' }); });
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().refusal?.message).toBe('workflows.problem.targetUnavailable');
        // A new press is a new attempt: the previous reason does not outlive it.
        executeMock.mockResolvedValue(admitted('created'));
        await act(async () => { await hook.getCurrent().runNow({ runId: RUN_ID, source, refusal: 'inline' }); });
        expect(hook.getCurrent().refusal).toBeNull();
    });

    it('settles a proved unsent setup failure as a typed refusal without waiting for a missing Run', async () => {
        const { markRpcRequestDisposition } = await import('@happier-dev/sync-client');
        executeMock.mockRejectedValueOnce(markRpcRequestDisposition(
            Object.assign(new Error('Machine setup failed'), { code: 'MACHINE_RPC_TIMEOUT' }),
            'notSent',
        ));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        await act(async () => {
            expect(await hook.getCurrent().runNow({ source, refusal: 'inline' })).toBeNull();
        });
        const runId = startInput().runId;
        expect(hook.getCurrent().pendingRunId).toBeNull();
        expect(hook.getCurrent().isPending(runId)).toBe(false);
        expect(hook.getCurrent().refusal?.code).toBe('target_unavailable');
        expect(homes.requests.filter((request) => request.path === '/v3/automations/runs/workflow-storage')).toHaveLength(0);
        expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it('stamps the selected project into host context rather than Action input', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        const project = {
            machineId: 'machine-1',
            directory: '/repo/project',
            workspaceRefId: 'workspace-1',
            // Run-again starts from an accepted descriptor. These historical
            // facts are not part of a new ExternalActionTarget.
            checkoutRootPath: '/repo',
            checkout: { kind: 'git_worktree' as const, branchName: 'old-run' },
        };

        await act(async () => {
            await hook.getCurrent().runNow({ runId: RUN_ID, source, project });
        });

        expect(executeMock.mock.calls[0]?.[0].payload).toEqual({
            v: 1, kind: 'targeted_action_rpc',
            input: { runId: RUN_ID, source }, target: {
                kind: 'machine', machineId: project.machineId,
                project: {
                    machineId: project.machineId,
                    directory: project.directory,
                    workspaceRefId: project.workspaceRefId,
                },
            },
        });
    });

    it('retires an unresolved admission observer when its Account changes', async () => {
        vi.useFakeTimers();
        // The real Action owner classifies a lost network reply as unresolved;
        // its subsequent exact-Run observation is Account HTTP, not another RPC.
        executeMock.mockRejectedValueOnce(new Error('response lost'));
        homes.answer(homeA, '/v3/automations/runs/workflow-storage', { status: 404, body: { error: 'run_not_found' } });
        const observations = () => homes.requests.filter((request) => request.path === '/v3/automations/runs/workflow-storage');
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());
        let pending!: Promise<unknown>;
        await act(async () => {
            pending = hook.getCurrent().runNow({ source });
        });
        const runId = startInput().runId;
        expect(hook.getCurrent().pendingRunId).toBe(runId);
        expect(hook.getCurrent().stateFor(runId)).toBe('reconciling');
        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(observations()).toHaveLength(1);
        expect(observations()[0]?.input).toMatchObject({ runId });
        await act(async () => {
            vi.advanceTimersByTime(60_000);
            publishHomeAccountChange(homeA, ['workflow-run:another-run']);
        });
        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(observations()).toHaveLength(1);
        await act(async () => { setAccountScope({ serverId: 'server-b', accountId: 'account-b' }); await pending; });
        expect(hook.getCurrent().pendingRunId).toBeNull();
        publishHomeAccountChange(homeA, [`workflow-run:${runId}`]);
        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(observations()).toHaveLength(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(storage.getState().workflowRunsById[runId]).toBeUndefined();
    });

    it('does not dispatch twice while one admission is still in flight', async () => {
        const request = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(request.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let first!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().runNow({ runId: RUN_ID, source });
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

        await act(async () => {
            expect(await hook.getCurrent().runNow({ runId: RUN_ID, source })).toBeNull();
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            request.resolve(admitted('created'));
            await first;
        });
    });

    it('retires a result whose Account scope changed between dispatch and response', async () => {
        const request = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(request.promise);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let invocation!: Promise<unknown>;
        await act(async () => {
            invocation = hook.getCurrent().runNow({ runId: RUN_ID, source });
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

        await act(async () => { setAccountScope({ serverId: 'server-b', accountId: 'account-b' }); });
        let outcome: unknown;
        await act(async () => {
            request.resolve(admitted('created'));
            outcome = await invocation;
        });

        // No navigation handle and no row: another Account's session must not be
        // shown this Run, and no error is surfaced for a retired command.
        expect(outcome).toBeNull();
        expect(storage.getState().workflowRunsById[RUN_ID]).toBeUndefined();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await act(async () => {
            setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });

    it('rejects a malformed admission response instead of navigating to it', async () => {
        // A partially migrated owner answering with a Run body but no admission.
        executeMock.mockResolvedValueOnce({
            run: createWorkflowRunSummaryFixture({ id: RUN_ID, ownerAccountId: 'account-a' }),
        });
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        let outcome: unknown;
        await act(async () => {
            outcome = await hook.getCurrent().runNow({ runId: RUN_ID, source });
        });

        expect(outcome).toBeNull();
        expect(storage.getState().workflowRunsById[RUN_ID]).toBeUndefined();
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });

    it('sends declared inputs and the originating-session completion choice with the admission', async () => {
        executeMock.mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            await hook.getCurrent().runNow({
                runId: RUN_ID,
                source,
                inputs: { branch: 'main' },
                onComplete: { kind: 'originating_session' },
            });
        });

        expect(executeMock.mock.calls[0]?.[0].payload).toEqual({
            runId: RUN_ID,
            source,
            inputs: { branch: 'main' },
            onComplete: { kind: 'originating_session' },
        });
    });

    it('preserves an explicit Run execution target while omitting the default Session target', async () => {
        executeMock
            .mockResolvedValueOnce(admitted('created'))
            .mockResolvedValueOnce(admitted('created'));
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            await hook.getCurrent().runNow({
                runId: RUN_ID,
                source,
                executionTarget: { kind: 'detached_run' },
            });
            await hook.getCurrent().runNow({
                runId: '00000000-0000-4000-8000-000000000002',
                source,
                executionTarget: { kind: 'session' },
            });
        });

        expect(executeMock.mock.calls[0]?.[0].payload).toEqual({
            runId: RUN_ID,
            source,
            executionTarget: { kind: 'detached_run' },
        });
        expect(executeMock.mock.calls[1]?.[0].payload).not.toHaveProperty('executionTarget');
    });

    it('does not dispatch without an active Account', async () => {
        setAccountScope(null);
        const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
        const hook = await renderHook(() => useWorkflowRunNowController());

        await act(async () => {
            expect(await hook.getCurrent().runNow({ runId: RUN_ID, source })).toBeNull();
        });

        expect(executeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    });
});
