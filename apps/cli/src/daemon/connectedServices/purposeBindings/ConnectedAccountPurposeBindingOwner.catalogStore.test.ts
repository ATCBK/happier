import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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

  it('does not wake purpose readers for unrelated catalog publications, but keeps binding and authority changes live', () => {
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    let wakes = 0;
    const subscription = createActiveAccountSettingsConnectedAccountPurposeBindingStore().subscribe(() => { wakes += 1; });
    const update = (patch: Partial<NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>>) => {
      const current = getActiveAccountSettingsSnapshot()!;
      setActiveAccountSettingsSnapshot({ ...current, ...patch, settingsVersion: current.settingsVersion + 1 });
    };
    try {
      // These independent catalogs do not change purpose intent, configuration,
      // referenced material or the Account lifetime. A wake starts fresh reads.
      for (let index = 0; index < 8; index += 1) {
        update({ profileCatalog: { status: 'loading' }, promptLibraryCatalog: { status: 'loading' } });
      }
      expect(wakes).toBe(0);

      update({ connectedPurposeCatalog: { status: 'ready', revision: 4,
        record: { key: 'purposes', value: { v: 1, bindings: [] } } } });
      expect(wakes).toBe(1);
      update({ connectedConfigurationCatalog: { status: 'loading' } });
      expect(wakes).toBe(2);
      update({ savedSecretResources: [] });
      expect(wakes).toBe(3);
      update({ settings: accountSettingsParse({ secrets: [] }), rawSettings: { secrets: [] } });
      expect(wakes).toBe(4);
      update({ settingsSecretsReadKeys: [new Uint8Array([1])] });
      expect(wakes).toBe(5);
      update({ scopeKey: 'replacement-account' });
      expect(wakes).toBe(6);
    } finally {
      subscription.dispose();
    }
    update({ connectedPurposeCatalog: { status: 'loading' } });
    expect(wakes).toBe(6);
  });

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
