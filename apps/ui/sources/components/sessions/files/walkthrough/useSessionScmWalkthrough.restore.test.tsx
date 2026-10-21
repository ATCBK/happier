import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ScmComparisonSchema, ScmDiffSummaryResultSchema, type ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const boundary = vi.hoisted(() => ({ inventory: null as unknown, results: {} as Record<string, unknown>, reads: [] as string[] }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Only authenticated Machine RPC leaves the process; restoration and result state stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; payload: unknown }) => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return boundary.inventory;
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) {
            const id = (request.payload as { resultId: string }).resultId;
            boundary.reads.push(id);
            return boundary.results[id];
        }
        throw new Error(`Unexpected machine boundary: ${request.method}`);
    };
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
const { renderHook, standardCleanup, createSessionFixture, createMachineFixture, createDeferred } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storage');
await import('@/sync/syncEngine');
const { useSessionScmWalkthrough, useScmWalkthroughState } = await import('./useSessionScmWalkthrough');
const { useMachinePresenceSummary } = await import('@/components/sessions/model/useMachinePresenceSummary');
const { retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
let serverId: string;
const accountId = 'restore-account';
const sessionId = 'restore-session';
const comparison = ScmComparisonSchema.parse({ id: 'same-comparison', source: { kind: 'workingTree' },
    repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
const reading = { state: 'complete', value: { title: 'Published reading', intro: '', stops: [], otherChangeRefs: [] } };
const proposal = { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } };
function saved(resultId: string, outputs: unknown, requestedOutputs: ScmDiffSummaryOutputKind[]) {
    return ScmDiffSummaryResultSchema.parse({ resultId, revision: 1, canUndo: false,
        output: { success: true, resultId, revision: 1, sourceKey: comparison.id,
            metadata: { sourceKey: comparison.id, source: comparison.source }, comparison, requestedOutputs, outputs,
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
}
function inventory(results: ReturnType<typeof saved>[], sessionScoped = true) {
    boundary.results = Object.fromEntries(results.map(result => [result.resultId, { success: true, result }]));
    boundary.inventory = { success: true, results: results.map((result, index) => ({ cwd: '/repo/exact', ...(sessionScoped ? { sessionId } : {}),
        resultId: result.resultId, revision: result.revision, comparisonId: comparison.id, source: comparison.source,
        bytes: 1, updatedAtMs: results.length - index })), count: results.length, bytes: results.length,
        sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: results.length } };
}
beforeEach(async () => {
    boundary.reads = [];
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Restore', serverUrl: 'https://restore.example.test', accountId });
    const machine = createMachineFixture({ id: 'restore-machine', activeAt: Date.now() });
    const session = createSessionFixture({ id: sessionId, serverId, active: true,
        metadata: { path: '/repo/exact', host: 'test.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
});
afterEach(async () => {
    standardCleanup();
    retireScmDiffSummaryScope({ serverId, accountId });
    await homes.reset();
});

describe('saved output restoration', () => {
    it('keeps hydrated captured evidence through Home revalidation', async () => {
        const { useCapturedScmComparison } = await import('../comparison/useCapturedScmComparison');
        const observed: Array<unknown> = [];
        const hook = await renderHook(() => {
            const value = useCapturedScmComparison({ host: { sessionId }, serverId,
                machine: { machineId: 'restore-machine', basePath: '/repo/exact' },
                identity: { machineId: 'restore-machine', basePath: '/repo/exact' },
                comparison: { kind: 'workingTree', comparisonId: comparison.id }, knownComparison: comparison });
            observed.push(value.comparison);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().comparison).toEqual(comparison));
        const previous = hook.getCurrent().comparison;
        observed.length = 0;
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await upsertServerProfile({ serverUrl: 'https://restore.example.test', name: 'Reconnected' }); });
        expect(hook.getCurrent().comparison).toBe(previous);
        expect(observed.every(value => value === previous)).toBe(true);
    });
    it('retains hydrated readings through Home profile revalidation, but clears them on Account replacement', async () => {
        inventory([saved('kept-reading', { walkthrough: reading }, ['walkthrough'])]);
        const observations: Array<string | null | undefined> = [];
        const hook = await renderHook(() => {
            const value = useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId);
            observations.push(value.viewModel?.resultId);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('kept-reading'));
        const original = hook.getCurrent().viewModel;
        observations.length = 0;
        boundary.inventory = { success: false, errorCode: 'result_unavailable', error: 'Transport reconnecting' };
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await upsertServerProfile({ serverUrl: 'https://restore.example.test', name: 'Reconnected Home' }); });
        expect(hook.getCurrent().viewModel).toBe(original);
        expect(observations.every(id => id === 'kept-reading')).toBe(true);
        await act(async () => { await homes.switchAccount(serverId, 'replacement-account'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel).toBeNull());
    });
    it.each(['walkthrough', 'commitPlan'] as const)('settles an ambiguous Session target as unavailable for %s and recovers when its target resolves', async output => {
        inventory([]);
        const session = createSessionFixture({ id: sessionId, serverId, active: false,
            metadata: { path: '/repo/exact', host: 'shared.local' } });
        const machines = ['one', 'two'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, host: 'shared.local' } }));
        getStorage().setState({ sessions: {}, machines: {}, machineListByServerId: { [serverId]: null },
            machineListStatusByServerId: { [serverId]: 'loading' } });
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, output, serverId));
        expect(hook.getCurrent().restoreState).toBe('restoring');
        await act(async () => { getStorage().setState({ sessions: { [sessionId]: session },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [serverId]: machines },
            machineListStatusByServerId: { [serverId]: 'idle' } }); });
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'unavailable' });
        expect(boundary.reads).toEqual([]);
        await act(async () => { hook.getCurrent().retryRestore(); });
        expect(hook.getCurrent().restoreState).toBe('unavailable');
        await act(async () => { getStorage().setState({ machines: { [machines[0]!.id]: machines[0]! },
            machineListByServerId: { [serverId]: [machines[0]!] } }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
    });
    it('keeps a known offline machine distinct from unknown presence without reading it', async () => {
        inventory([]);
        const machine = createMachineFixture({ id: 'restore-machine', active: false, activeAt: 1 });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId));
        expect(hook.getCurrent().restoreState).toBe('unavailable');
        expect(boundary.reads).toEqual([]);
    });
    it.each(['session', 'machine'] as const)('reads saved %s output with unknown presence, and retains it as presence flaps', async kind => {
        inventory([saved('unknown-presence', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])], kind === 'session');
        getStorage().setState({ machines: {}, machineListByServerId: { [serverId]: [] } });
        const host = kind === 'session' ? { sessionId } : { machineId: 'restore-machine', cwd: '/repo/exact' };
        const target = { kind: 'workingTree' as const };
        const hook = await renderHook(() => ({ ...useScmWalkthroughState(host, { ...target }, 'walkthrough', serverId),
            presence: useMachinePresenceSummary(serverId, 'restore-machine') }));
        expect(hook.getCurrent().presence.reachability).toBe('unknown');
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('unknown-presence'));
        const original = hook.getCurrent().viewModel;
        const offline = createMachineFixture({ id: 'restore-machine', active: false, activeAt: 1 });
        await act(async () => { getStorage().setState({ machines: { [offline.id]: offline }, machineListByServerId: { [serverId]: [offline] } }); });
        expect(hook.getCurrent().presence.reachability).toBe('unreachable');
        expect(hook.getCurrent().viewModel).toBe(original);
        await act(async () => { getStorage().setState({ machines: {}, machineListByServerId: { [serverId]: [] } }); });
        await hook.rerender();
        expect(hook.getCurrent().presence.reachability).toBe('unknown');
        expect(hook.getCurrent().viewModel).toBe(original);
        expect(hook.getCurrent().restoreState).toBe('ready');
    });

    it('keeps unknown output restoring until its saved read settles, then restores or confirms empty', async () => {
        inventory([saved('pending-read', { commitPlan: proposal }, ['commitPlan'])]);
        const read = createDeferred<unknown>();
        boundary.results['pending-read'] = read.promise;
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'commitPlan', serverId));
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'restoring' });
        await waitForHomeGovernance(() => expect(boundary.reads).toContain('pending-read'));
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'restoring' });
        await act(async () => { read.resolve({ success: true, result: saved('pending-read', { commitPlan: proposal }, ['commitPlan']) }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('pending-read'));
        expect(hook.getCurrent().restoreState).toBe('ready');
        await hook.rerender();
        const empty = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'commit', commit: 'other' }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(empty.getCurrent().restoreState).toBe('ready'));
        expect(empty.getCurrent().viewModel).toBeNull();
    });

    it('does not call a failed saved inventory an empty result', async () => {
        boundary.inventory = { success: false, errorCode: 'result_unavailable', error: 'Private diagnostic' };
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('unavailable'));
        expect(hook.getCurrent().viewModel).toBeNull();
        inventory([]);
        await act(async () => { hook.getCurrent().retryRestore(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
    });
    it('restores the newest valid commit proposal when its separate walkthrough failed', async () => {
        inventory([saved('newest-plan', { walkthrough: { state: 'failed', reason: 'Generation failed' }, commitPlan: proposal }, ['walkthrough', 'commitPlan']),
            saved('older-plan', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()?.savedResult?.resultId).toBe('newest-plan');
        expect(hook.getCurrent()).toMatchObject({ status: 'succeeded', error: null });
    });
    it('skips a newer result that does not contain the requested output', async () => {
        inventory([saved('newest-summary', { summary: { state: 'complete', value: { summaryMarkdown: 'Summary only' } } }, ['summary']),
            saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('older-reading'));
    });
    it.each(['failed', 'cancelled'] as const)('retains a published requested output over a content-less %s attempt', async state => {
        inventory([saved('newest-attempt', { walkthrough: { state, reason: 'Stopped' } }, ['walkthrough']), saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('older-reading'));
    });
    it('shows the latest failed requested attempt when no usable requested output exists', async () => {
        inventory([saved('unrelated-plan', { commitPlan: proposal }, ['commitPlan']),
            saved('newest-attempt', { walkthrough: { state: 'failed', reason: 'Stopped' } }, ['walkthrough']),
            saved('older-writing', { walkthrough: { state: 'writing' } }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('newest-attempt'));
    });
    it('keeps an in-progress requested output ahead of an older publication', async () => {
        inventory([saved('writing', { walkthrough: { state: 'writing' } }, ['walkthrough']), saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('writing'));
    });
    it('restarts restoration when the requested output changes while neither output is loaded', async () => {
        inventory([saved('reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook((output: ScmDiffSummaryOutputKind) => useSessionScmWalkthrough(sessionId,
            { kind: 'workingTree', comparisonId: comparison.id }, output, serverId), { initialProps: 'commitPlan' });
        await waitForHomeGovernance(() => expect(boundary.reads).toContain('reading'));
        await hook.rerender('walkthrough');
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('reading'));
    });
    it('keeps the newest proposal and the published reading when both consumers share the store', async () => {
        inventory([saved('newest-plan', { walkthrough: { state: 'failed', reason: 'Stopped' }, commitPlan: proposal }, ['walkthrough', 'commitPlan']),
            saved('older-plan', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])]);
        const target = { kind: 'workingTree' as const, comparisonId: comparison.id };
        const hook = await renderHook(() => ({
            plan: useSessionScmWalkthrough(sessionId, target, 'commitPlan', serverId),
            reading: useSessionScmWalkthrough(sessionId, target, 'walkthrough', serverId),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().reading?.outputs?.walkthrough?.value).toBeDefined());
        expect(hook.getCurrent().plan?.savedResult?.resultId).toBe('newest-plan');
        expect(hook.getCurrent().reading?.savedResult?.resultId).toBe('older-plan');
    });
});
