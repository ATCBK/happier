import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import * as approvalAdmission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useOpenApprovalArtifactsForSession } from '@/sync/domains/state/storage';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { fetchAndApplyArtifactBodies, fetchAndApplyArtifactsList, handleNewArtifactSocketUpdate, type ArtifactDataKeyCache } from './syncArtifacts';

afterEach(() => { standardCleanup(); vi.useRealTimers(); });

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
    it.each(['plain', 'e2ee'] as const)('admits a socket approval once through unchanged list/body revalidation (%s)', async mode => {
        const store = getStorage();
        const previous = store.getState();
        const target = { serverId: 'socket-refresh-home', sessionId: `socket-refresh-${mode}` };
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: target.sessionId }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
            origin: { kind: 'transcript_tool_call', sessionId: target.sessionId, toolCallId: 'native' } });
        const header = buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: target.serverId });
        const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(17)) : null;
        const dataKey = new Uint8Array(32).fill(18);
        const codec = new ArtifactEncryption(dataKey);
        const sealHeader = async (value: typeof header) => mode === 'plain'
            ? encodePlainArtifactStoredContent(value) : codec.encryptHeader(value);
        let artifact: Artifact = {
            id: mode === 'plain' ? '11111111-1111-4111-8111-111111111181' : '11111111-1111-4111-8111-111111111182',
            ownerAccountId: 'owner', access: 'owner', encryptionMode: mode, publicAudience: 'none', kind: 'other',
            header: await sealHeader(header), body: mode === 'plain'
                ? encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) : await codec.encryptBody({ body: JSON.stringify(approval) }),
            dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(dataKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        };
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const params = { credentials: { token: 'socket-refresh-fixture' }, encryption, artifactDataKeys,
            applyArtifacts: store.getState().applyArtifacts };
        let bodyReads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/artifacts?')) return Response.json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            expect(ArtifactReadBatchInputV1Schema.parse(JSON.parse(String(init?.body))).artifactIds).toEqual([artifact.id]);
            bodyReads++;
            return Response.json({ items: [{ artifactId: artifact.id, ok: true, artifact,
                recipientCensus: mode === 'plain' ? null : { artifactId: artifact.id, ownerAccountId: artifact.ownerAccountId,
                    access: artifact.access, encryptionMode: mode, dataEncryptionKey: artifact.dataEncryptionKey,
                    callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] } }] });
        };
        const refresh = () => {
            const startedWith = store.getState().artifacts;
            return fetchAndApplyArtifactsList({ ...params, request, inventoryReadStartedWith: startedWith,
                readCurrentArtifacts: () => store.getState().artifacts,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, source === 'inventory' ? startedWith : undefined) });
        };
        store.setState({ isDataReady: true, artifacts: {}, artifactsLoaded: true });
        const admit = vi.spyOn(approvalAdmission, 'approvalArtifactBodyMatchesHeaderV1');
        let publications = 0;
        const hook = await renderHook(() => {
            const selected = useOpenApprovalArtifactsForSession(target);
            publications++;
            return selected;
        });
        try {
            publications = 0;
            await act(async () => handleNewArtifactSocketUpdate({ ...params, ...artifact, artifactId: artifact.id,
                addArtifact: store.getState().addArtifact, invalidateArtifactsSync: () => {}, log: { log: () => {} } }));
            expect(hook.getCurrent()).toHaveLength(1);
            expect(admit).toHaveBeenCalledTimes(1);
            expect(publications).toBe(1);
            const arrived = hook.getCurrent();
            publications = 0;
            await act(async () => { await refresh(); });
            await act(async () => { await fetchAndApplyArtifactBodies({ ...params, request, artifactIds: [artifact.id] }); });
            expect(admit).toHaveBeenCalledTimes(1);
            expect(publications).toBe(0);
            expect(hook.getCurrent()).toBe(arrived);
            expect(bodyReads).toBe(1); // Only the explicit unchanged-body positive control, not the list.
            expect(store.getState().artifacts[artifact.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner' });

            // A new header revision cannot borrow the old admission, even with the same stored body.
            artifact = { ...artifact, headerVersion: 2, seq: 2, updatedAt: 2,
                header: await sealHeader({ ...header, title: 'Invalid duplicated approval title' }) };
            await act(async () => { await refresh(); });
            expect(hook.getCurrent()).toHaveLength(0);
            expect(admit.mock.calls.length).toBeGreaterThan(1);
            expect(bodyReads).toBe(2);
        } finally {
            await hook.unmount();
            admit.mockRestore();
            store.setState(previous);
        }
    });

    it('does not redemand a retained approval body on header refresh, but reads a changed revision', async () => {
        const { store, artifacts, params } = createHarness();
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        let artifact = { ...artifacts[0]!, kind: 'other' as const,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
        let reads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/artifacts?')) return Response.json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            expect(JSON.parse(String(init?.body)).artifactIds).toEqual([artifact.id]);
            reads += 1;
            return Response.json({ items: [{ artifactId: artifact.id, ok: true, artifact, recipientCensus: null }] });
        };
        const refresh = () => {
            const startedWith = store.getState().artifacts;
            return fetchAndApplyArtifactsList({ ...params, request, inventoryReadStartedWith: startedWith,
                readCurrentArtifacts: () => store.getState().artifacts,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, source === 'inventory' ? startedWith : undefined) });
        };
        await refresh();
        const opened = store.getState().artifacts[artifact.id];
        expect(opened?.body).toBe(JSON.stringify(approval));
        await refresh();
        expect(reads).toBe(1);
        expect(store.getState().artifacts[artifact.id]).toBe(opened);
        artifact = { ...artifact, bodyVersion: 2, seq: 2, updatedAt: 2,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...approval, updatedAtMs: 2 }) }) };
        await refresh();
        expect(reads).toBe(2);
        expect(store.getState().artifacts[artifact.id]?.body).toBe(JSON.stringify({ ...approval, updatedAtMs: 2 }));
    });

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
