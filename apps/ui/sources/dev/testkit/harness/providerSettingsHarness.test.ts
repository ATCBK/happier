import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelProjectionFixture,
    createProviderModelsFixture,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from './providerSettingsHarness';

describe('providerSettingsHarness', () => {
    it('uses route replies for paginated reads while exact query replies keep precedence', async () => {
        const serverUrl = 'https://paged-fixture.test';
        const home = createHomeGovernanceHarness();
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
        const first = createProviderSettingsHarness();
        installProviderSettingsRpcBoundary(first);
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        const serverId = await home.addHome({ name: 'Import order', serverUrl: 'https://import-order.test' });
        home.answer(serverId, '/v1/import-order', { body: { fixture: 'home' } });
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = {
            machineId: createMachineFixture().id,
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
        const response = await createServerFetchAtEndpoint({ endpointUrl: 'https://import-order.test' })('/v1/import-order');
        expect(await response.json()).toEqual({ fixture: 'home' });
        expect(home.requestsFor('/v1/import-order')).toHaveLength(1);
        expect(first.state.requests).toHaveLength(1);
        expect(second.state.requests).toHaveLength(1);
        await home.reset();
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
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: { machineId: 'machine-a' },
        })).resolves.toMatchObject({
            status: 'success',
            connections: [{ displayName: 'Boundary connection' }],
        });
    });

    it('returns a duplicated connection at the caller-provided new identity', async () => {
        const harness = createProviderSettingsHarness();

        await expect(harness.machineRpc({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
            payload: {
                action: 'duplicate',
                machineId: 'machine-a',
                connectionId: 'pc_a',
                newConnectionId: 'pc_copy',
                displayName: 'Copy',
                mode: 'sameSource',
            },
        })).resolves.toMatchObject({
            status: 'success',
            action: 'duplicate',
            connection: { connectionId: 'pc_copy' },
        });
    });
});
