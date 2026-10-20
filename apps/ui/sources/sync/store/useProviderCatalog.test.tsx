import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useProviderCatalog } = await import('./useProviderCatalog');
const { useProviderSettings } = await import('@/providers/hooks/useProviderSettings');
const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Provider catalog observation', () => {
    it('settles real catalog listeners without restarting demand on equivalent scopes or refresh publications', async () => {
        const scope = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [] });
        let reads = 0;
        account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => {
                reads += 1;
                // Stop a repeated demand at the genuine HTTP boundary, preserving a finite RED.
                if (reads > 2) throw new Error('Unrequested Provider catalog reread');
                return { body: { status: 'present', revision: 1,
                    content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
            },
        });
        const hook = await renderHook(() => {
            const requested = { serverId: scope.serverId, accountId: scope.accountId };
            return { catalog: useProviderCatalog(requested), settings: useProviderSettings(requested) };
        });
        await vi.waitFor(() => expect(hook.getCurrent().catalog).toMatchObject({ status: 'ready', revision: 1, stale: false }));
        const first = hook.getCurrent();
        await hook.rerender();
        expect(hook.getCurrent().catalog).toBe(first.catalog);
        expect(hook.getCurrent().settings).toBe(first.settings);
        expect(reads).toBe(1);
        await act(async () => { await refreshProviderCatalog(scope); });
        expect(hook.getCurrent().catalog).toMatchObject({ status: 'ready', revision: 1, stale: false });
        expect(hook.getCurrent().catalog?.data).toBe(first.catalog?.data);
        expect(hook.getCurrent().settings).toBe(first.settings);
        expect(reads).toBe(2);
    });
});
