import { describe, expect, it, vi } from 'vitest';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/host/registration';
import { normalizePluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred } from '@/dev/testkit';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginUiDataClient } from './pluginUiDataClient';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';

const pluginId = 'example.links';
const definition = defineAccountCollection({
    id: 'links', schemaVersion: 1,
    schema: defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }),
    rowIdField: 'id', identityFields: ['id'], serverReadable: ['id'], indexes: [], relations: [],
});
const contract = normalizePluginAccountCollectionContractV1({ pluginId,
    contribution: PluginAccountCollectionContributionV1Schema.parse(projectPluginAccountCollectionDeclaration(definition.id, definition)),
});
const ref = { pluginId, collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
const manifest = PluginManifestV2Schema.parse({
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Links', runtime: { apiVersion: 1 },
    contributes: {}, hostAccess: { required: [], optional: [] },
});

describe('mounted Collection contract acquisition through real Home authority', () => {
    it('shares concurrent relation admission without retaining a settled contract or its access', async () => {
        let allowed = true;
        let gate = createDeferred<void>();
        const entered = createDeferred<void>();
        let hold = true;
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://collection-admission.test', accountId: 'alice' }],
            route: async request => {
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: { accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                        currentProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
                }));
                if (request.path !== '/v1/plugins/data/contract') return undefined;
                entered.resolve();
                if (hold) await gate.promise;
                return allowed ? Response.json({ access: 'writable', contract })
                    : Response.json({ error: 'collection_unavailable' }, { status: 404 });
            },
        });
        try {
            recordAccountStoredContentServerRequirements({ serverUrl: home.homes.home!.serverUrl,
                requirements: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
                    declarationTransport: 'http-header-and-socket-auth-v1' },
            });
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Home must establish its real Account lifetime');
            const readAvailability = () => createPluginAccountAvailabilityReader({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                    availabilityCursor: 1, packageAssets: [], hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                    intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [ref], revision: 'one' },
                    release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                        normalizedManifest: manifest, collectionContracts: [ref], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }, uiArtifacts: [],
                } }],
            } });
            const collection = createPluginUiDataClient({ pluginId, accountLifetime: lifetime, readAvailability }).collection(definition);
            const signal = new AbortController().signal;
            const tags = Array.from({ length: 56 }, (_, index) => collection.identityTag({ field: 'id', components: [String(index)] }, { signal }));
            const allTags = Promise.all(tags);
            // The HTTP response gate represents one pending authenticated contract read.
            // Release it after all callers have been admitted, then assert the physical work and results.
            await Promise.race([entered.promise, allTags]);
            gate.resolve(); hold = false;
            const values = await allTags;
            expect(new Set(values).size).toBe(56);
            expect(home.requests.filter(request => request.path === '/v1/plugins/data/contract')).toHaveLength(1);
            expect(lifetime.isCurrent()).toBe(true);

            // Two independently cancellable readers must not borrow one another's
            // physical admission. Cancelling one leaves the other reader usable.
            hold = true; gate = createDeferred<void>();
            const cancelled = new AbortController();
            const retained = new AbortController();
            const independent = Promise.allSettled([
                collection.identityTag({ field: 'id', components: ['cancelled'] }, { signal: cancelled.signal }),
                collection.identityTag({ field: 'id', components: ['retained'] }, { signal: retained.signal }),
            ]);
            await vi.waitFor(() => expect(home.requests.filter(request => request.path === '/v1/plugins/data/contract')).toHaveLength(3));
            cancelled.abort(); gate.resolve(); hold = false;
            const results = await independent;
            expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'plugin_collection_cancelled' } });
            expect(results[1]).toMatchObject({ status: 'fulfilled', value: expect.any(String) });

            allowed = false;
            await expect(collection.identityTag({ field: 'id', components: ['later'] }, { signal }))
                .rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            expect(home.requests.filter(request => request.path === '/v1/plugins/data/contract')).toHaveLength(4);
        } finally { gate.resolve(); await home.dispose(); }
    });
});
