import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';

// Adversarial-review probe (ui-action-callers-execute-review). The caller's own designed
// destructive confirmation plus the executor's in-place default confirmation must not both
// open for one person decision. Only the confirmation dialog and Machine RPC are faked.
const confirm = vi.hoisted(() => vi.fn(async () => true));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      confirmResult: true,
      spies: { confirm },
    }).module,
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
  }),
);

describe('git index-lock recovery confirmation', () => {
  beforeEach(async () => {
    await harness.reset();
    const serverId = await harness.addHome({
      name: 'SCM Home',
      serverUrl: 'https://scm.example',
      accountId: 'account-b',
      serverIdentityId: 'srv_scm',
      currentAccount: true,
    });
    const scope = {
      serverId: resolveServerProfileScopeIdForIdentifier(serverId),
      accountId: 'account-b',
    };
    storage.setState({ settingsScope: scope, profileScope: scope });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  });
  afterEach(() => {
    confirm.mockClear();
    machineRpcWithServerScopeMock.mockReset();
    standardCleanup();
  });

  it('asks the person once before removing a stale index lock', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      success: true,
      removed: true,
      reason: 'removed',
      lockPath: '/repo/.git/index.lock',
    });
    const { machineScmRepositoryRemoveIndexLock } =
      await import('@/sync/ops/scm/machineScm');
    const { runScmOperationWithGitIndexLockRecovery } =
      await import('./gitIndexLockRecovery');

    await runScmOperationWithGitIndexLockRecovery({
      cwd: '/repo',
      failedResponse: {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INDEX_LOCKED,
        error: 'index.lock exists',
      },
      removeIndexLock: (request) =>
        machineScmRepositoryRemoveIndexLock('machine-1', request) as never,
      retryOriginalOperation: async () => ({ success: true }),
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
