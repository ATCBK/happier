import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createProviderEnforcedPermissionHandler } from './createHandler';
import { createMutableApiSessionClientFixture, type MutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ServerBoundPermissionRpcHandlerManager } from '../testkit/serverBoundPermissionRpcHandlerManager';
import { accountSettingsParse } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshotLifetimeToken,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const sessions: MutableApiSessionClientFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  clearActiveAccountSettingsSnapshot();
});

function createSession(flush = async () => {}) {
  const scopeKey = resolveAccountSettingsScopeKey({ token: 'permission-factory-account', encryption: null });
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
  commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    catalog: { status: 'ready', rows: [{ revision: 1,
      record: { key: 'role-overrides', value: { v: 1, overrides: {} } } }], tombstones: [], diagnostics: [] } });
  const session = createMutableApiSessionClientFixture({ sessionId: 'permission-factory', overrides: { flush } });
  sessions.push(session);
  const rpc = new ServerBoundPermissionRpcHandlerManager(session.sessionId);
  // The server-stamped permission response is the authenticated transport boundary.
  vi.spyOn(session.rpcHandlerManager, 'registerHandler').mockImplementation((name, handler) => rpc.registerHandler(name, handler));
  return { session, rpc };
}

describe('createProviderEnforcedPermissionHandler', () => {
  it('creates a provider-enforced handler with optional safe-tool plugins', async () => {
    const { session, rpc } = createSession();
    const handler = createProviderEnforcedPermissionHandler({
      session,
      logPrefix: '[TestProvider]',
      alwaysAutoApproveToolNameIncludes: ['geminireasoning'],
    });

    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-2', 'geminireasoning', {})).resolves.toEqual({ decision: 'approved' });

    const pending = handler.handleToolCall('pending-1', 'Edit', {});
    await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.requests?.['pending-1']).toBeTruthy());
    await rpc.handlers.get('permission')?.({ id: 'pending-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('exposes typed pending permission abort and flush support', async () => {
    let flushCount = 0;
    const { session } = createSession(async () => {
      flushCount += 1;
    });

    const handler = createProviderEnforcedPermissionHandler({
      session,
      logPrefix: '[TestProvider]',
    });
    const acpHandler: AcpPermissionHandler = handler;

    const pending = acpHandler.handleToolCall('pending-1', 'Edit', {});
    await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.requests?.['pending-1']).toBeTruthy());

    expect(acpHandler.abortPendingRequestsAndFlush).toBeTypeOf('function');
    if (!acpHandler.abortPendingRequestsAndFlush) throw new Error('abortPendingRequestsAndFlush is not exposed');
    await expect(acpHandler.abortPendingRequestsAndFlush('ACP runtime turn ended')).resolves.toBeUndefined();

    await expect(pending).rejects.toThrow('ACP runtime turn ended');
    expect(session.getAgentStateSnapshot()?.requests?.['pending-1']).toBeUndefined();
    expect(session.getAgentStateSnapshot()?.completedRequests?.['pending-1']).toMatchObject({
      status: 'canceled',
      reason: 'ACP runtime turn ended',
    });
    expect(flushCount).toBe(1);
  });
});
