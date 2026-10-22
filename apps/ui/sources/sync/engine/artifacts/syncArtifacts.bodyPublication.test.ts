import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createDeferred } from '@/dev/testkit';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
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
    it('publishes concurrently completed exact reads together and suppresses an equal replay', async () => {
        const { store, artifacts, params } = createHarness();
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const read = () => Promise.all(artifacts.map(row => fetchAndApplyArtifactBodies({ ...params, artifactIds: [row.id] })));
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

    it('coalesces body completions from separate response turns within the existing hydration window', async () => {
        vi.useFakeTimers();
        const { store, artifacts, params } = createHarness();
        const windowMs = loadSyncTuning().sessionListBackgroundHydrationApplyFlushDelayMs;
        let publications = 0;
        const off = store.subscribe((next, previous) => {
            if (next.artifacts !== previous.artifacts) publications++;
        });
        const pending = Promise.all(artifacts.map((row, index) => fetchAndApplyArtifactBodies({ ...params, artifactIds: [row.id],
            request: async (path, init) => {
                await new Promise(resolve => setTimeout(resolve, windowMs * (index + 1) / (artifacts.length + 1)));
                return params.request(path, init);
            } })));
        try {
            await vi.runAllTimersAsync();
            await pending;
            expect(Object.keys(store.getState().artifacts)).toHaveLength(6);
            expect(publications).toBe(1);
        } finally { off(); }
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

    it('readmits cancellation and Account retirement immediately before a queued publication', async () => {
        vi.useFakeTimers();
        const { store, artifacts, params } = createHarness();
        const controller = new AbortController();
        let current = true;
        const pending = Promise.allSettled([
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[0]!.id], signal: controller.signal }),
            fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifacts[1]!.id], shouldContinue: () => current }),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        current = false;
        await vi.runAllTimersAsync();
        await pending;
        expect(store.getState().artifacts).toEqual({});
    });
});
