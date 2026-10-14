import { describe, expect, it } from 'vitest';
import {
    ConnectedAccountCatalogRowMutationResponseV1Schema,
    sealConnectedAccountCatalogContentV1,
} from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { AccountSettingsV2UpdateResponse } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createConnectedPurposeCatalogHttpBoundary } from './connectedAccountCatalogBoundary';

describe('Connected Purpose catalog HTTP fixture Settings receipts', () => {
    const updated = { v: 1 as const, bindings: [], teamResourceSelections: [] };
    const mutation = () => ({ method: 'POST', body: JSON.stringify({ expectedRevision: 1,
        content: sealConnectedAccountCatalogContentV1({ record: { key: 'purposes', value: updated }, mode: 'plain', material: null }),
        settingsMutation: { expectedSettingsVersion: 1, content: { t: 'plain', v: {} } },
    }) });

    it('reports a genuine Settings CAS conflict without publishing the catalog write', async () => {
        const boundary = createConnectedPurposeCatalogHttpBoundary({ settingsRequest: async () => Response.json({
            success: false, error: 'version-mismatch', currentVersion: 7, currentContent: null,
        } satisfies AccountSettingsV2UpdateResponse) });
        const response = await boundary.handle(`https://home.test${boundary.path}`, mutation());
        expect(ConnectedAccountCatalogRowMutationResponseV1Schema.parse(await response!.json()))
            .toEqual({ status: 'settings-conflict', revision: 7 });
        expect(boundary.value).toEqual({ v: 1, bindings: [] });
    });

    it.each([
        { success: false, error: 'profile-transfer-mismatch', currentProfileTransferRevision: 7 },
        { success: false, error: 'invalid', reason: 'tooLarge' },
    ] satisfies AccountSettingsV2UpdateResponse[])('refuses to fabricate a Settings revision for $error', async receipt => {
        const boundary = createConnectedPurposeCatalogHttpBoundary({ settingsRequest: async () => Response.json(receipt) });
        await expect(boundary.handle(`https://home.test${boundary.path}`, mutation())).rejects.toThrow();
        expect(boundary.value).toEqual({ v: 1, bindings: [] });
    });
});
