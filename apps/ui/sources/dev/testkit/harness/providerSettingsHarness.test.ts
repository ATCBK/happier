import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelProjectionFixture,
    createProviderModelsFixture,
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from './providerSettingsHarness';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

let account: ReturnType<typeof createProviderSettingsAccountHarness> | null = null;
afterEach(async () => {
    await account?.reset();
    account = null;
});

describe('providerSettingsHarness', () => {
    it('uses route replies for paginated reads while exact query replies keep precedence', async () => {
        const serverUrl = 'https://paged-fixture.test';
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        const serverId = await home.addHome({ name: 'Paged fixture', serverUrl });
        home.answer(serverId, 'GET /v2/sessions', { body: { sessions: [], hasNext: false } });
        home.answer(serverId, '/v2/sessions?limit=2', { body: { sessions: [], hasNext: true, nextCursor: 'next' } });
        try {
            const defaultPage = await home.request(`${serverUrl}/v2/sessions?limit=50`);
            expect(defaultPage.status).toBe(200);
            expect(await defaultPage.json()).toEqual({ sessions: [], hasNext: false });
            const exactPage = await home.request(`${serverUrl}/v2/sessions?limit=2`);
            expect(await exactPage.json()).toEqual({ sessions: [], hasNext: true, nextCursor: 'next' });
            const unclaimedWrite = await home.request(`${serverUrl}/v2/sessions?limit=50`, { method: 'POST' });
            expect(unclaimedWrite.status).toBe(404);
        } finally {
            await home.reset();
        }
    });

    it('keeps cold barrel imports safe and routes requests to the current installed boundaries', async () => {
        const machine = createMachineFixture();
        const first = createProviderSettingsHarness({ machines: [machine] });
        installProviderSettingsRpcBoundary(first);
        account = createProviderSettingsAccountHarness();
        const { serverId } = await account.restore({ machines: first.state.machines });
        const home = account.home;
        home.answer(serverId, '/v1/import-order', { body: { fixture: 'home' } });
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = {
            machineId: machine.id,
            serverId,
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: {},
        };
        await expect(machineRpcWithServerScope(request)).resolves.toMatchObject({ status: 'success' });
        const second = createProviderSettingsHarness();
        second.setResponse(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ displayName: 'Second' })] }));
        installProviderSettingsRpcBoundary(second);
        installHomeGovernanceBoundaries(home);
        await expect(machineRpcWithServerScope(request)).resolves.toMatchObject({ connections: [{ displayName: 'Second' }] });
        const response = await createServerFetchAtEndpoint({ endpointUrl: 'https://provider-settings-account.test' })('/v1/import-order');
        expect(await response.json()).toEqual({ fixture: 'home' });
        expect(home.requestsFor('/v1/import-order')).toHaveLength(1);
        expect(first.state.requests).toHaveLength(1);
        expect(second.state.requests).toHaveLength(1);
    });

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
        expect(V2SessionListResponseSchema.parse(await sessions.json())).toMatchObject({
            sessions: [], nextCursor: null, hasNext: false,
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

    it('persists Account settings through the real HTTP CAS contract and rejects a stale write', async () => {
        account = createProviderSettingsAccountHarness();
        await account.restore({ settings: { newSessionDraftEntryMode: 'resumePrevious' } });
        const home = account.home.findByServerUrl('https://provider-settings-account.test');
        if (!home?.token) throw new Error('Provider fixture has no authenticated Home');
        const request = (method: 'GET' | 'POST', body?: unknown) => account!.home.request(
            new URL('/v2/account/settings', home.serverUrl), {
                method, headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const content = { t: 'plain', v: { newSessionDraftEntryMode: 'alwaysFresh' } };

        expect(await (await request('POST', { expectedVersion: 1, content })).json()).toEqual({ success: true, version: 2 });
        expect(await (await request('POST', { expectedVersion: 1, content: { t: 'plain', v: {} } })).json()).toEqual({
            success: false, error: 'version-mismatch', currentVersion: 2, currentContent: content,
        });
        expect(await (await request('GET')).json()).toEqual({ version: 2, content });
        expect((await account.home.request(new URL('/v2/account/settings', home.serverUrl))).status).toBe(401);
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
