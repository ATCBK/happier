import { accountSettingsParse } from '@happier-dev/protocol';
import { NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** Current Account read boundary: preferences and the independently owned channel catalog. */
export function createNotificationAccountSnapshotFixture(
  options: Partial<ActiveAccountSettingsSnapshot> & Readonly<{ channels?: readonly unknown[] }> = {},
): ActiveAccountSettingsSnapshot {
  const { channels, ...overrides } = options;
  const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: channels ?? [
    { v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {} },
  ] });
  return {
    source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey({ token: 'notification-fixture-account', encryption: null }),
    notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: record.channels },
    ...overrides,
  };
}
