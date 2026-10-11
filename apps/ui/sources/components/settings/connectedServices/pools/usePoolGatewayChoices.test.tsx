import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary,
    renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { usePoolGatewayChoices } from './usePoolGatewayChoices';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const target = { kind: 'group' as const, service, groupId: 'pool-a' };

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

describe('pool gateway Action wiring', () => {
    it('refuses active Account slot writes and a captured callback when the selected Home becomes foreign or removed', async () => {
        const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway] };
        await account.restore({ catalog, serverIdentityId: 'srv_pool_active', machines: [],
            waivedActions: ['providers.connections.update'] });
        const hook = await renderHook(() => {
            const providerTarget = useProviderSettingsTarget();
            return usePoolGatewayChoices({ target, enabled: true, resolveTarget: providerTarget.resolveCurrentTarget,
                accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });
        });
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        const capturedSetEnabled = hook.getCurrent().setEnabled;
        const peerServerId = await account.addHome({ name: 'Foreign pool Home', serverUrl: 'https://foreign-pool.test',
            serverIdentityId: 'srv_pool_foreign', accountId: 'peer-account', active: false });
        await act(async () => { await account.selectMachine(peerServerId, 'missing-peer-machine'); });
        await hook.rerender();
        expect(hook.getCurrent().ready).toBe(false);
        expect(hook.getCurrent().choices).toEqual([]);
        await act(async () => { expect(await capturedSetEnabled(gateway.id, true)).toBe(false); });
        await expect(hook.getCurrent().setEnabled(gateway.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await profiles.removeServerProfile(profiles.getServerProfileById(peerServerId)!.id); });
        await hook.rerender();
        expect(hook.getCurrent().ready).toBe(false);
        expect(hook.getCurrent().choices).toEqual([]);
        await expect(hook.getCurrent().setEnabled(gateway.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(account.catalogMutations).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(rpc.state.requests).toEqual([]);
    });
    it.each(['none', 'offline'] as const)('writes the Account slot with %s machine availability despite an unrelated unavailable declaration', async availability => {
        const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        const unavailable = ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_unavailable',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' }, purposeBindingDefaults: {} });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway, unavailable] });
        await account.restore({ catalog, serverIdentityId: 'srv_pool_active', machines: availability === 'offline'
            ? [createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 })] : [],
            waivedActions: ['providers.connections.update'] });
        if (availability === 'offline') await account.selectMachine(account.serverId, 'machine-a');
        const hook = await renderHook(() => {
            const providerTarget = useProviderSettingsTarget();
            return usePoolGatewayChoices({ target, enabled: true, resolveTarget: providerTarget.resolveCurrentTarget,
                accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });
        });
        await vi.waitFor(() => expect(hook.getCurrent().choices).toHaveLength(1));
        expect(hook.getCurrent().ready).toBe(true);
        await act(async () => { expect(await hook.getCurrent().setEnabled(gateway.id, true)).toBe(true); });
        let row = account.readCatalogRow();
        expect(row?.revision).toBe(2);
        if (row?.content?.t !== 'plain') throw new Error('Expected Plain Account slot write');
        expect(row.content.v.connections[0]?.purposeBindingDefaults?.['openai-upstream']).toEqual(target);
        expect(row.content.v.connections[0]?.revision).toBe(4);
        expect(row.content.v.connections[1]).toEqual(unavailable);
        await act(async () => { expect(await hook.getCurrent().setEnabled(gateway.id, false)).toBe(true); });
        row = account.readCatalogRow();
        expect(row?.revision).toBe(3);
        if (row?.content?.t !== 'plain') throw new Error('Expected Plain Account slot write');
        expect(row.content.v.connections[0]?.purposeBindingDefaults).toEqual({});
        expect(account.catalogMutations.map(mutation => mutation.expectedRevision)).toEqual([1, 2]);
        expect(rpc.state.requests).toEqual([]);
    });
    it('does not offer slots from an unavailable Gateway declaration', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        await account.restore({ catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] },
            waivedActions: ['providers.connections.update'] });
        const hook = await renderHook(() => {
            const providerTarget = useProviderSettingsTarget();
            return usePoolGatewayChoices({ target, enabled: true, resolveTarget: providerTarget.resolveCurrentTarget,
                accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });
        });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().choices).toEqual([]);
        await expect(hook.getCurrent().setEnabled(saved.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(account.catalogMutations).toEqual([]);
        expect(rpc.state.requests).toEqual([]);
    });
});
