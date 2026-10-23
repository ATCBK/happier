import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import * as routes from '@/sync/domains/transfers/runtime/transferRouteCache';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('cache-routing');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

const rows = () => h.storage.getState().sessionListRowsByServerId[h.homeB.id];
const machines = () => h.storage.getState().machineListByServerId[h.homeB.id];
const route = (serverId = h.homeB.id, remoteMachineId = 'machine-b') => ({ serverId, remoteMachineId });

describe('concurrent session cache socket routing', () => {
    it.each(['existing cipher', 'first cipher'] as const)(
        'does not let a retained credential replace the current scoped Account owner (%s)', async initialMaterial => {
            const original = initialMaterial === 'existing cipher'
                ? { token: h.homeB.token, secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') }
                : { token: h.homeB.token };
            await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
                credentials: original, encryptionMode: 'e2ee',
            });
            h.setResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                ? Response.json({ mode: 'e2ee', version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } })
                : null);
            await h.start(); await h.ready();
            // Hold the existing reconciliation timer at the OS clock boundary.
            // The still-managed Home can receive page demand during rotation.
            vi.useFakeTimers();
            try {
                const replacement = { token: h.homeB.token,
                    secret: encodeBase64(new Uint8Array(32).fill(42), 'base64url') };
                expect(await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl,
                    { serverId: h.homeB.id }, replacement)).toBe(true);
                const current = await resolveScopedAccountEncryption({ serverId: h.homeB.id,
                    serverUrl: h.homeB.serverUrl, credentials: replacement });
                if (!current) throw new Error('Expected replacement Account material');
                const captured = current.getCurrentEncryptionGenerationScope();
                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);

                // The old entry may fail closed, but must never register its old
                // material again and retire the newly admitted Account owner.
                await Promise.allSettled([h.fetchConcurrentSessionListQueryPage(h.homeB.id, {
                    source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
                    membership: 'rowOnly', signal: new AbortController().signal,
                })]);

                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);
            } finally { vi.useRealTimers(); }
        },
    );

    it('catches demanded Run activity up through the actual concurrent Home reconnect', async () => {
        const { subscribeExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const activeActivity = vi.fn();
        const concurrentActivity = vi.fn();
        const releaseActive = subscribeExecutionRunActivity({ serverId: h.homeA.id, sessionId: 'roster-session' }, activeActivity);
        const releaseConcurrent = subscribeExecutionRunActivity({ serverId: h.homeB.id, sessionId: 'roster-session' }, concurrentActivity);
        try {
            await h.start(); await h.ready();
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            concurrentActivity.mockClear();
            h.socket().trigger('disconnect', 'transport close');
            h.socket().trigger('connect');
            expect(concurrentActivity).toHaveBeenCalledTimes(1);
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            expect(activeActivity).not.toHaveBeenCalled();
        } finally { releaseActive(); releaseConcurrent(); }
    });

    it('keeps shared encrypted content cold while retaining Account-owned names and demanded per-Home metadata', async () => {
        // Observe the real owner so accidental content demand is visible at
        // every batch size, including batches below the Worker threshold.
        const decryptDataKeys = vi.spyOn(Encryption.prototype, 'decryptEncryptionKeys');
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
            credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, encryptionMode: 'e2ee',
        });
        const encryptedRows = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
            const id = 'encrypted-session-' + index;
            const key = new Uint8Array(32).fill(index + 1);
            const row = h.session({ id, active: true, activeAt: 2, metadata: { path: '/repo', host: 'test', name: 'Encrypted ' + index } });
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected a Plain fixture to seal');
            await encryption.initializeSessions(new Map([[id, key]]));
            const cipher = encryption.getSessionEncryption(id);
            if (!cipher) throw new Error('Expected the Session fixture cipher');
            return { ...row, encryptionMode: 'e2ee' as const,
                metadata: await cipher.encryptRaw(JSON.parse(row.metadata)),
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                    ownerMetadata: row.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(index + 3) }),
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            };
        }));
        h.setSessions(h.homeB, encryptedRows);
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.origin !== h.homeB.serverUrl) return null;
            const path = url.pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v2/sessions/active') return Response.json({ sessions: encryptedRows, nextCursor: null, hasNext: false });
            if (path.startsWith('/v2/sessions/')) {
                const row = encryptedRows.find(row => row.id === decodeURIComponent(path.slice('/v2/sessions/'.length)));
                return row ? Response.json({ session: row })
                    : Response.json({ error: 'Session not found' }, { status: 404 });
            }
            return null;
        });
        try {
            await h.start(); await h.ready();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values)).toEqual([]);
            expect(Object.keys(rows() ?? {})).toEqual(encryptedRows.map(row => row.id));
            for (const row of encryptedRows) {
                // The canonical locked-owner projection admits the Account-encrypted
                // name, but does not open Session-encrypted workspace content.
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + encryptedRows.indexOf(row));
                expect(rows()?.[row.id]?.metadata?.path).toBe('');
                expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.[row.id]).toBeUndefined();
            }
            expect(h.socket().serverUrl).toBe(h.homeB.serverUrl);
            const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
            const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
            const sessionDataKeys = new Map<string, Uint8Array>();
            const sessionDataKeyEnvelopes = new Map<string, string>();
            const readDemandedSession = (sessionId: string) => fetchSessionByIdWithServerScope({
                sessionId, serverId: h.homeB.id, contentDemand: 'session',
                activeCredentials: { token: h.homeA.token },
                activeRequest: h.network.request,
                sessionDataKeys, sessionDataKeyEnvelopes, includeTurnsProjection: false,
                getCurrentSessionListRenderable: id => rows()?.[id],
                applySessions: sessions => h.storage.getState().applyServerScopedSessionListRows(
                    h.homeB.id, sessions.map(session => buildSessionListRenderableFromSession(session, rows()?.[session.id])),
                    { source: 'rowOnly', mode: 'append' },
                ),
                log: { log() {} },
            });
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values)).toHaveLength(encryptedRows.length);
            expect(rows()?.['encrypted-session-0']?.metadata?.name).toBe('Encrypted 0');
            decryptDataKeys.mockClear();
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values)).toEqual([]);
            const demandedRows = rows();
            await h.refresh();
            for (const [index, row] of encryptedRows.entries()) {
                expect(rows()?.[row.id]?.metadata).toBe(demandedRows?.[row.id]?.metadata);
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + index);
                expect(rows()?.[row.id]?.encryptedContentAvailability).toBe(demandedRows?.[row.id]?.encryptedContentAvailability);
            }
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values)).toEqual([]);
            // The first lean refresh binds owner provenance to the concurrent
            // runtime's retained credentials; identical later refreshes reuse it.
            const initialRows = rows();
            await h.refresh();
            expect(rows()).toBe(initialRows);
            for (const row of encryptedRows) expect(rows()?.[row.id]).toBe(initialRows?.[row.id]);
            expect(rows()?.['encrypted-session-4']?.metadata?.name).toBe('Encrypted 4');
            // The harness's batch boundary splits each read-batch POST into its per-Session
            // component reads before this recorder, so the demanded reads are visible here.
            expect(h.requests('/v2/sessions/encrypted-session-0').map(request => request.url.origin))
                .toEqual([h.homeB.serverUrl, h.homeB.serverUrl]);
            expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.['encrypted-session-0']).toBeUndefined();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values)).toEqual([]);
        } finally {
            decryptDataKeys.mockRestore();
        }
    });

    it('replaces stale machine entries when an authoritative refresh omits a removed machine', async () => {
        h.setMachines(h.homeB, [h.machine(h.homeB), h.machine(h.homeB, 'removed-machine')]);
        await h.start(); await h.ready();
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b', 'removed-machine']);
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), seq: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(machines()?.[0]?.seq).toBe(2);
    });

    it('invalidates only the non-active Home machine route when daemon state advances', async () => {
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 1 }]);
        await h.start(); await h.ready();
        for (const key of [route(), route(h.homeB.id, 'other-machine'), route(h.homeC.id)]) {
            routes.recordCachedMachineRpcDirectRouteViable(key);
        }
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toMatchObject({ status: 'viable' });
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.[0]?.daemonStateVersion).toBe(2);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeB.id, 'other-machine'))).toMatchObject({ status: 'viable' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('keeps the active machine writer authoritative without withdrawing another Home or Machine route', async () => {
        await h.start(); await h.ready();
        const initial = h.storage.getState();
        h.storage.setState({ profile: { ...initial.profile, id: h.homeA.accountId },
            profileScope: { serverId: h.homeA.id, accountId: h.homeA.accountId } });
        try {
            const machine = createMachineFixture({ id: 'active-machine', daemonStateVersion: 1 });
            const source = { sourceServerId: h.homeA.id, sourceAccountId: h.homeA.accountId };
            h.storage.getState().applyMachines([machine], true, source);
            const active = route(h.homeA.id, machine.id);
            const otherMachine = route(h.homeA.id, 'other-machine');
            const otherHome = route(h.homeB.id, machine.id);
            for (const key of [active, otherMachine, otherHome]) routes.recordCachedMachineRpcDirectRouteViable(key);
            h.storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2 }], true, source);
            expect(h.storage.getState().machines[machine.id]?.daemonStateVersion).toBe(2);
            expect(routes.readCachedMachineRpcDirectRoute(active)).toEqual({ status: 'unknown' });
            expect(routes.readCachedMachineRpcDirectRoute(otherMachine)).toMatchObject({ status: 'viable' });
            expect(routes.readCachedMachineRpcDirectRoute(otherHome)).toMatchObject({ status: 'viable' });
        } finally { h.storage.setState({ profile: initial.profile, profileScope: initial.profileScope }); }
    });

    it('keeps canonical rows stable without copying them into the concurrent Home cache', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b', metadata: { path: '/repo', host: 'test', name: 'Secondary Session' } })]);
        await h.start(); await h.ready();
        const initialRows = h.storage.getState().sessionListRowsByServerId;
        const projection = h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id];
        expect(rows()?.['session-b']?.metadata?.name).toBe('Secondary Session');
        expect(projection).not.toHaveProperty('sessions');
        expect(projection).not.toHaveProperty('sessionRows');
        await h.refresh();
        expect(h.storage.getState().sessionListRowsByServerId).toBe(initialRows);
        expect(Array.isArray(h.storage.getState().sessionListIndexByServerId[h.homeB.id])).toBe(true);
        expect(h.storage.getState().ordinarySessionListMembershipByServerId[h.homeB.id]).toEqual(['session-b']);
    });

    it('keeps the list index stable when only non-structural Session fields change', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 1, updatedAt: 2000 })]);
        await h.start(); await h.ready();
        const beforeIndex = h.storage.getState().sessionListIndexByServerId[h.homeB.id];
        const beforeRows = rows();
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 2, updatedAt: 3000 })]);
        await h.refresh();
        expect(h.storage.getState().sessionListIndexByServerId[h.homeB.id]).toBe(beforeIndex);
        expect(rows()).not.toBe(beforeRows);
        expect(rows()?.['session-b']?.updatedAt).toBe(3000);
    });

    it('invalidates cached transfer routes when a concurrent Home is removed from the desired set', async () => {
        await h.start(); await h.ready();
        routes.recordCachedMachineRpcDirectRouteViable(route());
        routes.recordCachedMachineRpcDirectRouteViable(route(h.homeC.id));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('isolates concurrent Session and machine refreshes by Home', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        h.setSessions(h.homeC, [h.session({ id: 'session-c' })]);
        h.setMachines(h.homeB, [h.machine(h.homeB)]);
        h.setMachines(h.homeC, [h.machine(h.homeC, 'machine-c')]);
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        expect(Object.keys(rows() ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[h.homeC.id] ?? {})).toEqual(['session-c']);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(h.storage.getState().machineListByServerId[h.homeC.id]?.map(machine => machine.id)).toEqual(['machine-c']);
    });

    it('scopes same-URL alternate persisted profiles by exact Home identity and Account', async () => {
        const identityB = 'srv_same_url_home_b';
        const identityC = 'srv_same_url_home_c';
        const [aProfile, bProfile, cProfile] = [h.homeA, h.homeB, h.homeC].map(home => h.profiles.getServerProfileById(home.id));
        if (!aProfile || !bProfile || !cProfile) throw new Error('Expected the saved Home profiles');
        const b = { ...bProfile, serverIdentityId: identityB, legacyServerIds: [h.homeB.id], canonicalServerUrl: h.homeB.serverUrl };
        const c = { ...cProfile, serverIdentityId: identityC, legacyServerIds: [h.homeC.id],
            serverUrl: h.homeB.serverUrl, canonicalServerUrl: h.homeB.serverUrl };
        const browserStorage = typeof window !== 'undefined' && typeof document !== 'undefined'
            ? window.localStorage : undefined;
        await seedPersistedHomeProfilesForTests({ profiles: [aProfile, b, c], activeServerId: h.homeA.id, browserStorage });
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityB)).toBe(identityB);
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityC)).toBe(identityC);
        expect(await h.TokenStorage.setCredentialsForServerUrl(b.serverUrl, { serverId: identityB }, { token: h.homeB.token })).toBe(true);
        expect(await h.TokenStorage.setCredentialsForServerUrl(c.serverUrl, { serverId: identityC }, { token: h.homeC.token })).toBe(true);
        h.setResponder(async (input, init) => {
            const url = new URL(String(input));
            const isC = new Headers(init?.headers).get('authorization') === 'Bearer ' + h.homeC.token;
            if (url.pathname === '/v2/sessions') return Response.json({ sessions: [h.session({ id: isC ? 'session-c' : 'session-b' })], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines') return Response.json([h.machine(isC ? h.homeC : h.homeB, isC ? 'machine-c' : 'machine-b')]);
            return null;
        });
        await h.select([h.homeA.id, identityB, identityC]);
        h.startConcurrentSessionCacheSync();
        await h.ready({ ...h.homeB, id: identityB }); await h.ready({ ...h.homeC, id: identityC });
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityB] ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityC] ?? {})).toEqual(['session-c']);
        expect(h.storage.getState().sessionListRowsByServerId[b.id]).toBeUndefined();
        expect(h.network.credentialRequests).toEqual(expect.arrayContaining([
            { serverUrl: b.serverUrl, serverId: identityB }, { serverUrl: c.serverUrl, serverId: identityC },
        ]));
    });

    it('clears stale non-active caches when a Home is removed from concurrent selection', async () => {
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        await h.select([h.homeA.id, h.homeB.id]);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeC.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeC.id]).toBeUndefined();
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(true);
    });

    it('reconciles a renamed secondary profile without a selection or focus change', async () => {
        await h.start(); await h.ready();
        await h.profiles.adoptHomeProfile({ descriptor: { serverUrl: h.homeB.serverUrl, displayName: 'Renamed B' }, source: 'manual' });
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.serverName).toBe('Renamed B'));
        expect(h.profiles.getActiveServerId()).toBe(h.homeA.id);
    });

    it('stops a secondary transport and clears caches when its profile disappears', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeB.id]).toBeUndefined();
        expect(socket.socket.connected).toBe(false);
    });

    it('does not resurrect a stopped cache after its deferred OS credential read settles', async () => {
        const gate = h.holdCredentialRead();
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(gate.started).toBe(true));
        h.stopConcurrentSessionCacheSync();
        gate.release();
        expect(Boolean(await h.TokenStorage.getCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }))).toBe(true);
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
        expect(h.network.socketBoundaries.filter(socket => socket.serverUrl === h.homeB.serverUrl)).toEqual([]);
        expect(rows()).toBeUndefined();
    });

    it('does not publish a stale HTTP snapshot after its Home entry has been retired', async () => {
        let signal: AbortSignal | null | undefined;
        let finish!: () => void;
        h.setResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v2/sessions') return null;
            signal = init?.signal;
            await new Promise<void>(resolve => { finish = resolve; });
            return Response.json({ sessions: [h.session({ id: 'stale-session' })], nextCursor: null, hasNext: false });
        });
        await h.start();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        finish();
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(rows()).toBeUndefined();
        expect(machines()).toBeUndefined();
    });
});
