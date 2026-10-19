import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createArtifact, fetchArtifactListPage, restoreArtifactRevision, updateArtifact } from './apiArtifacts';
import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';

afterEach(() => resetServerFeaturesClientForTests());
const row = { id: 'skill', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: 'header', headerVersion: 2, body: 'body', bodyVersion: 3,
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 0, createdAt: 1, updatedAt: 1 } as const;

function advertise(enabled: boolean) {
    primeServerFeaturesSnapshot({ serverId: 'kind-api-home', snapshot: { status: 'ready',
        features: FeaturesResponseSchema.parse({ features: { artifacts: { kindFiltering: { enabled } } }, capabilities: {} }) } });
}

describe('Artifact coarse-kind wire compatibility', () => {
    it.each([true, false])('respects current Home kind-filtering policy for queries and writes (enabled=%s)', async supported => {
        advertise(supported);
        const paths: string[] = [];
        const writes: Record<string, unknown>[] = [];
        const uploads: unknown[] = [];
        const request = async (path: string, init?: RequestInit) => {
            paths.push(path);
            if ((init?.method ?? 'GET') === 'GET') return Response.json(supported
                ? { items: [{ ...row, kind: 'skill' }], hasUnclassified: true } : [row]);
            if (path === '/v1/artifacts/content/upload') {
                const wire = new Uint8Array(await new Response(init?.body).arrayBuffer());
                uploads.push(decodeArtifactUploadMetadataV1(wire.subarray(0, wire.indexOf(10))));
                return Response.json(uploads.length === 1 ? row : { success: true });
            }
            writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json(path === '/v1/artifacts' ? row : { success: true, headerVersion: 3, bodyVersion: 4 });
        };
        const options = { request, retry: 'none' as const, serverId: 'kind-api-home' };
        const page = await fetchArtifactListPage({ token: 't' }, { ...options, coarseKind: 'skill', limit: 500 });
        expect(paths[0]).toBe(`/v1/artifacts?limit=500${supported ? '&kind=skill' : ''}`);
        expect(page.hasUnclassified).toBe(supported ? true : undefined);
        await createArtifact({ token: 't' }, { id: 'skill', kind: 'skill', header: 'header', body: 'body',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }, options);
        await updateArtifact({ token: 't' }, 'skill', { kind: 'skill', header: 'header', expectedHeaderVersion: 2 }, options);
        await restoreArtifactRevision({ token: 't' }, { artifactId: 'skill', kind: 'prompt', header: 'restored-header',
            bodyVersion: 1, expectedRevision: { headerVersion: 2, bodyVersion: 3 } }, options);
        expect(writes.map(write => write.kind)).toEqual(supported ? ['skill', 'skill', 'prompt'] : [undefined, undefined, undefined]);
        const blob = { blobId: '00000000-0000-4000-8000-000000000002', content: { t: 'plain' as const, v: 'AA==' } };
        await createArtifact({ token: 't' }, { id: '00000000-0000-4000-8000-000000000001', kind: 'plugin_ui',
            header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob }, options);
        await updateArtifact({ token: 't' }, '00000000-0000-4000-8000-000000000001', { kind: 'plugin_ui',
            header: 'header', expectedHeaderVersion: 2, body: 'body', expectedBodyVersion: 3, blob }, options);
        expect(uploads.map(input => input && typeof input === 'object' ? Reflect.get(input, 'artifactKind') : undefined))
            .toEqual(supported ? ['plugin_ui', 'plugin_ui'] : [undefined, undefined]);
    });

    it('refuses filtered responses without completeness metadata', async () => {
        advertise(true);
        await expect(fetchArtifactListPage({ token: 't' }, { serverId: 'kind-api-home', coarseKind: 'skill', retry: 'none',
            request: async () => Response.json({ items: [row] }) })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    });

    it('refreshes an expired enabled bit after the current Home disables filtering', async () => {
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const fixture = await createPlainArtifactHomeFixture('https://kind-disabled-home.test', {
            serverFeatures: { features: { artifacts: { kindFiltering: { enabled: false } } }, capabilities: {} },
        });
        try {
            primeServerFeaturesSnapshot({ serverId: fixture.home.id, ttlMs: -1, snapshot: { status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { artifacts: { kindFiltering: { enabled: true } } }, capabilities: {} }) } });
            const paths: string[] = [];
            const page = await fetchArtifactListPage({ token: 't' }, { serverId: fixture.home.id, coarseKind: 'skill', retry: 'none',
                request: async path => { paths.push(path); return Response.json([row]); } });
            expect(paths).toEqual(['/v1/artifacts']);
            expect(page.hasUnclassified).toBeUndefined();
        } finally { await fixture.dispose(); }
    });
});
