import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import { AccountSettingsPersistedObjectSchema } from './accountSettingsPersistedObject.js';
import { readRetainedConnectedAccountCatalogRecordV1 } from '../../connect/connectedAccountCatalogV1.js';
import { ConnectedAccountCatalogRowMutationV1Schema } from '../../connect/connectedAccountConfigurationRowsV1.js';

describe('connected-account purpose binding settings', () => {
  it('keeps purpose intent in its retained source and admitted row rather than effective Settings', () => {
    expect(accountSettingsParse({})).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    expect(readRetainedConnectedAccountCatalogRecordV1({}, 'purposes')).toEqual({
      status: 'ready', record: { key: 'purposes', value: { v: 1, bindings: [] } },
    });

    const raw = AccountSettingsPersistedObjectSchema.parse({
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'happier.agent.test', localId: 'runtime' },
            purpose: 'model-request',
          },
          target: {
            kind: 'group',
            service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
            groupId: 'fallbacks',
          },
        }],
      },
    });
    expect(accountSettingsParse(raw)).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    const retained = readRetainedConnectedAccountCatalogRecordV1(raw, 'purposes');
    expect(retained).toEqual({ status: 'ready', record: {
      key: 'purposes', value: raw.connectedAccountPurposeBindingsV1,
    } });
    if (retained.status !== 'ready') throw new Error('Expected qualified purpose source');
    expect(ConnectedAccountCatalogRowMutationV1Schema.parse({
      expectedRevision: 'absent', sourceSettingsVersion: 1,
      content: { t: 'plain', v: retained.record },
    }).content).toEqual({ t: 'plain', v: retained.record });
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({
      expectedRevision: 'absent', sourceSettingsVersion: 1,
      content: { t: 'plain', v: { ...retained.record, value: { v: 1, bindings: [{
        purpose: { consumer: { pluginId: 'happier.agent.test', localId: 'runtime' }, purpose: 'model-request' },
        target: { kind: 'group', service: { pluginId: 'happier.connected-account.test', localId: 'subscription' }, groupId: '' },
      }] } } },
    }).success).toBe(false);
  });
});
