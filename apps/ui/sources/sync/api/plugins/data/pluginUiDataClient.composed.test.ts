import { describe, expect, it, vi } from 'vitest';
import { defineAccountCollection, type PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/host/registration';
import { normalizePluginAccountCollectionContractV1, normalizePluginAccountCollectionContractsV1, PluginCollectionContractReadRequestV1Schema,
    PluginCollectionMutationRequestV1Schema, PluginCollectionForgetRequestV1Schema, PluginCollectionGetRequestV1Schema,
    PluginCollectionRowV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { serveAccountHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { sync } from '@/sync/sync';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginUiAccountStorageScope, createPluginUiDataClient } from './pluginUiDataClient';
import { publishActivePluginCollectionChanges, resetActivePluginCollectionChanges } from './pluginCollectionChangeWatch';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';
import { createActivePluginCollectionClientForContractRef, prepareCollectionOperation, requestCollectionOperation,
    type ActivePluginCollectionClientV1 } from './activePluginCollectionClient';

// The canonical host harness has no packaged native assets. Seed only that
// Package/Expo boundary; declaration admission, Sync and Data stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async importOriginal => {
    const base = await importOriginal<typeof import('@/dev/testkit/mocks/bundledPluginUiAssets')>();
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { normalizePluginAccountCollectionContractsV1 } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'example.cold-links',
        version: '1.0.0', displayName: 'Cold links', runtime: { apiVersion: 1 },
        contributes: { accountCollections: [{ id: 'links', schemaVersion: 1,
            schema: { type: 'object', properties: { id: { type: 'string', maxLength: 256 } }, required: ['id'], additionalProperties: false },
            rowIdField: 'id', serverReadable: ['id'], indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
            uiQueries: [{ id: 'all', indexId: 'by-id', parameters: {}, prefix: [], order: 'asc', pageSize: 10, projectedFields: ['id'] }],
        }] },
    });
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'cold', tier: 'reactNative',
        entry: 'react-native/cold/entry.cjs.bundle', digest,
        files: [{ relativePath: 'react-native/cold/entry.cjs.bundle', digest, byteSize: 1 }],
        builtWith: { bundler: 'esbuild', version: '1.0.0' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const collectionContracts = normalizePluginAccountCollectionContractsV1({ pluginId: manifest.id,
        contributions: manifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
        ({ pluginId, collectionId, schemaVersion, contractDigest }));
    return { ...base, BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [{ pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: graph.artifactId, tier: graph.tier, digest: graph.digest, artifactGraph: graph, files: [],
        uiDeclaration: { pluginId: manifest.id, pluginVersion: manifest.version, displayName: manifest.displayName,
            packageName: '@happier-dev/plugins-cold-links', normalizedManifest: manifest, artifactGraphs: [graph],
            entriesById: {}, collectionContracts },
    }] satisfies import('@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory').BundledPluginUiAppArtifactInventory };
});

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
    contributes: {}, hostAccess: { required: [{ id: 'account-storage', capability: 'storage.account', reason: 'Store links', scope: { enabled: true } }], optional: [] },
});

const rowReadDefinition = defineAccountCollection({ ...definition,
    indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
});
const rowReadContract = normalizePluginAccountCollectionContractV1({ pluginId,
    contribution: PluginAccountCollectionContributionV1Schema.parse(projectPluginAccountCollectionDeclaration(rowReadDefinition.id, rowReadDefinition)),
});

async function withRowReadClient(
    route: (request: ServedHomeRequest) => Response | Promise<Response | undefined> | undefined,
    run: (client: ActivePluginCollectionClientV1, home: Awaited<ReturnType<typeof serveAccountHomes>>) => Promise<void>,
) {
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://collection-row-reads.test', accountId: 'alice' }],
        route: request => request.path === '/v1/plugins/data/contract'
            ? Response.json({ access: 'writable', contract: rowReadContract }) : route(request),
    });
    try {
        recordAccountStoredContentServerRequirements({ serverUrl: home.homes.home!.serverUrl,
            requirements: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1' },
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Home must establish its real Account lifetime');
        const admitted = await createActivePluginCollectionClientForContractRef({ accountLifetime: lifetime,
            ref: { ...ref, contractDigest: rowReadContract.contractDigest } });
        if (admitted.status !== 'ready') throw new Error('The real contract read must admit the Collection');
        await run(admitted.client, home);
    } finally { await home.dispose(); }
}

describe('Collection raw read acquisition after caller admission', () => {
    it('coalesces identical get and query payloads while retaining distinct demands and no settled values', async () => {
        const release = createDeferred<void>();
        try {
            await withRowReadClient(async request => {
                if (request.path !== '/v1/plugins/data/get' && request.path !== '/v1/plugins/data/query') return undefined;
                await release.promise;
                return Response.json(request.path.endsWith('/get') ? { row: null, absenceEpoch: 2 } : { rows: [], changeCursor: 9 });
            }, async (client, home) => {
                const pending = Promise.all([client.get('same'), client.get('same'), client.get('other'),
                    client.query({ indexId: 'by-id', order: 'asc' }), client.query({ indexId: 'by-id', order: 'asc' }),
                    client.query({ indexId: 'by-id', order: 'asc', limit: 2 })]);
                await Promise.race([
                    pending.then(results => expect(results).toEqual(results.map(() => expect.objectContaining({ status: 'ready' })))),
                    vi.waitFor(() => expect(home.requests.filter(request => request.path === '/v1/plugins/data/get'
                        || request.path === '/v1/plugins/data/query').length).toBeGreaterThanOrEqual(4)),
                ]);
                release.resolve();
                expect((await pending).every(result => result.status === 'ready')).toBe(true);
                expect(home.requests.filter(request => request.path === '/v1/plugins/data/get')).toHaveLength(2);
                expect(home.requests.filter(request => request.path === '/v1/plugins/data/query')).toHaveLength(2);
                await expect(client.get('same')).resolves.toMatchObject({ status: 'ready', row: null });
                expect(home.requests.filter(request => request.path === '/v1/plugins/data/get')).toHaveLength(3);
            });
        } finally { release.resolve(); }
    });

    it('detaches an initiating borrower without aborting an independently admitted reader', async () => {
        const release = createDeferred<void>();
        const entered = createDeferred<void>();
        try {
            await withRowReadClient(async request => {
                if (request.path !== '/v1/plugins/data/get') return undefined;
                entered.resolve();
                await release.promise;
                return Response.json({ row: null, absenceEpoch: 2 });
            }, async (_client, home) => {
                const controller = new AbortController();
                const firstAdmission = await prepareCollectionOperation({ signal: controller.signal });
                const secondAdmission = await prepareCollectionOperation(undefined);
                if (firstAdmission.status !== 'ready' || secondAdmission.status !== 'ready') throw new Error('Both callers must admit independently');
                const body = PluginCollectionGetRequestV1Schema.parse({ pluginId, collectionId: ref.collectionId,
                    readerContext: { ...ref, contractDigest: rowReadContract.contractDigest }, rowId: 'same' });
                const first = requestCollectionOperation({ operation: firstAdmission.operation, kind: 'read',
                    path: '/v1/plugins/data/get', body });
                const survivor = requestCollectionOperation({ operation: secondAdmission.operation, kind: 'read',
                    path: '/v1/plugins/data/get', body });
                try {
                    await entered.promise;
                    controller.abort();
                    expect(home.requests.filter(request => request.path === '/v1/plugins/data/get')[0]?.signal?.aborted).toBe(false);
                    release.resolve();
                    await expect(first).resolves.toMatchObject({ status: 'unavailable', reason: 'operation-cancelled' });
                    await expect(survivor).resolves.toMatchObject({ status: 'response', body: { row: null, absenceEpoch: 2 } });
                    expect(home.requests.filter(request => request.path === '/v1/plugins/data/get')).toHaveLength(1);
                } finally {
                    release.resolve();
                    await Promise.allSettled([first, survivor]);
                    await firstAdmission.operation.release();
                    await secondAdmission.operation.release();
                }
            });
        } finally { release.resolve(); }
    });

    it('keeps a mutation absence witness fresh while an ordinary row observation is pending', async () => {
        const release = createDeferred<void>();
        let reads = 0;
        try {
            await withRowReadClient(async request => {
                if (request.path === '/v1/plugins/data/get') {
                    const absenceEpoch = ++reads;
                    if (absenceEpoch === 1) await release.promise;
                    return Response.json({ row: null, absenceEpoch });
                }
                if (request.path === '/v1/plugins/data/mutate') {
                    const input = PluginCollectionMutationRequestV1Schema.parse(request.body);
                    expect(input.operations[0]).toMatchObject({ kind: 'put', expectedAbsenceEpoch: 2 });
                    return Response.json({ status: 'updated', changeCursor: 9, results: [{ rowId: 'same', revision: 1, deleted: false }] });
                }
                return undefined;
            }, async (client, home) => {
                const ordinary = client.get('same');
                await vi.waitFor(() => expect(reads).toBe(1));
                const mutation = client.mutate([{ kind: 'put', value: { id: 'same' }, expectedRevision: 'absent' }]);
                await vi.waitFor(() => expect(reads).toBe(2));
                release.resolve();
                await expect(ordinary).resolves.toMatchObject({ status: 'ready', absenceEpoch: 1 });
                await expect(mutation).resolves.toMatchObject({ status: 'updated' });
                expect(home.requests.filter(request => request.path === '/v1/plugins/data/get')).toHaveLength(2);
            });
        } finally { release.resolve(); }
    });

    it('does not coalesce identical physical mutations', async () => {
        const release = createDeferred<void>();
        try {
            await withRowReadClient(async request => {
                if (request.path !== '/v1/plugins/data/mutate') return undefined;
                await release.promise;
                return Response.json({ status: 'updated', changeCursor: 9, results: [{ rowId: 'same', revision: 2, deleted: false }] });
            }, async (client, home) => {
                const mutation = [{ kind: 'put' as const, value: { id: 'same' }, expectedRevision: 1 }];
                const pending = Promise.all([client.mutate(mutation), client.mutate(mutation)]);
                await vi.waitFor(() => expect(home.requests.filter(request => request.path === '/v1/plugins/data/mutate')).toHaveLength(2));
                release.resolve();
                expect((await pending).every(result => result.status === 'updated')).toBe(true);
            });
        } finally { release.resolve(); }
    });

    it.each(['updated', 'unknown'] as const)('separates post-mutation reads from pre-write observations after an %s receipt', async receipt => {
        const release = createDeferred<void>();
        let reads = 0;
        let deleted = false;
        try {
            await withRowReadClient(async request => {
                if (request.path === '/v1/plugins/data/get') {
                    const snapshot = deleted ? { row: null, absenceEpoch: 2 } : {
                        row: PluginCollectionRowV1Schema.parse({ rowId: 'same', revision: 1,
                            content: { t: 'plain', v: {} }, projection: { id: 'same' } }), absenceEpoch: 1,
                    };
                    if (++reads === 1) await release.promise;
                    return Response.json(snapshot);
                }
                if (request.path === '/v1/plugins/data/mutate') {
                    const input = PluginCollectionMutationRequestV1Schema.parse(request.body);
                    expect(input.operations).toEqual([{ kind: 'delete', rowId: 'same', expectedRevision: 1 }]);
                    deleted = true;
                    // A malformed acknowledgement cannot undo an applied write.
                    return Response.json(receipt === 'unknown' ? {} : { status: 'updated', changeCursor: 9,
                        results: [{ rowId: 'same', revision: 2, deleted: true }] });
                }
                return undefined;
            }, async client => {
                const ordinary = client.get('same');
                await vi.waitFor(() => expect(reads).toBe(1));
                const outcome = await client.mutate([{ kind: 'delete', rowId: 'same', expectedRevision: 1 }]);
                expect(outcome).toMatchObject(receipt === 'unknown'
                    ? { status: 'unavailable', reason: 'mutation-outcome-unknown' } : { status: 'updated' });
                const current = client.get('same');
                await vi.waitFor(() => expect(reads).toBe(2));
                release.resolve();
                await expect(current).resolves.toMatchObject({ status: 'ready', row: null, absenceEpoch: 2 });
                await expect(ordinary).resolves.toMatchObject({ status: 'ready', row: { revision: 1 }, absenceEpoch: 1 });
            });
        } finally { release.resolve(); }
    });
});

describe('mounted Collection contract acquisition through real Home authority', () => {
    it('bootstraps an authored bundled query only through the Account claim and canonical Availability refresh', async () => {
        let allowClaim = false;
        let claimed: ReturnType<typeof PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse> | null = null;
        const refs = () => claimed ? normalizePluginAccountCollectionContractsV1({ pluginId: claimed.manifest.id,
            contributions: claimed.manifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
            ({ pluginId, collectionId, schemaVersion, contractDigest })) : [];
        const intent = () => ({ pluginId: claimed!.manifest.id, desiredVersion: null, enabled: true,
            offlineUiHosting: 'disabled', writableCollections: refs(), revision: 'one' });
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://bundled-collection-bootstrap.test', accountId: 'alice' }],
            route: request => {
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {},
                    capabilities: { accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                        currentProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
                }));
                if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']) {
                    if (!allowClaim) return Response.json({ error: 'claim_refused' }, { status: 403 });
                    claimed = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(request.body);
                    return Response.json({ intent: intent() });
                }
                if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return Response.json({ availabilityCursor: 4, snapshots: [], inventoryComplete: true, releases: [] });
                }
                if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                    return Response.json({ availabilityCursor: 4, pluginIds: claimed ? [claimed.manifest.id] : [], failedPluginIds: [],
                        intentReads: claimed ? [{ pluginId: claimed.manifest.id, response: { availabilityCursor: 4,
                            hostingCapability: { enabled: false }, intent: intent(), release: null, uiArtifacts: [], packageAssets: [] } }] : [] });
                }
                if (request.path === '/v1/plugins/data/contract' && claimed) {
                    const requested = PluginCollectionContractReadRequestV1Schema.parse(request.body);
                    const contracts = normalizePluginAccountCollectionContractsV1({ pluginId: claimed.manifest.id,
                        contributions: claimed.manifest.contributes.accountCollections });
                    const contract = contracts.find(candidate => candidate.collectionId === requested.ref.collectionId
                        && candidate.contractDigest === requested.ref.contractDigest);
                    return contract ? Response.json({ access: 'writable', contract }) : Response.json({ error: 'collection_unavailable' }, { status: 404 });
                }
                if (request.path === '/v1/plugins/data/query') return Response.json({ rows: [], changeCursor: 9 });
                return undefined;
            },
        });
        try {
            recordAccountStoredContentServerRequirements({ serverUrl: home.homes.home!.serverUrl,
                requirements: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
                    declarationTransport: 'http-header-and-socket-auth-v1' },
            });
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Home must establish its real Account lifetime');
            await sync.refreshPluginAccountAvailability();
            const bundledPluginId = 'example.cold-links';
            const readAvailability = () => readPluginAccountAvailability(lifetime.scope);
            const selected = readAvailability().readCurrentAccountExecution(bundledPluginId);
            if (selected.kind !== 'available') throw new Error('The app asset boundary must declare the authored plugin');
            const declaration = selected.manifest.contributes.accountCollections?.find(candidate => candidate.indexes.length > 0
                && (candidate.migrations?.length ?? 0) === 0);
            if (!declaration) throw new Error('The authored bundle must declare an indexed Account Collection');
            const storage = createPluginUiAccountStorageScope({ pluginId: bundledPluginId, accountLifetime: lifetime, readAvailability });
            const uiData = createPluginUiDataClient({ pluginId: bundledPluginId, accountLifetime: lifetime, readAvailability });
            expect(home.requests.some(request => request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'])).toBe(false);
            const { migrations: _migrations, ...definition } = declaration;
            const collection = storage.collection(defineAccountCollection(definition));
            await expect(uiData.openCollectionQuery({ collectionId: declaration.id, uiQueryId: 'all', parameters: {} }))
                .rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            expect(home.requests.filter(request => request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']))
                .toHaveLength(1);
            await expect(collection.query({ index: declaration.indexes[0]!.id, order: 'asc' }))
                .rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            expect(home.requests.some(request => request.path.startsWith('/v1/plugins/data/'))).toBe(false);
            allowClaim = true;
            await expect(collection.query({ index: declaration.indexes[0]!.id, order: 'asc' }))
                .resolves.toMatchObject({ rows: [], changeCursor: 9 });
            expect(readAvailability().readCurrentCollectionContract({ pluginId: bundledPluginId, collectionId: declaration.id }))
                .toMatchObject({ kind: 'available' });
            expect(home.requests.filter(request => request.path === '/v1/plugins/data/query')).toHaveLength(1);
            const pager = await uiData.openCollectionQuery({ collectionId: declaration.id, uiQueryId: 'all', parameters: {} });
            pager.dispose();
        } finally { await home.dispose(); }
    });
    it('serves the public Account storage scope without a Machine and retires its real cursor watch', async () => {
        let enabled = true;
        let currentRef = ref;
        let disableAfterContract = false;
        let disableOnCurrentness = false;
        let disableOnRead = false;
        let cancelKvRead: AbortController | null = null;
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://account-storage-scope.test', accountId: 'alice',
            encryptionCurrentness: () => {
                if (disableOnCurrentness) { enabled = false; disableOnCurrentness = false; }
                return createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 });
            },
        }],
            route: request => {
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {},
                    capabilities: { accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                        currentProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
                }));
                if (request.path === '/v1/plugins/data/contract') {
                    if (disableAfterContract) disableOnCurrentness = true;
                    return Response.json({ access: 'writable', contract });
                }
                if (request.path === '/v1/plugins/data/get') {
                    if (disableOnRead) enabled = false;
                    return Response.json({ row: null, absenceEpoch: 0 });
                }
                if (request.path === `/v1/account/plugin-storage/${pluginId}`) {
                    if (request.method === 'GET') {
                        cancelKvRead?.abort();
                        return Response.json({ status: 'absent' });
                    }
                    return Response.json({ status: 'updated', revision: 1 });
                }
                if (request.path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 37, changesFloor: 0 }));
                return undefined;
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
                    intent: { pluginId, desiredVersion: '1.0.0', enabled, offlineUiHosting: 'enabled', writableCollections: [currentRef], revision: 'one' },
                    release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                        normalizedManifest: manifest, collectionContracts: [currentRef], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }, uiArtifacts: [],
                } }],
            } });
            const storage = createPluginUiAccountStorageScope({ pluginId, accountLifetime: lifetime, readAvailability });
            const collection = storage.collection(definition);
            await expect(collection.get('link')).resolves.toBeNull();
            await expect(storage.kv.set('selected', 'link', { expectedVersion: 'absent' })).resolves.toEqual({ version: 0 });
            disableOnRead = true;
            await expect(collection.get('link')).rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            enabled = true;
            disableOnRead = false;
            disableAfterContract = true;
            await expect(collection.put({ id: 'link' }, { expectedRevision: 1 }))
                .rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            expect(home.requests.some(request => request.path === '/v1/plugins/data/mutate')).toBe(false);
            enabled = true;
            disableAfterContract = false;
            disableOnCurrentness = false;
            const declaration: PluginAccountCollectionDefinition = definition;
            expect(() => storage.collection(declaration).watch({ index: 'undeclared', order: 'asc' }, () => undefined))
                .toThrowError(expect.objectContaining({ code: 'plugin_collection_invalid_value' }));
            const changes: Array<Readonly<{ kind: string; changeCursor: number }>> = [];
            const watch = collection.watch({ kind: 'collection' }, change => changes.push(change));
            const publish = (cursor: number) => publishActivePluginCollectionChanges([{
                cursor, kind: 'pluginDomain', entityId: `pluginDomain/${pluginId}/data-collection/links`, changedAt: 1,
                hint: { pluginDomain: 'dataCollection', pluginId, collectionId: 'links', contractDigest: ref.contractDigest, revision: 3, full: true },
            }]);
            publish(31);
            expect(changes).toEqual([{ kind: 'changed', changeCursor: 31 }]);
            resetActivePluginCollectionChanges();
            await vi.waitFor(() => expect(changes).toContainEqual({ kind: 'reset', changeCursor: 37 }));
            enabled = false;
            const storageRequests = () => home.requests.filter(request => request.path.startsWith('/v1/plugins/data/')
                || request.path.startsWith('/v1/account/plugin-storage/'));
            const beforeRefused = storageRequests().length;
            publish(38);
            await expect(collection.get('link')).rejects.toMatchObject({ code: 'plugin_collection_undeclared' });
            await expect(storage.kv.set('selected', 'other', { expectedVersion: 'absent' })).rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
            expect(storageRequests()).toHaveLength(beforeRefused);
            expect(changes).toHaveLength(2);
            enabled = true;
            currentRef = { ...ref, collectionId: 'other' };
            expect(() => collection.watch({ kind: 'collection' }, () => undefined)).toThrowError(expect.objectContaining({ code: 'plugin_collection_undeclared' }));
            currentRef = ref;
            const cancelled = new AbortController(); cancelled.abort();
            await expect(collection.get('link', { signal: cancelled.signal })).rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
            for (const reason of ['cancelled', 'settled'] as const) {
                const invocation = new AbortController();
                let current = true;
                const bound = createPluginUiAccountStorageScope({ pluginId, accountLifetime: lifetime, readAvailability,
                    signal: invocation.signal, isCurrent: () => current });
                const retained = bound.collection(definition);
                const invalidated = vi.fn();
                const subscription = retained.watch({ kind: 'collection' }, invalidated);
                if (reason === 'cancelled') invocation.abort(); else current = false;
                const code = reason === 'cancelled' ? 'plugin_collection_cancelled' : 'plugin_account_storage_unavailable';
                const before = storageRequests().length;
                await expect(retained.get('late')).rejects.toMatchObject({ code });
                await expect(retained.put({ id: 'late' }, { expectedRevision: 'absent' })).rejects.toMatchObject({ code });
                await expect(bound.kv.get('late')).rejects.toMatchObject({ code });
                await expect(bound.kv.set('late', true, { expectedVersion: 'absent' })).rejects.toMatchObject({ code });
                expect(() => retained.watch({ kind: 'collection' }, invalidated)).toThrowError(expect.objectContaining({ code }));
                publish(39);
                expect(invalidated).not.toHaveBeenCalled();
                expect(storageRequests()).toHaveLength(before);
                subscription.dispose();
            }
            cancelKvRead = new AbortController();
            const bound = createPluginUiAccountStorageScope({ pluginId, accountLifetime: lifetime, readAvailability,
                signal: cancelKvRead.signal });
            const writesBefore = storageRequests().filter(request => request.method === 'POST').length;
            await expect(bound.kv.set('late', true, { expectedVersion: 'absent' }))
                .rejects.toMatchObject({ code: 'plugin_collection_cancelled' });
            expect(storageRequests().filter(request => request.method === 'POST')).toHaveLength(writesBefore);
            cancelKvRead = null;
            const retainedWatch = collection.watch({ kind: 'collection' }, change => changes.push(change));
            await home.switchAccount('home', 'bob');
            publish(39);
            await expect(collection.get('link')).rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
            expect(changes).toHaveLength(2);
            watch.dispose();
            retainedWatch.dispose();
        } finally { await home.dispose(); }
    });
    it.each([
        ['get', 'put'], ['put', 'put'], ['get', 'delete'], ['get', 'forget'], ['get', 'batch'],
    ] as const)('keeps each mutation admission independent of a pending %s when calling %s', async (firstOperation, mutation) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let contractReads = 0;
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://collection-writer-admission.test', accountId: 'alice' }],
            route: async request => {
                if (request.path === '/v1/plugins/data/contract') {
                    if (++contractReads === 1) {
                        entered.resolve();
                        await release.promise;
                        return Response.json({ access: 'readOnly', contract });
                    }
                    return Response.json({ access: 'writable', contract });
                }
                if (request.path === '/v1/plugins/data/get') return Response.json({ row: null, absenceEpoch: 0 });
                if (request.path === '/v1/plugins/data/mutate') {
                    const input = PluginCollectionMutationRequestV1Schema.parse(request.body);
                    return Response.json({ status: 'updated', changeCursor: 9,
                        results: input.operations.map(operation => ({ rowId: operation.rowId, revision: 2, deleted: operation.kind === 'delete' })) });
                }
                if (request.path === '/v1/plugins/data/forget') {
                    PluginCollectionForgetRequestV1Schema.parse(request.body);
                    return Response.json({ status: 'forgotten' });
                }
                return undefined;
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
            const collection = createPluginUiAccountStorageScope({ pluginId, accountLifetime: lifetime, readAvailability }).collection(definition);
            const first = firstOperation === 'get' ? collection.get('earlier')
                : collection.put({ id: 'earlier' }, { expectedRevision: 1 });
            const firstOutcome = first.then(value => ({ value }), error => ({ error }));
            await entered.promise;
            const written = mutation === 'put' ? collection.put({ id: 'later' }, { expectedRevision: 1 })
                : mutation === 'delete' ? collection.delete('later', { expectedRevision: 1 })
                    : mutation === 'forget' ? collection.forget('later', { expectedRevision: 1 })
                        : collection.batch([{ kind: 'put', value: { id: 'later' }, expectedRevision: 1 }]);
            release.resolve();
            const outcome = await written.then(value => ({ status: 'written', value }), error => ({ status: 'refused', error,
                contractReads, paths: home.requests.map(request => request.path) }));
            expect(outcome).toEqual({ status: 'written', value: mutation === 'batch'
                ? { status: 'updated', results: [{ rowId: 'later', revision: 2, deleted: false }] }
                : { rowId: 'later',
                ...(mutation === 'put' ? { revision: 2, value: { id: 'later' } }
                    : mutation === 'delete' ? { revision: 2, deleted: true } : { forgotten: true }) } });
            expect(await firstOutcome).toMatchObject(firstOperation === 'get' ? { value: null }
                : { error: { code: 'plugin_account_storage_unavailable' } });
            expect(contractReads).toBe(2);
        } finally { release.resolve(); await home.dispose(); }
    });
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
