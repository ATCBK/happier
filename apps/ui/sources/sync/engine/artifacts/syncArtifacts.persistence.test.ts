import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createDeferred } from '@/dev/testkit';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resetMmkvStoresForTests } from '@/dev/reactNativeMmkvStub';
import { CurrentCursorResponseSchema, ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentCursor = (cursor: number) => json(CurrentCursorResponseSchema.parse({ cursor, changesFloor: 0 }));
const scope = { serverId: 'inventory-home', accountId: 'inventory-person' };
function head(id: string, version = 1): Artifact {
    return { id, kind: 'prompt', header: encodePlainArtifactStoredContent({ title: id, kind: 'prompt_doc.v2' }),
        headerVersion: version, bodyVersion: version, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        seq: version, createdAt: 1, updatedAt: version };
}

async function load(request: (path: string, init?: RequestInit) => Promise<Response>, options: {
    scope?: typeof scope; credentials?: AuthCredentials; store?: StoreApi<ArtifactsDomain>;
} = {}) {
    const { prepareWarmCacheStorage } = await import('@/sync/domains/state/warmCachePersistence');
    await prepareWarmCacheStorage();
    const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
    const store = options.store ?? createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    let startedWith = store.getState().artifacts;
    const completion = fetchAndApplyArtifactsList({ credentials: options.credentials ?? { token: 'test-bearer' },
        encryption: null, artifactDataKeys: new Map(), inventoryScope: options.scope ?? scope, request,
        inventoryReadStartedWith: startedWith,
        hydrateArtifacts: rows => { store.getState().applyArtifacts(rows); startedWith = store.getState().artifacts; },
        applyArtifacts: (rows, source) => {
            store.getState().applyArtifacts(rows, source === 'inventory' ? startedWith : undefined);
        } });
    return { store, completion };
}

describe('device-persisted Artifact inventory through the real writer and store', () => {
    beforeEach(async () => {
        // Test-only MMKV boundary: all domain, storage placement, serialization and HTTP admission remain real.
        resetMmkvStoresForTests();
        vi.resetModules();
    });
    afterEach(() => vi.resetModules());

    async function seed(credentials?: AuthCredentials) {
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained'), head('deleted')]), { credentials });
        await first.completion;
        vi.resetModules(); // A new app process retains only device storage.
    }

    it('catches up 35000 closed documents through header inventory without body demand or a replay loop', async () => {
        await seed();
        const rows = Array.from({ length: 35000 }, (_, index) => head(`closed-${index}`));
        let bodyRequests = 0;
        let bodyIds = 0;
        let headerPages = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v2/cursor') return currentCursor(35010);
            if (path.startsWith('/v2/changes?')) {
                const after = Number(new URL(path, 'https://inventory.test').searchParams.get('after'));
                const offset = after - 10;
                const changed = rows.slice(offset, offset + 500);
                return json(ChangesResponseSchema.parse({ changes: changed.map((row, index) => ({
                    kind: 'artifact', entityId: row.id, cursor: after + index + 1, changedAt: 1,
                })), nextCursor: after + changed.length }));
            }
            if (path === '/v1/artifacts/read') {
                bodyRequests += 1;
                bodyIds += JSON.parse(String(init?.body)).artifactIds.length;
                return json({ error: 'artifact_content_unavailable' }, 500);
            }
            expect(path).toMatch(/^\/v1\/artifacts\?/);
            const query = new URL(path, 'https://inventory.test').searchParams;
            expect(query.has('includeBody')).toBe(false);
            const limit = Number(query.get('limit'));
            const page = rows.slice(headerPages * limit, (headerPages + 1) * limit);
            headerPages += 1;
            return json(page);
        };
        const next = await load(request);
        const failure = await next.completion.then(() => null, error => error);
        expect(bodyIds).toBe(0);
        expect(bodyRequests).toBe(0);
        expect(failure).toBeNull();
        expect(Object.keys(next.store.getState().artifacts)).toHaveLength(rows.length);
        expect(next.store.getState().artifactsLoaded).toBe(true);
        const completedPages = headerPages;
        vi.resetModules();
        const repeated = await load(request);
        await repeated.completion;
        expect(bodyRequests).toBe(0);
        expect(headerPages).toBe(completedPages);
        expect(repeated.store.getState().artifactsLoaded).toBe(true);
    });

    it('acquires an approval absent from the device headers through the retained change cursor', async () => {
        await seed();
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const artifact = { ...head('new-approval'), kind: 'other' as const,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
        const paths: string[] = [];
        const next = await load(async (path, init) => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(11);
            if (path.startsWith('/v2/changes?after=10&')) return json(ChangesResponseSchema.parse({ changes: [
                { kind: 'artifact', entityId: artifact.id, cursor: 11, changedAt: 1 },
            ], nextCursor: 11 }));
            if (path.startsWith('/v1/artifacts?')) return json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            expect(JSON.parse(String(init?.body)).artifactIds).toEqual([artifact.id]);
            return json(ArtifactReadBatchResponseV1Schema.parse({ items: [
                { artifactId: artifact.id, ok: true, artifact, recipientCensus: null },
            ] }));
        });
        await next.completion;
        expect(next.store.getState().artifacts[artifact.id]?.header?.kind).toBe('approval_request.v1');
        expect(next.store.getState().artifacts[artifact.id]?.body).toBe(JSON.stringify(approval));
        expect(next.store.getState().artifactsLoaded).toBe(true);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
    });

    it('settles at the captured change frontier while unrelated Account writes continue', async () => {
        await seed();
        let pages = 0;
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(11);
            pages += 1;
            if (pages > 3) return json({ changes: [], nextCursor: 13 });
            return json(ChangesResponseSchema.parse({ changes: [
                { kind: 'machine', entityId: 'busy-machine', cursor: 10 + pages, changedAt: 1 },
            ], nextCursor: 10 + pages }));
        });
        await expect(next.completion).resolves.toBeUndefined();
        expect(pages).toBe(1);
        expect(next.store.getState().artifactsLoaded).toBe(true);
    });

    it('backfills retained unclassified headers after Home upgrade without delaying inventory publication', async () => {
        const first = await load(async (path, init) => init?.method === 'POST' ? json({ error: 'unavailable' }, 503)
            : path === '/v2/cursor' ? currentCursor(10)
                : json([head('known'), { ...head('unclassified'), kind: null }]));
        await first.completion;
        vi.resetModules();
        const writeStarted = createDeferred<void>();
        const acknowledgement = createDeferred<Response>();
        const writes: unknown[] = [];
        const reloaded = await load(async (path, init) => {
            if (path === '/v2/cursor') return currentCursor(10);
            if (path.startsWith('/v2/changes?after=10&')) return json({ changes: [], nextCursor: 10 });
            expect(path).toBe('/v1/artifacts/unclassified');
            writes.push(JSON.parse(String(init?.body)));
            writeStarted.resolve();
            return acknowledgement.promise;
        });
        try {
            await reloaded.completion;
            expect(reloaded.store.getState().artifactsLoaded).toBe(true);
            expect(reloaded.store.getState().artifacts.known?.kind).toBe('prompt');
            await writeStarted.promise;
            expect(writes).toEqual([{ kind: 'prompt', expectedHeaderVersion: 1 }]);
        } finally { acknowledgement.resolve(json({ success: true })); }
    });

    it('repairs null and stale kinds from opened headers, skips locked rows and stops writing after the server echo', async () => {
        const rows: Artifact[] = [head('known'), { ...head('unclassified'), kind: null },
            { ...head('board'), kind: 'other', header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', title: 'Board' }) },
            { ...head('locked'), kind: null, encryptionMode: 'e2ee', dataEncryptionKey: 'unavailable-key', header: 'ciphertext' }];
        rows.push({ ...head('layout'), kind: 'other', header: encodePlainArtifactStoredContent({ kind: 'widget-area-layout.v1', title: 'My view' }) });
        const before = rows.map(row => ({ ...row }));
        const writes: unknown[] = [];
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v2/cursor') return currentCursor(10);
            if (init?.method !== 'POST') return json(rows);
            const write = JSON.parse(String(init.body));
            writes.push({ path, write });
            const row = rows.find(row => path === `/v1/artifacts/${row.id}`);
            if (!row) throw new Error(`Unexpected Artifact write: ${path}`);
            row.kind = write.kind;
            return json({ success: true });
        };
        const first = await load(request);
        await first.completion;
        await vi.waitFor(() => expect(writes).toEqual(expect.arrayContaining([
            { path: '/v1/artifacts/unclassified', write: { kind: 'prompt', expectedHeaderVersion: 1 } },
            { path: '/v1/artifacts/board', write: { kind: 'work_board', expectedHeaderVersion: 1 } },
            { path: '/v1/artifacts/layout', write: { kind: 'widget_area_layout', expectedHeaderVersion: 1 } },
        ])));
        expect(first.store.getState().artifacts.locked?.isDecrypted).toBe(false);
        expect(rows.map(({ kind: _kind, ...row }) => row)).toEqual(before.map(({ kind: _kind, ...row }) => row));
        // A fresh inventory observes the repaired metadata; it neither rewrites
        // already-correct rows nor makes unreadable ciphertext classification guesses.
        const next = await load(request, { scope: { ...scope, serverId: 'fresh-inventory' } });
        await next.completion;
        expect(writes).toHaveLength(3);
        expect(next.store.getState().artifacts.board?.kind).toBe('work_board');
    });

    it('hydrates stale rows before catch-up, then refreshes changed and deleted headers without reading bodies', async () => {
        await seed();
        const gate = createDeferred<Response>();
        const paths: string[] = [];
        const reloaded = await load(async path => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(12);
            if (path.startsWith('/v2/changes?after=10&')) return gate.promise;
            if (path.startsWith('/v2/changes?after=12&')) return json({ changes: [], nextCursor: 12 });
            if (path.startsWith('/v1/artifacts?')) return json([head('retained', 2)]);
            expect(path).not.toBe('/v1/artifacts/read');
            return json([]);
        });
        try {
            await vi.waitFor(() => expect(reloaded.store.getState().artifacts.retained?.title).toBe('retained'));
            expect(reloaded.store.getState().artifactsLoaded).toBe(false);
        } finally {
            gate.resolve(json(ChangesResponseSchema.parse({ changes: [
                { kind: 'artifact', entityId: 'retained', cursor: 11, changedAt: 1 },
                { kind: 'artifact', entityId: 'deleted', cursor: 12, changedAt: 1 },
            ], nextCursor: 12 })));
            await reloaded.completion;
        }
        expect(Object.keys(reloaded.store.getState().artifacts)).toEqual(['retained']);
        expect(reloaded.store.getState().artifacts.retained?.headerVersion).toBe(2);
        expect(reloaded.store.getState().artifactsLoaded).toBe(true);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
        vi.resetModules();
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(12);
            expect(path).toMatch(/^\/v2\/changes\?after=12&/);
            return json({ changes: [], nextCursor: 12 });
        });
        await next.completion;
        expect(Object.keys(next.store.getState().artifacts)).toEqual(['retained']);
    });

    it('falls back to a full listing only when the retained cursor is gone', async () => {
        await seed();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            if (path.startsWith('/v2/changes')) return json({ error: 'cursor-gone', currentCursor: 30 }, 410);
            if (path === '/v2/cursor') return currentCursor(30);
            return json([head('replacement')]);
        });
        await next.completion;
        expect(Object.keys(next.store.getState().artifacts)).toEqual(['replacement']);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
    });

    it.each(['account', 'home', 'key', 'credential'] as const)('isolates persisted inventory on %s changes', async change => {
        await seed({ token: 'test-bearer', secret: 'test-only-material-a' });
        const gate = createDeferred<Response>();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(20);
            return gate.promise;
        }, { scope: change === 'account' ? { ...scope, accountId: 'another-person' }
            : change === 'home' ? { ...scope, serverId: 'another-home' } : scope,
            credentials: { token: change === 'credential' ? 'another-test-bearer' : 'test-bearer',
                secret: change === 'key' ? 'test-only-material-b' : 'test-only-material-a' } });
        try {
            await vi.waitFor(() => expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true));
            expect(next.store.getState().artifacts).toEqual({});
            expect(next.store.getState().artifactsLoaded).toBe(false);
        } finally { gate.resolve(json([])); await next.completion; }
    });

    it('keeps failed catch-up last-known, without granting coverage or starting a full listing', async () => {
        await seed();
        const paths: string[] = [];
        const next = await load(async path => { paths.push(path); return path === '/v2/cursor'
            ? currentCursor(11) : json({ error: 'unavailable' }, 503); });
        await expect(next.completion).rejects.toThrow('Artifact inventory changes are unavailable');
        expect(next.store.getState().artifacts.retained?.title).toBe('retained');
        expect(next.store.getState().artifactsLoaded).toBe(false);
        expect(paths.every(path => path === '/v2/cursor' || path.startsWith('/v2/changes?after=10&'))).toBe(true);
    });

    it('preserves demanded body and custody identity during an unchanged warm refresh', async () => {
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained')]));
        await first.completion;
        const retained = first.store.getState().artifacts.retained;
        if (!retained?.isDecrypted) throw new Error('Expected an opened inventory header');
        const opened = { ...retained, body: 'demanded body',
            storageIdentity: { contentKeyEnvelope: 'test-only-envelope', provenanceKeyEnvelope: null } };
        first.store.getState().updateArtifact(opened);
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(10);
            expect(path).toMatch(/^\/v2\/changes\?after=10&/);
            return json({ changes: [], nextCursor: 10 });
        }, { store: first.store });
        await next.completion;
        expect(next.store.getState().artifacts.retained).toBe(opened);
    });

    it('removes the Home inventory on the real credential-removal path', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const home = await upsertAndActivateServer({ serverUrl: 'https://inventory-signout.test', scope: 'device' });
        const localScope = { ...scope, serverId: home.id };
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained')]), { scope: localScope });
        await first.completion;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBe(true);
        vi.resetModules();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            return path === '/v2/cursor' ? currentCursor(20) : json([]);
        }, { scope: localScope });
        await next.completion;
        expect(next.store.getState().artifacts).toEqual({});
        expect(paths.some(path => path.startsWith('/v2/changes'))).toBe(false);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
    });
});
