import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('refuses Run commit when requester access is revoked during its purpose account read', async () => {
  const fixture = await createAttachedManagedRunFixture({ issuedRequester: true, browserStartup: {
    resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: true } }, capabilities: {},
    }) }),
  } });
  let snapshotId: string | undefined;
  try {
    const acquired = await fixture.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId } });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Expected real Run snapshot');
    snapshotId = acquired.result.snapshotId;
    const context = { token: 'a'.repeat(43), sessionId: 'parent-session', executionRunSnapshotId: snapshotId };
    const prepared = await fixture.dispatchRequest({ v: 1, context,
      operation: { kind: 'execution_run.provider.prepare_v1', selection: { agentTargetKey: fixture.fixture.agentTargetKey,
        providerConnectionId: 'run-gateway', modelId: 'example' }, backendTarget: { kind: 'backend', backendId: fixture.fixture.agentId },
        agentId: fixture.fixture.agentId, runId: fixture.proof.executionRunId, controllerOccurrenceId: fixture.proof.executionRunOccurrenceId,
        expectedAccountSettingsScopeKey: fixture.proof.expectedAccountSettingsScopeKey } });
    expect(prepared).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.prepared', ok: true } });

    // Revoke at the authenticated Home response boundary, while retaining the
    // real requester, purpose resolver, managed source and commit validation.
    const homeRead = vi.mocked(axios.get).getMockImplementation();
    if (!homeRead) throw new Error('Expected authenticated Home transport fixture');
    let revoked = false;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const response = await homeRead(url, options);
      if (new URL(String(url)).pathname === '/v4/connect/qualified/accounts') {
        revoked = true;
        fixture.withdrawRequesterAdmission();
      }
      return response;
    });
    const revalidated = await fixture.dispatchRequest({ v: 1, context,
      operation: { kind: 'execution_run.provider.revalidate_v1' } });
    expect(revoked).toBe(true);
    expect(revalidated).toMatchObject({ ok: true, result: { kind: 'execution_run.provider.revalidated', result: { ok: false } } });
  } finally {
    if (snapshotId) await fixture.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
    await fixture.cleanup();
  }
});
