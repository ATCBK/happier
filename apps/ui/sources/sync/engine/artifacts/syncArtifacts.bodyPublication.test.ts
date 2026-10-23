import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createDeferred } from '@/dev/testkit';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { fetchAndApplyArtifactBodies, type ArtifactDataKeyCache } from './syncArtifacts';

afterEach(() => vi.useRealTimers());

function createHarness() {
    const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    const artifacts: Artifact[] = Array.from({ length: 6 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent({ title: `Receipt ${index}`, kind: 'approval_request.v1' }),
        body: encodePlainArtifactStoredContent({ body: `Receipt body ${index}` }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    // HTTP is the only substituted boundary; selection, decoding and the store stay real.
    const request = async (_path: string, init?: RequestInit) => {
        const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(JSON.parse(String(init?.body)));
        return Response.json({ items: artifactIds.map(artifactId => ({ artifactId, ok: true,
            artifact: artifacts.find(row => row.id === artifactId), recipientCensus: null })) });
    };
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const params = { credentials: { token: 'body-publication-fixture' }, encryption: null,
        artifactDataKeys, request,
        applyArtifacts: store.getState().applyArtifacts };
    return { store, artifacts, params };
}

describe('Artifact body hydration publications', () => {
    it('publishes one completed body batch once and suppresses an equal replay', async () => {
        const { store, artifacts, params } = createHarness();
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const read = () => fetchAndApplyArtifactBodies({ ...params, artifactIds: artifacts.map(row => row.id) });
        try {
            await read();
            expect(Object.values(store.getState().artifacts).map(row => row.body)).toEqual(artifacts.map((_, index) => `Receipt body ${index}`));
            expect(publications).toBe(1);
            const before = store.getState();
            await read();
            expect(store.getState()).toBe(before);
            expect(publications).toBe(1);
        } finally { off(); }
    });

    it('makes a ready body batch usable without advancing a publication timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { store, artifacts, params } = createHarness();
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const pending = fetchAndApplyArtifactBodies({ ...params, artifactIds: artifacts.map(row => row.id) });
        try {
            // HTTP/body decoding drains its microtasks, while publication timers stay frozen.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(Object.keys(store.getState().artifacts)).toHaveLength(6);
            expect(publications).toBe(1);
        } finally {
            await vi.runAllTimersAsync();
            await pending;
            off();
        }
    });

    it('does not hold ready bodies behind an unrelated unfinished read', async () => {
        const { store, artifacts, params } = createHarness();
        const held = createDeferred<Response>();
        const pending = fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => held.promise });
        try {
            await Promise.all(artifacts.slice(1).map(row => fetchAndApplyArtifactBodies({ ...params, artifactIds: [row.id] })));
            expect(Object.keys(store.getState().artifacts)).toHaveLength(5);
            expect(store.getState().artifacts[artifacts[0]!.id]).toBeUndefined();
        } finally {
            held.resolve(await params.request('/v1/artifacts/read', { body: JSON.stringify({ artifactIds: [artifacts[0]!.id] }) }));
            await pending;
        }
        expect(Object.keys(store.getState().artifacts)).toHaveLength(6);
    });

    it('rejects cancellation and Account retirement before body publication', async () => {
        const { store, artifacts, params } = createHarness();
        const response = createDeferred<Response>();
        const controller = new AbortController();
        let current = true;
        const pending = Promise.allSettled([
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => response.promise, signal: controller.signal }),
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], request: () => response.promise, shouldContinue: () => current }),
        ]);
        controller.abort();
        current = false;
        response.resolve(await params.request('/v1/artifacts/read', { body: JSON.stringify({ artifactIds: [artifacts[0]!.id] }) }));
        await pending;
        expect(store.getState().artifacts).toEqual({});
    });
});
