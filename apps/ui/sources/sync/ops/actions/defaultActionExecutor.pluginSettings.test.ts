import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Only Home HTTP, device credentials and disconnected sockets are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => {
    clearPluginAccountAvailabilityProjection();
    await disconnectActiveServerConnection();
    await homes.reset();
});

describe('Plugin Settings through the default Account Action host', () => {
    it.each([false, true])('preserves default approval or executes the user-waived MCP operation (waived=%s)', async waived => {
        const serverUrl = 'https://plugin-settings-actions.test';
        const serverId = await homes.addHome({ name: 'Plugin Settings Home', serverUrl, serverIdentityId: 'srv_settings',
            accountId: 'alice', currentAccount: true });
        homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: waived ? { 'plugins.settings.set': ['mcp'] } : {} },
        } } } });
        const home = homes.findByServerUrl(serverUrl);
        if (!home?.token) throw new Error('Missing Settings Home credential');
        await restoreConnectionToActiveServer({ token: home.token });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected applied Settings Account runtime');
        const pluginId = 'acme.settings';
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 42, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
            release: {
                ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Settings fixture',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                        settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                            target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })],
                    } },
                collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
            }, packageAssets: [], uiArtifacts: [],
        });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 42,
            intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
        let revision = 7;
        let values: Record<string, unknown> = { enabled: false, unrelated: 'retained' };
        const path = `/v1/account/plugin-settings/${pluginId}`;
        homes.answer(serverId, path, { select: () => ({ body: { status: 'present', revision,
            content: { t: 'plain', v: { v: 1, values } } } }) });
        homes.answer(serverId, `POST ${path}`, { select: input => {
            const write = PluginAccountSettingsMutationRequestV1Schema.parse(input);
            expect(write.expectedRevision).toBe(revision);
            if (!write.content || write.content.t !== 'plain') throw new Error('Plain Account must not fabricate encrypted Settings');
            values = PluginAccountSettingsValuesV1Schema.parse(write.content.v).values;
            revision += 1;
            return { body: { status: 'updated', revision } };
        } });
        const input = { pluginId, scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'enabled' };
        const context = { serverId, expectedAccountId: 'alice', surface: 'mcp' as const };
        const executor = createDefaultActionExecutor();
        const read = await executor.execute('plugins.settings.get', input, context);
        expect(read, JSON.stringify(read))
            .toMatchObject({ ok: true, result: { data: { value: false, revision: '7' } } });
        const result = await executor.execute('plugins.settings.set', { ...input, value: true, expectedRevision: '7' },
            { ...context, actionRequestId: 'settings-write-1' });
        if (waived) {
            expect(result).toMatchObject({ ok: true, result: { data: { revision: '8' } } });
            expect(values).toEqual({ enabled: true, unrelated: 'retained' });
            clearPluginAccountAvailabilityProjection();
            expect(await executor.execute('plugins.settings.set', { ...input, value: false, expectedRevision: '8' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
            expect(revision).toBe(8);
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(values).toEqual({ enabled: false, unrelated: 'retained' });
            expect(revision).toBe(7);
        }
    });
});
