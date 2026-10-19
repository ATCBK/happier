import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';

const token = 'connected-catalog-account';
const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
const service = { pluginId: 'happier.connected-account.test', localId: 'api' };

function mockHomeConfigurationRow(row: unknown, status = 200) {
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/connected-accounts/configurations')) return { status, data: row };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 5, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
}

describe('connected service configuration catalog materialization', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('opens the exact qualified service and authentication mode from the row without a Settings mirror', async () => {
    const entry = { service, modeId: 'api-key', revision: 'configuration-9', values: { endpoint: 'https://api.example.test' }, secretRefs: {} };
    mockHomeConfigurationRow({ status: 'present', revision: 4,
      content: { t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [entry] } } } });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'ready', revision: 4, record: { key: 'configurations', value: { v: 1, entries: [entry] } } } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).resolves.toEqual({
      revision: entry.revision, values: entry.values, secretRefs: {},
    });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'oauth' })).resolves.toBeNull();
  });

  it('refuses unavailable configuration rather than treating a configured service as unconfigured', async () => {
    mockHomeConfigurationRow({ error: 'unavailable' }, 503);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).rejects.toMatchObject({
      code: 'connected_account_configuration_persistence_unavailable',
    });
  });

  it('never materializes the safe display projection of a partial configuration row', async () => {
    const entry = { service, modeId: 'api-key', revision: 'display-only', values: { endpoint: 'https://api.example.test' }, secretRefs: {} };
    mockHomeConfigurationRow({ status: 'present', revision: 4,
      content: { t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [entry, { malformed: true }] } } } });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'partial', authority: 'active', revision: 4,
        record: { key: 'configurations', value: { v: 1, entries: [entry] } },
        diagnostics: [{ path: 'entries[1]', reason: 'invalid-stored-content' }] } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).rejects.toMatchObject({
      code: 'connected_account_configuration_persistence_unavailable',
    });
  });
});
