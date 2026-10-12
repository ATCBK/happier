import {
    CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1,
    ConnectedAccountCatalogRowMutationV1Schema,
    ConnectedPurposeCatalogV1Schema,
    openConnectedAccountCatalogContentV1,
    sealConnectedAccountCatalogContentV1,
    type ConnectedPurposeCatalogV1,
} from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** HTTP row/CAS boundary; catalog parsing, Account admission and publication stay real. */
export function createConnectedPurposeCatalogHttpBoundary(options: Readonly<{
    initialValue?: ConnectedPurposeCatalogV1;
    mode?: 'plain' | 'e2ee';
    material?: AccountScopedCryptoMaterial | null;
    settingsRequest?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}> = {}) {
    const path = `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`;
    const mode = options.mode ?? 'plain';
    const material = options.material ?? null;
    let value = ConnectedPurposeCatalogV1Schema.parse(options.initialValue ?? { v: 1, bindings: [] });
    let revision = 1;
    let content = sealConnectedAccountCatalogContentV1({ record: { key: 'purposes', value }, mode, material });
    const writes: ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>[] = [];
    return {
        path,
        writes,
        get value() { return value; },
        replace(next: ConnectedPurposeCatalogV1) {
            value = ConnectedPurposeCatalogV1Schema.parse(next);
            content = sealConnectedAccountCatalogContentV1({ record: { key: 'purposes', value }, mode, material });
            revision += 1;
        },
        async handle(url: string | URL | Request, init?: RequestInit): Promise<Response | null> {
            if (new URL(String(url)).pathname !== path) return null;
            if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content });
            const input = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            writes.push(input);
            if (input.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
            const opened = openConnectedAccountCatalogContentV1({ key: 'purposes', content: input.content, mode, material });
            if (opened.status !== 'opened' || opened.record.key !== 'purposes') throw new Error('Invalid purpose catalog write');
            let settingsVersion: number | undefined;
            if (input.settingsMutation) {
                if (!options.settingsRequest) throw new Error('Purpose mutation needs the Settings HTTP boundary');
                const response = await options.settingsRequest(new URL('/v2/account/settings', String(url)), {
                    method: 'POST', body: JSON.stringify({ expectedVersion: input.settingsMutation.expectedSettingsVersion,
                        content: input.settingsMutation.content }),
                });
                const receipt = AccountSettingsV2UpdateResponseSchema.parse(await response.json());
                if (!receipt.success) return Response.json({ status: 'settings-conflict', revision: receipt.currentVersion });
                settingsVersion = receipt.version;
            }
            value = opened.record.value;
            content = input.content;
            revision += 1;
            return Response.json({ status: 'updated', revision, cursor: revision,
                ...(settingsVersion === undefined ? {} : { settingsVersion }) });
        },
        async hydrate(scope: ServerAccountScope) {
            const { refreshConnectedAccountCatalog } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
            const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
            await refreshConnectedAccountCatalog(scope, 'purposes');
            const snapshot = getConnectedAccountCatalogValue(scope, 'purposes');
            if (snapshot.status !== 'ready' || snapshot.stale) throw new Error(`Purpose fixture unavailable: ${snapshot.reason ?? snapshot.status}`);
            return snapshot;
        },
    };
}
