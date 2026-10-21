import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const rpc = vi.hoisted(() => vi.fn());
// Remote Machine RPC is the process/network boundary. Action admission and task codecs remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
// This Machine task never uses recipient-envelope preparation; avoid that unrelated native import graph.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
  const unused = () => { throw new Error('Home restart reached the recipient-envelope API'); };
  return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
    prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI connected Machine Home restart Action', () => {
  beforeEach(async () => { await harness.reset(); rpc.mockReset(); });
  afterEach(() => standardCleanup());

  it.each([
    [{ enabled: true }, 'ready'],
    [{ enabled: false, reason: 'indexing' }, 'indexing'],
    [{ enabled: false, reason: 'index_unavailable' }, 'unavailable'],
    [undefined, 'unknown'],
  ] as const)('reads search readiness from the addressed Home feature owner (%s)', async (homeSearch, searchReadiness) => {
    const serverId = await harness.addHome({ name: 'Search Home', serverUrl: 'https://readiness.test', accountId: 'alice' });
    harness.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({ capabilities: {
      ...(homeSearch ? { homeSearch } : {}),
    } }) });
    expect(await createDefaultActionExecutor().execute('home.runtime.get', { force: true }, {
      surface: 'ui', serverId, expectedAccountId: 'alice',
    })).toMatchObject({ ok: true, result: { status: 'ready', searchReadiness } });
  });

  it('keeps an Agent restart request in canonical approval before dispatching a system task', async () => {
    const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://approval-restart.test', accountId: 'alice' });
    let settled = false;
    const result = createDefaultActionExecutor().execute('home.runtime.restart', { machineId: 'machine' }, {
      surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'alice', actionRequestId: 'restart-approval',
    }).then(outcome => { settled = true; return outcome; });
    const artifacts = harness.artifacts(serverId);
    await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
    const artifactId = artifacts.list()[0]!.id;
    const request = StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
    expect(request).toMatchObject({ status: 'open', actionId: 'home.runtime.restart',
      actionArgs: { machineId: 'machine' }, approval: { flow: 'blocking', result: 'required' } });
    await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1));
    expect(settled).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' }, {
      surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice',
    })).toMatchObject({ ok: true });
    expect(await result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rebuilds the captured Personal Home index and refuses an unexpected success body', async () => {
    const serverId = await harness.addHome({ name: 'Index Home', serverUrl: 'https://index.test', accountId: 'alice' });
    harness.answer(serverId, '/v1/home/search/rebuild', { body: { ok: true } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice',
      presentUserConfirmation: { actionId: 'home.search.rebuild' as const } };
    expect(await createDefaultActionExecutor().execute('home.search.rebuild', {}, context))
      .toEqual({ ok: true, result: { ok: true } });
    harness.answer(serverId, '/v1/home/search/rebuild', { body: { ok: false } });
    expect(await createDefaultActionExecutor().execute('home.search.rebuild', {}, context)).toMatchObject({ ok: false });
  });

  it('keeps an admitted restart pending until its exact task terminates in the captured Home', async () => {
    const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://restart.test', accountId: 'alice' });
    const terminal = { protocolVersion: 1, taskId: 'restart-task', ok: false, error: { code: 'restart_failed', message: 'Restart failed' } };
    let finish!: (value: unknown) => void;
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const task = new Promise<unknown>(resolve => { finish = resolve; });
    rpc.mockImplementation(async ({ method, payload }) => {
      if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
        'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true,
          kinds: ['relay.runtime.restart.v1'], methods: ['start', 'wait'] } },
      } };
      if (payload.method === 'start') return { ok: true, result: { taskId: terminal.taskId } };
      return { ok: true, result: await task };
    });
    let settled = false;
    const signal = new AbortController().signal;
    const action = createDefaultActionExecutor().execute('home.runtime.restart', { machineId: 'machine', channel: 'preview' }, {
      surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice', signal,
      presentUserConfirmation: { actionId: 'home.runtime.restart' },
      operationAcceptance: { operationId: 'restart', accept: admitted },
    }).then(value => { settled = true; return value; });
    const initial = await Promise.race([admission.then(() => 'admitted' as const), action]);
    expect(initial).toBe('admitted');
    expect(settled).toBe(false);
    await harness.addHome({ name: 'Other', serverUrl: 'https://other.test', accountId: 'bob' });
    finish(terminal);
    expect(await action).toEqual({ ok: true, result: { status: 'completed', taskId: terminal.taskId, result: terminal } });
    expect(rpc.mock.calls.map(([request]) => ({ serverId: request.serverId, accountId: request.accountId,
      machineId: request.machineId, method: request.method }))).toEqual([
      { serverId, accountId: 'alice', machineId: 'machine', method: 'capabilities.detect' },
      { serverId, accountId: 'alice', machineId: 'machine', method: 'capabilities.invoke' },
      { serverId, accountId: 'alice', machineId: 'machine', method: 'capabilities.invoke' },
    ]);
    // Every Machine request runs under a cancellation signal derived from the caller's (merged with the
    // captured Account lifetime), never an unbounded one.
    for (const [request] of rpc.mock.calls) expect(request.signal).toBeInstanceOf(AbortSignal);
  });
});
