import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelProjectionFixture,
    createProviderModelsFixture,
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from './providerSettingsHarness';

let account: ReturnType<typeof createProviderSettingsAccountHarness> | null = null;
afterEach(async () => {
    await account?.reset();
    account = null;
});

describe('providerSettingsHarness', () => {
    it('persists the admitted Provider Account row and refuses stale catalog CAS without changing it', async () => {
        account = createProviderSettingsAccountHarness();
        await account.restore();
        const home = account.home.findByServerUrl('https://provider-settings-account.test');
        if (!home?.token) throw new Error('Provider fixture has no authenticated Home');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const fetchAtHome = createServerFetchAtEndpoint({
            endpointUrl: home.serverUrl, serverId: account.serverId, credentials: { token: home.token },
        });
        const sessionsPath = '/v2/sessions/active?limit=500';
        const sessions = await fetchAtHome(sessionsPath);
        expect(sessions.status).toBe(200);
        expect(await sessions.json()).toMatchObject({
            sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        });
        const { runtimeFetch } = await import('@/utils/system/runtimeFetch');
        expect((await runtimeFetch(new Request(new URL(sessionsPath, home.serverUrl), { method: 'POST' }))).status).toBe(404);
        account.home.answer(account.serverId, `GET ${sessionsPath}`, { status: 503, body: { error: 'fixture_offline' } });
        expect((await fetchAtHome(sessionsPath)).status).toBe(503);
        expect((await fetchAtHome(sessionsPath, { method: 'POST' })).status).toBe(404);
        expect((await fetchAtHome('/fixture-unknown-bootstrap-read')).status).toBe(404);
        const { PluginAvailabilityActionHttpPathsV1 } = await import('@happier-dev/protocol/plugins/availability');
        const intents = await fetchAtHome(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ knownPluginIds: [] }),
        });
        expect(intents.status).toBe(200);
        expect(await intents.json()).toMatchObject({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
                source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic', revision: 7, createdAt: 1, updatedAt: 1 })],
        });
        const mutation = ProviderConnectionsRowMutationV1Schema.parse({ expectedRevision: 1,
            content: { t: 'plain', v: catalog }, referencedSavedSecretIds: [], savedSecretRevisions: [] });
        const request = (method: 'GET' | 'POST', body?: unknown) => account!.home.request(
            new URL(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, home.serverUrl), {
                method, headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        expect(await (await request('POST', mutation)).json()).toMatchObject({ status: 'updated', revision: 2 });
        expect(await (await request('POST', { ...mutation, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } })).json())
            .toMatchObject({ status: 'conflict', revision: 2 });
        expect(await (await request('GET')).json()).toMatchObject({ status: 'present', revision: 2, content: { t: 'plain', v: catalog } });
    });

    it('keeps scoped Machine admission real above the Provider Socket response', async () => {
        const harness = createProviderSettingsHarness();
        installProviderSettingsRpcBoundary(harness);
        account = createProviderSettingsAccountHarness();
        const restored = await account.restore({ machines: harness.state.machines });
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        // A fabricated internal dispatcher would return the configured success even
        // when no saved Home can authorize this target.
        await expect(machineRpcWithServerScope({ serverId: 'missing-provider-home', machineId: 'machine-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: { machineId: 'machine-a' }, preferScoped: true,
        })).rejects.toBeDefined();
        expect(harness.state.requests).toEqual([]);
        await expect(machineRpcWithServerScope({ serverId: restored.serverId, machineId: 'machine-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: { machineId: 'machine-a' }, preferScoped: true,
        })).resolves.toMatchObject({ status: 'success', connections: [{ connectionId: 'pc_a' }] });
        expect(harness.state.requests).toMatchObject([{ serverId: restored.serverId,
            accountId: 'account-a', machineId: 'machine-a', method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE }]);
    });

    it('serves schema-complete Provider responses at the server-scoped transport boundary', async () => {
        const harness = createProviderSettingsHarness();
        const connection = createProviderConnectionViewFixture({ displayName: 'Boundary connection' });
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            createProviderConnectionsDescribeFixture({ connections: [connection] }),
        );
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_MODELS,
            createProviderModelsFixture({ connectionId: connection.connectionId }),
        );
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
            createProviderModelProjectionFixture({ agentTargetKey: 'agent:happier.agent.codex/codex' }),
        );

        await expect(harness.machineRpc({
            machineId: 'machine-a', serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: { machineId: 'machine-a' },
        })).resolves.toMatchObject({ status: 'success', connections: [{ displayName: 'Boundary connection' }] });
    });

    it('returns a duplicated connection at the caller-provided new identity', async () => {
        const harness = createProviderSettingsHarness();
        await expect(harness.machineRpc({
            machineId: 'machine-a', serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
            payload: { action: 'duplicate', machineId: 'machine-a', connectionId: 'pc_a',
                newConnectionId: 'pc_copy', displayName: 'Copy', mode: 'sameSource' },
        })).resolves.toMatchObject({ status: 'success', action: 'duplicate', connection: { connectionId: 'pc_copy' } });
    });

    it('retires the real Provider Account lifetime on a same-Home replacement', async () => {
        account = createProviderSettingsAccountHarness();
        const restored = await account.restore({ accountId: 'account-a' });
        const { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const captured = captureActiveServerAccountScopeLifetime();
        expect(captured?.isCurrent()).toBe(true);
        expect(getActiveServerAccountScope()).toEqual({ serverId: restored.serverId, accountId: 'account-a' });
        await account.restore({ accountId: 'account-b' });
        expect(captured?.isCurrent()).toBe(false);
        expect(getActiveServerAccountScope()).toEqual({ serverId: restored.serverId, accountId: 'account-b' });
        await account.reset();
        expect(getActiveServerAccountScope()).toBeNull();
    });
});
