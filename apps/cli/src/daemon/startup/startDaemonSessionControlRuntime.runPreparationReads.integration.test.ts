import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('shares requester observations within each Run authority read and rechecks authority after preparation', async () => {
  let runReads = 0;
  let withdrawDuringRunRead = () => {};
  const fixture = await createAttachedManagedRunFixture({ issuedRequester: true, coldProviderCatalog: true,
    resolveRunAuthority: request => {
      runReads++;
      withdrawDuringRunRead();
      return { status: 'current', executionRunId: request.executionRunId, occurrenceId: request.expectedOccurrenceId,
        parentSessionId: 'parent-session', intent: 'review', runtimeState: 'idle', teamCredentialProviderModel: null };
    },
    browserStartup: { resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: true } }, capabilities: {},
    }) }) } });
  let snapshotId: string | undefined;
  const readCounts = () => {
    const paths = vi.mocked(axios.get).mock.calls.map(([url]) => new URL(String(url)).pathname);
    return { profile: paths.filter(path => path.endsWith('/profile')).length,
      catalog: paths.filter(path => path === '/v1/account/entity-rows/provider-connections').length,
      history: paths.filter(path => path === '/v2/account/settings/history').length };
  };
  try {
    const acquired = await fixture.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId } });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Expected real Run snapshot');
    snapshotId = acquired.result.snapshotId;
    const before = readCounts();
    const prepared = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.prepare_v1', selection: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: 'run-gateway', modelId: 'example' }, backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
        agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId, controllerOccurrenceId: fixture.proof.executionRunOccurrenceId,
        expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
    expect(prepared, JSON.stringify({ prepared, source: fixture.sourceDiagnostics })).toMatchObject({
      ok: true, result: { kind: 'execution_run.provider.prepared', ok: true } });
    const after = readCounts();
    // Thirteen Run witnesses each retain a fresh entry and post-RPC fence.
    // The two Account-context acquisitions each share their nested read.
    // Before this correction these same phases issued 86 Profile reads.
    expect({ profile: after.profile - before.profile, catalog: after.catalog - before.catalog,
      history: after.history - before.history, runReads }).toEqual({ profile: 71, catalog: 1, history: 0, runReads: 13 });
    // Revocation during the RPC must defeat its otherwise-current Run answer,
    // not just the next request after the preparation checkpoint has ended.
    withdrawDuringRunRead = fixture.withdrawRequesterAdmission;
    const revalidated = await fixture.dispatchRequest({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId },
      operation: { kind: 'execution_run.provider.revalidate_v1' } });
    expect(revalidated).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.revalidated', result: { ok: false } } });
    expect(runReads).toBeGreaterThan(13);
  } finally {
    if (snapshotId) await fixture.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
    await fixture.cleanup();
  }
});
