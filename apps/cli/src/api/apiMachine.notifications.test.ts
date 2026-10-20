import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import * as persistence from '@/persistence';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from './apiMachine';
import { createExecutionRunAccountSettingsSnapshotResolver } from './machine/resolveExecutionRunAccountSettingsSnapshot';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ChangesResponseSchema } from './changes';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

describe('ApiMachine notification catalog lifecycle', () => {
  it.each(['unavailable', 'cancelled', 'retired'] as const)('captured MCP %s preserves the Machine notification boundary', async failure => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'true');
    const previous = getActiveAccountSettingsSnapshot();
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-followers' })).toString('base64url')}.signature`, encryption: null };
    const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const readCursor = vi.spyOn(persistence, 'readAccountChangesCursor').mockResolvedValue(0);
    const writeCursor = vi.spyOn(persistence, 'writeAccountChangesCursor').mockResolvedValue(undefined);
    let failed = false;
    let failedRefreshRead = false;
    let ownerCurrent = true;
    const controller = new AbortController();
    const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'mcp-machine', serverHttpBaseUrl: 'https://machine-mcp.test',
      readCredentials: async () => credentials, isOwnerCurrent: () => ownerCurrent, onSettings() {} });
    // Only HTTP and credential/cursor persistence are substituted. The real
    // captured resolver, Machine changes owner and notification loader execute.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (input) => {
      const target = new URL(String(input));
      const path = target.pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'mcp-machine-followers' } };
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 7,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (path === '/v1/account/entity-rows/mcp') {
        if (failed && !failedRefreshRead) {
          failedRefreshRead = true;
          if (failure === 'cancelled') controller.abort(new Error('Machine catch-up cancelled'));
          if (failure === 'retired') ownerCurrent = false;
          return { status: 503, data: {} };
        }
        return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } } };
      }
      if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: { status: 'deleted', revision: 2 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/changes') return { status: 200, data: ChangesResponseSchema.parse({ changes: [
        { cursor: 1, kind: 'account', entityId: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, changedAt: 1, hint: { mcpServerCatalog: true, revision: 2 } },
        { cursor: 2, kind: 'account', entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, changedAt: 1, hint: { notificationChannels: true, revision: 2 } },
        { cursor: 3, kind: 'session', entityId: 'pending-session', changedAt: 1, hint: { pendingActivationRequestId: 'pending-request', pendingVersion: 1 } },
      ], nextCursor: 3 }) };
      throw new Error(`Unexpected Machine MCP boundary: ${path}`);
    });
    const client = runWithServerHttpBaseUrl('https://machine-mcp.test', () => new ApiMachineClient(credentials.token, { id: 'mcp-machine', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }));
    const pending = vi.fn();
    client.onPendingSessionActivationHint(pending);
    try {
      await resolver({ mcpServerCatalog: true });
      const captured = resolver.readOperationContext();
      // Observe the existing private owner without a production testing API.
      Reflect.set(client, 'executionRunAccountSnapshots', resolver);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: runWithServerHttpBaseUrl('https://machine-mcp.test', () => resolveAccountSettingsScopeKeyForToken(credentials.token)),
        notificationChannelCatalog: { status: 'ready', revision: 1, channels: [], diagnostics: [] } });
      failed = true;
      const sync = () => runWithServerHttpBaseUrl('https://machine-mcp.test', () =>
        (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }, signal: AbortSignal): Promise<void> })
          .syncChangesOnConnect({ reason: 'live' }, controller.signal));
      if (failure === 'unavailable') {
        await sync();
        expect(captured?.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
        expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'ready', revision: 2 });
        expect(pending).toHaveBeenCalledWith({ sessionId: 'pending-session', requestId: 'pending-request', pendingVersion: 1, source: 'changes' });
        expect(writeCursor).toHaveBeenCalledWith('mcp-machine-followers', 3);
      } else {
        await expect(sync()).rejects.toMatchObject(failure === 'retired' ? { code: 'provider_authorization_changed' } : { message: 'Machine catch-up cancelled' });
        expect(pending).not.toHaveBeenCalled();
        expect(writeCursor).not.toHaveBeenCalled();
        expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ revision: 1 });
        if (failure === 'retired') {
          expect(captured?.readSnapshot()).toBeNull();
          await sync();
          expect(pending).toHaveBeenCalledWith({ sessionId: 'pending-session', requestId: 'pending-request', pendingVersion: 1, source: 'changes' });
          expect(writeCursor).toHaveBeenCalledWith('mcp-machine-followers', 3);
        }
      }
    } finally {
      await client.shutdown(); await resolver.dispose(); get.mockRestore(); stored.mockRestore(); readCursor.mockRestore(); writeCursor.mockRestore(); vi.unstubAllEnvs();
      clearActiveAccountSettingsSnapshot(); if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });
  it('reopens notification channels on their row-only Account hint without advancing preferences', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'notification-row-account' })).toString('base64url')}.signature`, encryption: null };
    const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const readCursor = vi.spyOn(persistence, 'readAccountChangesCursor').mockResolvedValue(0);
    const writeCursor = vi.spyOn(persistence, 'writeAccountChangesCursor').mockResolvedValue(undefined);
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1, settingsVersion: 7,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      notificationChannelCatalog: { status: 'ready', revision: 1, channels: [], diagnostics: [] } });
    // Only HTTP and device-local credential/cursor persistence are substituted.
    // The Machine catch-up, catalog loader, mode admission and publication stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'notification-row-account' } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: { status: 'deleted', revision: 2 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v2/changes') return { status: 200, data: { changes: [{ cursor: 4, kind: 'account',
        entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, changedAt: 1, hint: { notificationChannels: true, revision: 2 } }], nextCursor: 4 } };
      throw new Error(`Unexpected notification observer boundary: ${path}`);
    });
    const machine: Machine = { id: 'notification-row-machine', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient(credentials.token, machine);
    const settingsHint = vi.fn();
    client.onAccountSettingsVersionHint(settingsHint);
    try {
      await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
      expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'ready', revision: 2, channels: [] });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
      expect(settingsHint).not.toHaveBeenCalled();
    } finally {
      await client.shutdown(); get.mockRestore(); stored.mockRestore(); readCursor.mockRestore(); writeCursor.mockRestore();
      clearActiveAccountSettingsSnapshot();
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });
});
