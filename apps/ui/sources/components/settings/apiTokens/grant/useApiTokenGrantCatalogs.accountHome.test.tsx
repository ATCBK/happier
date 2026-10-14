import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { setApiTokenGrantAnyModel } from './apiTokenGrantDraft';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
beforeAll(async () => { await loadSyncSingletonForTests(); });
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

function catalog(modelId: string, displayName: string) {
    const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: displayName, baseUrl: 'https://grant-models.test/v1', requiresApiKey: false });
    return ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template }, role: 'named',
            displayName, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        manualModelsByConnectionId: { pc_account: [{ id: modelId, addedAt: 1 }] },
    });
}

describe('API token public model picker addressed Account', () => {
    it.each(['unselected', 'peer then removed'] as const)('reads %s Account models without a Machine or wrong-Home writes', async selection => {
        const { serverId } = await account.restore({ catalog: catalog('private-active-model', 'Private active source'),
            serverIdentityId: 'srv_api_grant_active', machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const activeCatalog = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(activeCatalog.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        let peerServerId: string | null = null;
        if (selection === 'peer then removed') {
            peerServerId = await account.addHome({ name: 'Grant peer', serverUrl: 'https://grant-peer.test',
                serverIdentityId: 'srv_api_grant_peer', accountId: 'peer-account', active: false });
            account.home.answer(peerServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: {
                status: 'present', revision: 1, content: { t: 'plain', v: catalog('addressed-peer-model', 'Addressed peer source') },
            } });
            const [{ useProviderCatalog }, { useServerCredentialAccountScopeBinding }] = await Promise.all([
                import('@/sync/store/useProviderCatalog'), import('@/sync/domains/scope/useServerCredentialAccountScopes'),
            ]);
            const peerCatalog = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(peerServerId);
                return useProviderCatalog(binding?.scope ?? null);
            });
            await waitForHomeGovernance(() => expect(peerCatalog.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
            await account.selectMachine(peerServerId, 'missing-grant-machine');
        } else {
            await account.selectMachine(serverId, null);
        }
        const { ApiTokenGrantModelsPicker } = await import('./ApiTokenGrantEditor');
        const grant = setApiTokenGrantAnyModel(API_TOKEN_FULL_GRANT_V1, false);
        const changes: typeof grant[] = [];
        const screen = await renderScreen(<ApiTokenGrantModelsPicker value={grant}
            onChange={next => { changes.push(ApiTokenGrantV1Schema.parse(next)); }} />);
        const modelId = peerServerId ? 'addressed-peer-model' : 'private-active-model';
        const row = () => screen.findAllByTestId(`api-token-grant-model:${modelId}`)
            .find(node => typeof node.props.onPress === 'function');
        await waitForHomeGovernance(() => expect(row()).toBeDefined());
        await React.act(async () => { row()!.props.onPress(); });
        expect(changes.at(-1)?.models).toEqual([{ agentTargetKey: expect.any(String), providerConnectionId: 'pc_account', modelId }]);
        if (peerServerId) {
            expect(screen.findByTestId('api-token-grant-model:private-active-model')).toBeNull();
            expect(screen.getTextContent()).not.toContain('Private active source');
            const profiles = await import('@/sync/domains/server/serverProfiles');
            await React.act(async () => { await profiles.removeServerProfile(profiles.getServerProfileById(peerServerId!)!.id); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('api-token-grant-model:addressed-peer-model')).toBeNull());
            expect(screen.findByTestId('api-token-grant-model:private-active-model')).toBeNull();
            expect(screen.getTextContent()).not.toContain('Private active source');
        }
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
            .filter(request => ProviderConnectionsRowMutationV1Schema.safeParse(request.input).success)).toEqual([]);
        expect(account.catalogMutations).toEqual([]);
        expect(rpc.state.requests).toEqual([]);
    });
});
