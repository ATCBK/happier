import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as nativeCrypto from 'rn-encryption';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1, type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { createDeferred, createSessionFixture, createSessionAccessFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fetchAndApplySessionById, type SessionListRowPublication } from './sessionById';
import { fetchAndApplySessions } from './sessionSnapshot';
import { parseDecryptedSessionMetadata } from './parsePlainSessionPayload';
import { flushActivityUpdates, handleUpdateContainer } from '../socket/socket';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createOperationAccountCurrentnessSource, getScopedSessionByIdEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

const currentness = {
    mode: 'e2ee', version: 1, updatedAt: 1,
    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current',
    recipientEnvelopeReadiness: { status: 'available' },
} satisfies AccountEncryptionCurrentnessResponse;
const sharedMetadata = { v: 1, summary: { text: 'Known shared title', updatedAt: 1 } };
const sessionId = 'hydration-publication';
const serverId = 'home-publication';
const initialStorageState = storage.getInitialState();

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function createHydrationContext() {
    const keys = tweetnacl.box.keyPair();
    const credentials = { token: 't', encryption: {
        publicKey: encodeBase64(keys.publicKey), machineKey: encodeBase64(keys.secretKey),
    } };
    const encryption = await Encryption.createFromContentKeyPair({ publicKey: keys.publicKey, machineKey: keys.secretKey });
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const dataKey = new Uint8Array(32).fill(7);
    await encryption.initializeSessions(new Map([[sessionId, dataKey]]), { serverId });
    const metadata = await encryption.getSessionEncryption(sessionId)!.encryptRaw(sharedMetadata);
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: keys.publicKey,
        randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const row = {
        id: sessionId, seq: 3, createdAt: 1, updatedAt: 2, active: true, activeAt: 2, archivedAt: null,
        encryptionMode: 'e2ee' as const, dataEncryptionKey: envelope,
        metadataLayoutVersion: 1, metadataVersion: 4, metadata,
        agentStateVersion: 5, agentState: null,
        share: { accessLevel: 'view', canApprovePermissions: false },
    };
    const session = createSessionFixture({
        ...row, encryptionMode: 'e2ee', serverId,
        metadata: parseDecryptedSessionMetadata(sharedMetadata, 1),
        ownerMetadataView: null, access: createSessionAccessFixture('view'), accessLevel: 'view',
    });
    storage.setState({ sessions: { [sessionId]: session }, sessionListRowsByServerId: {} });
    const sessionDataKeys = new Map([[sessionId, dataKey]]);
    const sessionDataKeyEnvelopes = new Map([[sessionId, envelope]]);
    const params = {
        serverId, credentials, accountCurrentness: currentness, encryption,
        sessionDataKeys, sessionDataKeyEnvelopes,
        applySessions: storage.getState().applySessions,
        getExistingSession: (id: string) => storage.getState().sessions[id],
        log: { log: () => {} },
    };
    return { row, params, encryption };
}

afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(initialStorageState, true);
});

describe('Session hydration publication', () => {
    it('publishes one physical plain Session batch without a publication timer', async () => {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const ids = Array.from({ length: 6 }, (_, index) => `concurrent-hydration-${index}`);
        const response = createDeferred<Response>();
        const issued = createDeferred<void>();
        const requests: Array<{ path: string; ids: readonly string[] }> = [];
        const credentials = { token: 't' };
        const readTransport = createCapturedServerReadTransport({ serverId, credentials, prepared: {
            endpointUrl: 'https://home-publication.example', generation: 1,
            request: async (path, init, _options, consume) => {
                requests.push({ path, ids: JSON.parse(String(init?.body)).sessionIds });
                issued.resolve();
                return await consume(await response.promise);
            },
        } });
        const directRequest = vi.fn(async () => { throw new Error('A captured Account read must use its batch transport'); });
        const publications: string[][] = [];
        const unsubscribe = storage.subscribe((next, previous) => {
            if (next.sessions !== previous.sessions) publications.push(Object.keys(next.sessions));
        });
        const hydration = Promise.all(ids.map(id => fetchAndApplySessionById({
            serverId, sessionId: id, includeTurnsProjection: false, accessProjectionVersion: 1,
            credentials, readTransport,
            accountCurrentness: { mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null },
            encryption: getScopedSessionByIdEncryption(null), sessionDataKeys: new Map(),
            applySessions: storage.getState().applySessions,
            getExistingSession: sessionId => storage.getState().sessions[sessionId],
            log: { log: () => {} },
            request: directRequest,
        }).then(result => {
            expect(result.ok).toBe(true);
            expect(result.session).toBe(storage.getState().sessions[id]);
            return result;
        })));
        try {
            await issued.promise;
            expect(requests).toEqual([{ path: '/v2/sessions/read-batch', ids }]);
            expect(directRequest).not.toHaveBeenCalled();
            response.resolve(jsonResponse({ results: ids.map(id => ({ sessionId: id,
                detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id }) } },
            })) }));
            // HTTP and decoder microtasks finish, but no publication timeout advances.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(publications).toHaveLength(1);
            expect(Object.keys(storage.getState().sessions)).toHaveLength(ids.length);
            await vi.runAllTimersAsync();
            const results = await hydration;
            expect(results).toHaveLength(ids.length);
            expect(publications).toHaveLength(1);
            expect([...publications[0]].sort()).toEqual([...ids].sort());
        } finally {
            response.resolve(jsonResponse({ results: [] }));
            await vi.runAllTimersAsync();
            await hydration;
            vi.useRealTimers();
            unsubscribe();
        }
    });

    it('publishes one physical E2EE Session batch together', async () => {
        const { row, params } = await createHydrationContext();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const ids = Array.from({ length: 6 }, (_, index) => `concurrent-encrypted-hydration-${index}`);
        const read = vi.fn(async (_path: string, init?: RequestInit) => jsonResponse({ results:
            (JSON.parse(String(init?.body)).sessionIds as string[]).map(id => ({
                sessionId: id, detail: { status: 200, body: { session: { ...row, id } } },
            })),
        }));
        const readTransport = createCapturedServerReadTransport({ serverId, credentials: params.credentials, prepared: {
            endpointUrl: 'https://home-publication.example', generation: 1,
            request: async (path, init, _options, consume) => await consume(await read(path, init)),
        } });
        const publications: string[][] = [];
        const unsubscribe = storage.subscribe((next, previous) => {
            if (next.sessions !== previous.sessions) publications.push(Object.keys(next.sessions));
        });
        try {
            const results = await Promise.all(ids.map(id => fetchAndApplySessionById({
                ...params, sessionId: id, includeTurnsProjection: false, readTransport,
                request: async () => { throw new Error('Expected captured Session batch'); },
            })));
            expect(results.every(result => result.ok)).toBe(true);
            expect(publications).toHaveLength(1);
            expect([...publications[0]].sort()).toEqual([...ids].sort());
            expect(read).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
    });

    it.each(['retirement', 'witness-withdrawal'] as const)('readmits a prepared physical-batch row after %s', async change => {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const home = 'home-publication-final-fence';
        const ids = ['prepared-then-retired', 'fresh-witness-pending'];
        const credentials = { token: 't' };
        const started = createDeferred<void>();
        const currentnessResponse = createDeferred<Response>();
        const controller = new AbortController();
        const plainCurrentness = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let rereads = 0;
        const readyCurrentness = createOperationAccountCurrentnessSource({ credentials, serverId: home, initial: plainCurrentness,
            request: async path => {
                expect(path).toBe('/v1/account/encryption/currentness');
                rereads++;
                return jsonResponse(plainCurrentness);
            },
        });
        const batches: string[][] = [];
        const readTransport = createCapturedServerReadTransport({ serverId: home, credentials, prepared: {
            endpointUrl: 'https://home-publication.example', generation: 1,
            request: async (_path, init, _options, consume) => {
                const selected = JSON.parse(String(init?.body)).sessionIds as string[];
                batches.push(selected);
                return await consume(jsonResponse({ results: selected.map(id => ({ sessionId: id,
                    detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id }) } },
                })) }));
            },
        } });
        const applySessionListRows = (rows: readonly SessionListRowPublication[]) => storage.getState().applyServerScopedSessionListRows(
            home, rows.map(entry => entry.row), { source: 'rowOnly', mode: 'append' },
        );
        let publications = 0;
        const unsubscribe = storage.subscribe((next, previous) => {
            if (next.sessionListRowsByServerId[home] !== previous.sessionListRowsByServerId[home]) publications++;
        });
        const reads = ids.map((id, index) => fetchAndApplySessionById({
            serverId: home, sessionId: id, credentials, readTransport, contentDemand: 'list-projection',
            includeTurnsProjection: false, accessProjectionVersion: 1,
            ...(index === 0 ? { signal: controller.signal, accountCurrentness: plainCurrentness,
                ensureAccountCurrentness: readyCurrentness.ensureCurrent, isCurrent: readyCurrentness.isCurrent,
            } : {}),
            encryption: getScopedSessionByIdEncryption(null), sessionDataKeys: new Map(),
            applySessions: storage.getState().applySessions, applySessionListRows, log: { log: () => {} },
            request: async path => {
                expect(path).toBe('/v1/account/encryption/currentness');
                started.resolve();
                return await currentnessResponse.promise;
            },
        }));
        try {
            await started.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(batches).toEqual([ids]);
            expect(publications).toBe(0);
            if (change === 'retirement') controller.abort();
            else invalidateAccountEncryptionModeCache({ serverId: home, reason: 'transport-withdrawal' });
            currentnessResponse.resolve(jsonResponse({ mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null,
            }));
            const results = await Promise.all(reads);
            if (change === 'retirement') expect(results[0]).toMatchObject({ ok: false, errorCode: 'stale_response' });
            else {
                expect(results[0].ok).toBe(true);
                expect(rereads).toBe(1);
            }
            expect(results[1].ok).toBe(true);
            expect(Object.keys(storage.getState().sessionListRowsByServerId[home])).toEqual(change === 'retirement' ? [ids[1]] : ids);
            expect(publications).toBe(1);
        } finally {
            currentnessResponse.resolve(jsonResponse({ mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null,
            }));
            await Promise.allSettled(reads);
            readyCurrentness.dispose();
            unsubscribe();
        }
    });

    it('refuses a retired exact reader during opening and lets the next reader recover', async () => {
        const { row, params } = await createHydrationContext();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const decrypt = nativeCrypto.decryptAsyncAES;
        const native = vi.spyOn(nativeCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            started.resolve();
            await release.promise;
            return await decrypt(...args);
        });
        const controller = new AbortController();
        const publications = vi.fn();
        const unsubscribe = storage.subscribe(publications);
        try {
            const hydration = fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false, signal: controller.signal,
                prefetched: { detail: { status: 200, body: { session: row } } },
                request: async () => jsonResponse({ session: row }),
            });
            await started.promise;
            controller.abort();
            release.resolve();
            expect(await hydration).toMatchObject({ ok: false, errorCode: 'stale_response' });
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
            expect(publications).not.toHaveBeenCalled();
            native.mockRestore();
            const recovered = await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false,
                request: async () => jsonResponse({ session: row }),
            });
            expect(recovered.ok).toBe(true);
            expect(recovered.session).toBe(storage.getState().sessions[sessionId]);
            expect(publications).toHaveBeenCalledTimes(1);
        } finally {
            release.resolve();
            native.mockRestore();
            unsubscribe();
        }
    });

    it('publishes a completed physical batch without waiting for an unrelated slow physical batch', async () => {
        const { row, params } = await createHydrationContext();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const slowResponse = createDeferred<Response>();
        const slowStarted = createDeferred<void>();
        const slowId = 'slow-hydration';
        const requests: string[][] = [];
        const readTransport = createCapturedServerReadTransport({ serverId, credentials: params.credentials, prepared: {
            endpointUrl: 'https://home-publication.example', generation: 1,
            request: async (_path, init, _options, consume) => {
                const ids = JSON.parse(String(init?.body)).sessionIds as string[];
                requests.push(ids);
                if (ids.includes(slowId)) { slowStarted.resolve(); return await consume(await slowResponse.promise); }
                return await consume(jsonResponse({ results: ids.map(id => ({ sessionId: id,
                    detail: { status: 200, body: { session: { ...row, id } } },
                })) }));
            },
        } });
        const slow = fetchAndApplySessionById({
            ...params, sessionId: slowId, includeTurnsProjection: false, readTransport,
            request: async () => { throw new Error('Expected captured Session batch'); },
        });
        try {
            await slowStarted.promise;
            const fast = await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false, readTransport,
                request: async () => { throw new Error('Expected captured Session batch'); },
            });
            expect(fast.ok).toBe(true);
            expect(fast.session).toBe(storage.getState().sessions[sessionId]);
            expect(storage.getState().sessions[slowId]).toBeUndefined();
            expect(requests).toEqual([[slowId], [sessionId]]);
        } finally {
            slowResponse.resolve(jsonResponse({ results: [{ sessionId: slowId,
                detail: { status: 200, body: { session: { ...row, id: slowId } } },
            }] }));
            expect((await slow).ok).toBe(true);
        }
    });

    it('keeps competing Homes for the same Session id from entering one publication', async () => {
        const { row, params } = await createHydrationContext();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const results = await Promise.all(['home-a', 'home-b'].map(home => fetchAndApplySessionById({
            ...params, serverId: home, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: row }),
        })));
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(results.filter(result => !result.ok)).toMatchObject([{ errorCode: 'stale_response' }]);
        expect(results.find(result => result.ok)?.session).toBe(storage.getState().sessions[sessionId]);
    });

    it('excludes a plaintext wire title from parsed HTTP hydration and list publication', async () => {
        const { row, params } = await createHydrationContext();
        const wireTitle = 'Untrusted plaintext wire title';
        const published: Array<Parameters<typeof params.applySessions>[0][number]> = [];
        storage.setState({ sessions: {} });
        await fetchAndApplySessions({
            ...params,
            awaitSessionListHydration: true,
            request: async () => jsonResponse({ sessions: [{ ...row, lockedDisplayTitle: wireTitle }], hasNext: false }),
            applySessions: (sessions) => {
                published.push(...sessions);
                params.applySessions(sessions);
            },
        });
        expect(published).toHaveLength(1);
        expect(published[0]).not.toHaveProperty('lockedDisplayTitle');
        expect(getSessionName(storage.getState().sessions[sessionId])).toBe(sharedMetadata.summary.text);
        expect(getSessionName(storage.getState().sessionListRowsByServerId[serverId][sessionId])).toBe(sharedMetadata.summary.text);
    });

    it('retains observed presence across durable by-ID hydration', async () => {
        const { row, params } = await createHydrationContext();
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
        expect(Object.hasOwn(row, 'presence')).toBe(false);

        const result = await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: row }),
        });

        expect(result.ok).toBe(true);
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.presence).toBe('online');
    });

    it('retains observed presence when a durable list refresh republishes the Session summary', async () => {
        const { row, params } = await createHydrationContext();
        params.applySessions([storage.getState().sessions[sessionId]]);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.presence).toBe('online');
        const publishedPresence: Array<SessionListRenderableSession['presence']> = [];

        await fetchAndApplySessions({
            ...params,
            awaitSessionListHydration: true,
            request: async () => jsonResponse({ sessions: [{ ...row, metadataVersion: row.metadataVersion + 1 }], hasNext: false }),
            getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
            applySessionListRenderables: rows => {
                storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' });
                publishedPresence.push(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.presence);
            },
        });

        expect(storage.getState().sessions[sessionId].presence).toBe('online');
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.presence).toBe('online');
        expect(publishedPresence.length).toBeGreaterThan(0);
        expect(publishedPresence.every(presence => presence === 'online')).toBe(true);
    });

    it('applies explicit ephemeral offline and online observations to hydrated sessions', async () => {
        const { params } = await createHydrationContext();
        const observe = (active: boolean, activeAt: number) => flushActivityUpdates({
            updates: new Map([[sessionId, { type: 'activity', id: sessionId, active, activeAt, thinking: false }]]),
            applySessions: params.applySessions,
            sourceServerId: serverId,
        });

        observe(false, 3);
        expect(storage.getState().sessions[sessionId].presence).toBe(3);
        const { presence: _presence, ...durableSession } = storage.getState().sessions[sessionId];
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBe(3);
        observe(true, 4);
        expect(storage.getState().sessions[sessionId].presence).toBe('online');
    });

    it('routes ephemeral presence to its Home when another Home has hydrated the same Session id', async () => {
        const { params } = await createHydrationContext();
        const hydrated = storage.getState().sessions[sessionId];
        const otherHome = 'other-home';
        storage.setState({ sessionListRowsByServerId: {
            [otherHome]: { [sessionId]: buildSessionListRenderableFromSession({ ...hydrated, serverId: otherHome }) },
        } });

        flushActivityUpdates({
            updates: new Map([[sessionId, { type: 'activity', id: sessionId, active: false, activeAt: 3, thinking: false }]]),
            applySessions: params.applySessions,
            sourceServerId: otherHome,
        });

        expect(storage.getState().sessions[sessionId]).toBe(hydrated);
        await vi.waitFor(() => {
            const row = storage.getState().sessionListRowsByServerId[otherHome]?.[sessionId];
            expect({ active: row?.active, presence: row?.presence, activeAt: row?.activeAt }).toEqual({
                active: false, presence: 3, activeAt: 3,
            });
        });
    });

    it('preserves omitted presence only within its Home and never overrides explicit invalidation', async () => {
        const { params } = await createHydrationContext();
        const { presence: _presence, ...durableSession } = storage.getState().sessions[sessionId];

        params.applySessions([{ ...durableSession, presence: undefined }]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();

        params.applySessions([{ ...durableSession, presence: 'online' }]);
        params.applySessions([{ ...durableSession, serverId: 'another-home' }]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();

        storage.setState({ sessions: {} });
        params.applySessions([durableSession]);
        expect(storage.getState().sessions[sessionId].presence).toBeUndefined();
    });

    it('does not publish stale socket metadata after by-ID hydration cleared its reader', async () => {
        const { row, params, encryption } = await createHydrationContext();
        // The socket opens content only while the real transcript owner demands it.
        onTestFinished(registerSessionRealtimeTranscriptConsumer(sessionId, serverId));
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const decrypt = nativeCrypto.decryptAsyncAES;
        // Delay only the platform crypto operation, retaining the real socket owner.
        vi.spyOn(nativeCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            started.resolve();
            await release.promise;
            return await decrypt(...args);
        });
        const socket = handleUpdateContainer({
            updateData: { id: 'update', seq: 3, createdAt: 2, body: { ...row, t: 'new-session' } },
            encryption, sourceServerId: serverId, artifactDataKeys: new Map(),
            applySessions: params.applySessions, fetchSessions: () => {},
            applyMessages: () => {}, onSessionVisible: () => {}, isSessionMessagesLoaded: () => false,
            getSessionMaterializedMaxSeq: () => 0, markSessionMaterializedMaxSeq: () => {},
            onMessageGapDetected: () => {}, assumeUsers: async () => {}, applyTodoSocketUpdates: async () => {},
            invalidateMachines: () => {}, invalidateSessions: () => {}, invalidateArtifacts: () => {},
            invalidateFriends: () => {}, invalidateFriendRequests: () => {}, invalidateFeed: () => {},
            invalidateAutomations: () => {}, invalidateTodos: () => {}, log: params.log,
        });
        await started.promise;
        try {
            await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false,
                request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
            });
            expect(storage.getState().sessions[sessionId].encryptedContentAvailability).toBe('encrypted_access_needs_repair');
        } finally {
            release.resolve();
        }
        await socket;
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            metadata: null, encryptedContentAvailability: 'encrypted_access_needs_repair',
        });
    });

    it('does not publish an old successful decrypt after its reader was cleared during foreground hydration', async () => {
        const { row, params, encryption } = await createHydrationContext();
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const decrypt = nativeCrypto.decryptAsyncAES;
        // The native AES boundary is delayed; hydration, crypto, generation ownership,
        // tuple ordering, store application and display projections remain real.
        vi.spyOn(nativeCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
            started.resolve();
            await release.promise;
            return await decrypt(...args);
        });
        const snapshot = fetchAndApplySessions({
            ...params,
            request: async () => jsonResponse({ sessions: [row], nextCursor: null, hasNext: false }),
        });
        await started.promise;
        try {
            const locked = await fetchAndApplySessionById({
                ...params, sessionId, includeTurnsProjection: false,
                request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
            });
            expect(locked.ok).toBe(true);
            expect(encryption.getSessionEncryption(sessionId)).toBeNull();
            expect(storage.getState().sessions[sessionId].encryptedContentAvailability).toBe('encrypted_access_needs_repair');
        } finally {
            release.resolve();
        }
        await snapshot;
        expect(storage.getState().sessions[sessionId]).toMatchObject({
            metadata: null, encryptedContentAvailability: 'encrypted_access_needs_repair',
        });
    });

    it('keeps only the shared title through a recipient lock and drops it when access or Home changes', async () => {
        const { row, params } = await createHydrationContext();
        await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: { ...row, dataEncryptionKey: 'unopenable-envelope' } }),
        });
        const locked = storage.getState().sessions[sessionId];
        expect(locked.metadata).toBeNull();
        expect(locked.ownerMetadataView).toBeNull();
        expect(getSessionName(locked)).toBe(sharedMetadata.summary.text);
        expect(getSessionName(buildSessionListRenderableFromSession(locked))).toBe(sharedMetadata.summary.text);

        storage.getState().applySessions([{ ...locked,
            encryptedContentAvailability: 'ready', metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
        }]);
        expect(getSessionName(storage.getState().sessions[sessionId])).not.toBe(sharedMetadata.summary.text);

        storage.getState().applySessions([{ ...locked, serverId: 'other-home' }]);
        expect(getSessionName(storage.getState().sessions[sessionId])).not.toBe(sharedMetadata.summary.text);
        storage.getState().applySessions([{ ...locked, access: createSessionAccessFixture('owner'), accessLevel: undefined }]);
        const owner = storage.getState().sessions[sessionId];
        expect(getSessionName(owner)).not.toBe(sharedMetadata.summary.text);
        expect(isUserFacingSession(owner)).toBe(false);
    });

    it('retains the trusted locked title during a warm HTTP list refresh without accepting a wire title', async () => {
        const { row, params } = await createHydrationContext();
        const lockedRow = { ...row, dataEncryptionKey: 'unopenable-envelope', lockedDisplayTitle: 'Untrusted wire title' };
        await fetchAndApplySessionById({
            ...params, sessionId, includeTurnsProjection: false,
            request: async () => jsonResponse({ session: lockedRow }),
        });
        const published: SessionListRenderableSession[] = [];
        await fetchAndApplySessions({
            ...params, awaitSessionListHydration: true, requiredHydrationSessionIds: [sessionId],
            request: async () => jsonResponse({ sessions: [lockedRow], hasNext: false }),
            getCurrentSessionListRenderable: (id) => storage.getState().sessionListRowsByServerId[serverId]?.[id],
            applySessionListRenderables: (rows) => published.push(...rows),
        });
        expect(published).toHaveLength(1);
        expect(getSessionName(published[0])).toBe(sharedMetadata.summary.text);
        expect(published[0].metadata).toBeNull();
        expect(published[0].lockedDisplayTitle).toBe(sharedMetadata.summary.text);
    });
});
