import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { AuthContextType } from '@/auth/context/AuthContext';
import type { ServerFetch } from '@/sync/http/client';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('@/sync/ops/actions/defaultActionExecutor');
const { createScmDiffSummarySavedResultOperations } = await import('./savedResultOperations');
const listed = { success: true as const, results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved', revision: 1,
  comparisonId: 'comparison', source: { kind: 'workingTree' as const }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
  sevenDayCost: { status: 'unavailable' as const, pricedRunCount: 0, unpricedRunCount: 1, sinceMs: 0, untilMs: 1 } };
const input = { results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved', expectedRevision: 1, comparisonId: 'comparison' }] };
const savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'saved', revision: 1, canUndo: false,
  output: { success: true, resultId: 'saved', revision: 1, sourceKey: 'comparison', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
    requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation' } } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } } } });
async function addHome() {
  return harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
}
beforeEach(async () => { rpc.mockReset(); await harness.reset(); });
afterEach(() => standardCleanup());

describe('machine saved result operations', () => {
  it('requests narrow restoration separately from settings usage through the real Action schema', async () => {
    const requests: unknown[] = [];
    const actionExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ scmActionExecute: async ({ input }) => {
      requests.push(input);
      return listed;
    } }));
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', shouldContinue: () => true, actionExecutor });
    const query = { cwd: '/repo', sessionId: 'session', comparisons: [
      { comparisonId: 'comparison', source: { kind: 'workingTree' as const }, outputs: ['walkthrough' as const] },
    ] };
    expect(await ops.list({ query })).toMatchObject({ success: true });
    expect(await ops.list({ includeUsage: true })).toMatchObject({ success: true });
    expect(requests).toEqual([{ query }, { includeUsage: true }]);
  });
  it('preserves a disabled Clear outcome before machine deletion', async () => {
    const actionExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionEnabled: () => false,
      scmActionExecute: async () => { throw new Error('Disabled Clear reached Machine transport'); } }));
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', shouldContinue: () => true, actionExecutor });
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'action_disabled' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('clears through API-token Action authority without requiring personal Account marks', async () => {
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const previous = getCurrentAuth();
    setCurrentAuth({ isAuthenticated: true, credentials: { token: 'api-token' }, credentialAuthorityKind: 'api_token',
      login: async () => ({ kind: 'completed' }), loginWithCredentials: async () => ({ kind: 'completed' }), logout: async () => ({ kind: 'completed' }),
      refreshFromActiveServer: async () => {} } satisfies AuthContextType);
    try {
      const serverId = await addHome();
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      // An API token enters the signed Home Action API, not the native Account/Machine adapter.
      const request: ServerFetch = async (path, init) => {
        expect(path).toBe('/v1/actions/scm.diffSummary.result.clear');
        expect(JSON.parse(String(init?.body))).toMatchObject({ v: 1, target: { kind: 'machine', machineId: 'machine' }, input });
        return new Response(JSON.stringify({ v: 1, actionId: 'scm.diffSummary.result.clear', execution: { ok: true,
          result: { success: true, deleted: [{ success: true, resultId: 'saved', comparisonId: 'comparison' }], failures: [] } } }));
      };
      const actionExecutor = createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: 'machine' } } });
      const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true, actionExecutor });
      const cleared = await ops.clear(input);
      expect(cleared, JSON.stringify(cleared)).toMatchObject({ success: true, deleted: [{ resultId: 'saved' }] });
      expect(harness.requestsFor('/v1/kv')).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    } finally { setCurrentAuth(previous); }
  });
  it('deletes saved narration without touching Account content, while keeping revision and application guards', async () => {
    const serverId = await addHome();
    let current = savedResult; let saved = true; let deletionRefused = false; let deletes = 0;
    rpc.mockImplementation(async ({ method }) => {
      if (method === 'scm.diffSummary.result.read') return { success: true, result: current };
      if (method === 'scm.diffSummary.result.list') return saved ? listed : { ...listed, results: [], count: 0, bytes: 0 };
      if (method === 'scm.diffSummary.result.clear') {
        if (deletionRefused) return { success: true, deleted: [], failures: [{ success: false, resultId: 'saved', errorCode: 'revision_conflict', error: 'A newer edit won', latestRevision: 2 }] };
        deletes++; saved = false;
        return { success: true, deleted: [{ success: true, resultId: 'saved', comparisonId: 'comparison' }], failures: [] };
      }
      throw new Error('Unexpected machine operation');
    });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [{ resultId: 'saved' }], failures: [] });
    expect(await ops.list()).toMatchObject({ success: true, count: 0 });
    expect(harness.requestsFor('/v1/kv')).toEqual([]);
    current = ScmDiffSummaryResultSchema.parse({ ...savedResult, revision: 2, output: { ...savedResult.output, revision: 2 } });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict', latestRevision: 2 }] });
    current = ScmDiffSummaryResultSchema.parse({ ...savedResult, application: { acceptedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo', expectedHeadOid: null, expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
      status: 'applying', steps: [], nextGroupIndex: 0, stopAfterCurrent: false } });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'application_locked' }] });
    current = savedResult; deletionRefused = true;
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict' }] });
    expect(deletes).toBe(1);
    expect(harness.requestsFor('/v1/kv')).toEqual([]);
  });
  it('reports unavailable and retired inventory without claiming zero saved results', async () => {
    let current = true; const serverId = await addHome();
    rpc.mockImplementation(async () => { throw new Error('Owning Machine offline'); });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => current });
    expect(await ops.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    rpc.mockImplementation(async () => { current = false; return listed; });
    expect(await ops.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });
  it('uses shared Action approval before deletion', async () => {
    const serverId = await addHome(); await harness.requireUiApproval(serverId, 'scm.diffSummary.result.clear');
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(rpc).not.toHaveBeenCalled(); expect(harness.requestsFor('/v1/kv')).toEqual([]);
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
  });
});
