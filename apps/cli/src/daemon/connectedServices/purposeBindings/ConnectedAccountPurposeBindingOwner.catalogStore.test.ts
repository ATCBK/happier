import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import * as persistence from '@/persistence';

const purpose = { consumer: { pluginId: 'happier.voice.test', localId: 'speech' }, purpose: 'voice-api' };
const service = { pluginId: 'happier.connected-account.test', localId: 'api' };
const value = { v: 1 as const, bindings: [{ purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected' } } }] };

function publish(catalog: ConnectedAccountCatalogSnapshotV1) {
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'captured-account',
    ...{ connectedPurposeCatalog: catalog } });
}

describe('connected purpose catalog store', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('refuses cached purpose truth when credentials for revalidation are unavailable', async () => {
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore().read()).rejects.toMatchObject({
      code: 'plugin_connected_account_settings_unavailable', details: { reason: 'credentials-unavailable' },
    });
  });

  it('refuses unavailable purpose truth instead of authorizing an empty default', async () => {
    publish({ status: 'unavailable', reason: 'account-mode-mismatch' });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore().read()).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
  });
});
