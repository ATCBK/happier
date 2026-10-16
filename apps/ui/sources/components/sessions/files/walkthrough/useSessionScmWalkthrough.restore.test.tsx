import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { renderHook, standardCleanup, createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storage');
await import('@/sync/syncEngine');
const { useSessionScmWalkthrough } = await import('./useSessionScmWalkthrough');
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
function inventory(results: ReturnType<typeof saved>[]) {
    boundary.results = Object.fromEntries(results.map(result => [result.resultId, { success: true, result }]));
    boundary.inventory = { success: true, results: results.map((result, index) => ({ cwd: '/repo/exact', sessionId,
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
    it('restores the newest valid commit proposal when its separate walkthrough failed', async () => {
        inventory([saved('newest-plan', { walkthrough: { state: 'failed', reason: 'Generation failed' }, commitPlan: proposal }, ['walkthrough', 'commitPlan']),
            saved('older-plan', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()?.savedResult?.resultId).toBe('newest-plan');
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
