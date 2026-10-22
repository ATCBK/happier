import { describe, expect, it, vi } from 'vitest';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentSetActionInputV1Schema, PluginAvailabilityIntentSetActionOutputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { InvalidateSync } from '@/utils/sessions/sync';
import { createActivePluginAccountAvailabilityProjectionHydrator } from './pluginAvailabilityProjection';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import {
    createActivePluginAccountAvailabilityIntentSetter,
} from './setActivePluginAccountAvailabilityIntent';

const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

/** The isolated CAS fixtures still publish through the real queue and hydrator. */
function createPublishedSetter(request: (path: string, init?: RequestInit) => Promise<Response>,
    retirePluginAuthority?: (pluginId: string) => void) {
    let intent: ReturnType<typeof PluginAvailabilityIntentSetActionOutputV1Schema.parse>['intent'] | null = null;
    const store = createPluginAccountAvailabilityReaderStore();
    const read = async (path: string, init?: RequestInit): Promise<Response> => {
        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set']) {
            const response = await request(path, init);
            intent = PluginAvailabilityIntentSetActionOutputV1Schema.parse(await response.clone().json()).intent;
            return response;
        }
        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
            return Response.json({ availabilityCursor: 2, snapshots: [] });
        }
        return Response.json({ availabilityCursor: 2, pluginIds: intent ? [intent.pluginId] : [], failedPluginIds: [],
            intentReads: intent ? [{ pluginId: intent.pluginId, response: { availabilityCursor: 2,
                hostingCapability: { enabled: false }, intent, release: null, uiArtifacts: [], packageAssets: [] } }] : [] });
    };
    const dependencies = { captureLifetime: () => lifetime,
        getServerSnapshot: () => ({ serverId: lifetime.scope.serverId, generation: 4 }),
        captureRequestAuthority: async () => ({ request: read }) };
    const hydrator = createActivePluginAccountAvailabilityProjectionHydrator(dependencies);
    const queue = new InvalidateSync(async () => {
        const projection = await hydrator.refresh();
        if (projection) store.replace(projection);
    }, { shouldRetry: () => false });
    const setter = createActivePluginAccountAvailabilityIntentSetter({ ...dependencies,
        ...(retirePluginAuthority ? { retirePluginAuthority } : {}),
        refreshAvailability: () => queue.invalidateAndAwait({ settleOnFirstAttempt: true }) });
    return { setter, queue, reader: store.bind(lifetime.scope) };
}

describe('active Account Availability intent setter', () => {
    it.each(['available', 'unavailable', 'held'] as const)('settles an acknowledged selection independently of the %s projection reread without a socket wake', async projectionRead => {
        const pluginId = 'example.tasks';
        const facts = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({ availabilityCursor: 2, facts: {
            ref: { pluginId, version: '2.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: pluginId, version: '2.0.0', displayName: 'Tasks',
                runtime: { apiVersion: 1 }, contributes: {} }, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        } }).facts;
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope: lifetime.scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = store.bind(lifetime.scope);
        const projectionGate = createDeferred<void>();
        let intent: ReturnType<typeof PluginAvailabilityIntentSetActionOutputV1Schema.parse>['intent'] | null = null;
        // Only the authenticated HTTP boundary is substituted. The mutation,
        // queue, strict hydrator and bound reader remain their real owners.
        const request = async (path: string, init?: RequestInit): Promise<Response> => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set']) {
                const { expectedRevision: _expectedRevision, ...input } = PluginAvailabilityIntentSetActionInputV1Schema.parse(JSON.parse(String(init?.body)));
                const result = PluginAvailabilityIntentSetActionOutputV1Schema.parse({ intent: { ...input, revision: 'selected-1' } });
                intent = result.intent;
                return Response.json(result);
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                if (projectionRead === 'unavailable') return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
                if (projectionRead === 'held') await projectionGate.promise;
                return Response.json({ availabilityCursor: 2, snapshots: [] });
            }
            return Response.json({ availabilityCursor: 2, pluginIds: [pluginId], failedPluginIds: [],
                intentReads: [{ pluginId, response: { availabilityCursor: 2, hostingCapability: { enabled: false },
                    intent, release: intent?.desiredVersion ? facts : null, uiArtifacts: [], packageAssets: [] } }] });
        };
        const dependencies = { captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: lifetime.scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        };
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator(dependencies);
        const queue = new InvalidateSync(async () => {
            const refreshed = await hydrator.refresh();
            if (refreshed) store.replace(refreshed);
        }, { shouldRetry: () => false });
        const setterDependencies = { ...dependencies,
            refreshAvailability: () => queue.invalidateAndAwait({ settleOnFirstAttempt: true }) };
        const setter = createActivePluginAccountAvailabilityIntentSetter(setterDependencies);
        try {
            await expect(setter.set({ pluginId, desiredVersion: '2.0.0', enabled: true, offlineUiHosting: 'disabled',
                writableCollections: [], expectedRevision: null })).resolves.toMatchObject({ kind: 'updated', intent: { revision: 'selected-1' } });
            if (projectionRead === 'held') {
                // The write receipt has settled while its real HTTP reread is
                // still withheld; releasing that read later only publishes it.
                expect(reader.readCurrentReleaseSelection({ pluginId })).toMatchObject({ kind: 'unavailable' });
                projectionGate.resolve();
            }
            await queue.awaitQueue();
            expect(reader.readCurrentReleaseSelection({ pluginId })).toMatchObject(projectionRead !== 'unavailable'
                ? { kind: 'available', intent: { desiredVersion: '2.0.0', revision: 'selected-1' } }
                : { kind: 'unavailable' });
        } finally { projectionGate.resolve(); queue.stop(); }
    });

    it('sends the existing intent CAS only through current active Account authority', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            intent: {
                pluginId: 'example.tasks',
                desiredVersion: '2.0.0',
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [{
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    schemaVersion: 2,
                    contractDigest: 'a'.repeat(43),
                }],
                revision: 'intent-2',
            },
        }), { status: 200 }));
        const publication = createPublishedSetter(request);
        const setter = publication.setter;

        try {
            await expect(setter.set({
                pluginId: 'example.tasks',
                desiredVersion: '2.0.0',
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [{
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    schemaVersion: 2,
                    contractDigest: 'a'.repeat(43),
                }],
                expectedRevision: 'intent-1',
            })).resolves.toEqual({
                kind: 'updated',
                intent: expect.objectContaining({ revision: 'intent-2', desiredVersion: '2.0.0' }),
            });
            expect(request).toHaveBeenCalledWith('/v1/plugins/availability/intents/set', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    pluginId: 'example.tasks',
                    desiredVersion: '2.0.0',
                    enabled: false,
                    offlineUiHosting: 'disabled',
                    writableCollections: [{
                        pluginId: 'example.tasks',
                        collectionId: 'tasks',
                        schemaVersion: 2,
                        contractDigest: 'a'.repeat(43),
                    }],
                    expectedRevision: 'intent-1',
                }),
            }));
            await publication.queue.awaitQueue();
            expect(publication.reader.readMaterializations()).toMatchObject({ kind: 'available', intentReads: [{
                pluginId: 'example.tasks', response: { intent: { revision: 'intent-2', enabled: false } },
            }] });
        } finally { publication.queue.stop(); }
    });

    it('preserves an intent revision conflict for the present-user selection owner', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin_intent_revision_conflict',
        }), { status: 409 }));
        const setter = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        await expect(setter.set({
            pluginId: 'example.tasks',
            desiredVersion: '2.0.0',
            enabled: false,
            offlineUiHosting: 'disabled',
            writableCollections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                schemaVersion: 2,
                contractDigest: 'a'.repeat(43),
            }],
            expectedRevision: 'intent-1',
        })).resolves.toEqual({ kind: 'conflict', code: 'intent_revision_conflict' });
    });

    it('withdraws only the disabled plugin after the intent CAS succeeds', async () => {
        const retirePluginAuthority = vi.fn();
        const publication = createPublishedSetter(async () => new Response(JSON.stringify({
            intent: {
                pluginId: 'example.tasks',
                desiredVersion: null,
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [],
                revision: 'intent-2',
            },
        }), { status: 200 }), retirePluginAuthority);
        const setter = publication.setter;

        try {
            await expect(setter.set({
                pluginId: 'example.tasks',
                desiredVersion: null,
                enabled: false,
                offlineUiHosting: 'disabled',
                writableCollections: [],
                expectedRevision: 'intent-1',
            })).resolves.toEqual({
                kind: 'updated',
                intent: expect.objectContaining({ pluginId: 'example.tasks', enabled: false }),
            });
            expect(retirePluginAuthority).toHaveBeenCalledOnce();
            expect(retirePluginAuthority).toHaveBeenCalledWith('example.tasks');
            await publication.queue.awaitQueue();
            expect(publication.reader.readMaterializations()).toMatchObject({ kind: 'available', intentReads: [{
                pluginId: 'example.tasks', response: { intent: { revision: 'intent-2', desiredVersion: null, enabled: false } },
            }] });
        } finally { publication.queue.stop(); }
    });

    it('preserves only the exact writable-collections preparation refusal', async () => {
        const preparationRequired = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'plugin_intent_writable_collections_not_ready',
                }), { status: 400 }),
            }),
        });
        const otherClientFailure = createActivePluginAccountAvailabilityIntentSetter({
            captureLifetime: () => lifetime,
            getServerSnapshot: () => ({ serverId: 'server-a', generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async () => new Response(JSON.stringify({
                    error: 'plugin_release_not_found',
                }), { status: 400 }),
            }),
        });
        const input = {
            pluginId: 'example.tasks',
            desiredVersion: '2.0.0',
            enabled: true,
            offlineUiHosting: 'disabled' as const,
            writableCollections: [{
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                schemaVersion: 2,
                contractDigest: 'a'.repeat(43),
            }],
            expectedRevision: 'intent-1',
        };

        await expect(preparationRequired.set(input)).resolves.toEqual({ kind: 'preparationRequired' });
        await expect(otherClientFailure.set(input)).resolves.toEqual({ kind: 'rejected', code: 'request_rejected' });
    });
});
