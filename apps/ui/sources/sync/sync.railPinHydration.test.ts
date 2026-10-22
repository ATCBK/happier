import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema, CurrentCursorResponseSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';

import { createPlainAccountEncryptionCurrentnessFixture, standardCleanup } from '@/dev/testkit';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage, readSessionOrganizationProjectionCached } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization/fetchSessionOrganizationSnapshot';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

// Real Account restoration, Sync, HTTP schemas, store and rail projection; only
// the network transport and native platform adapters are substituted.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => { configureConnectedServerSocketBoundary(socket); });

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('ordinary Session refresh hydrates every personal pin surface', () => {
    beforeAll(loadSyncSingletonForTests);
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
    });

    it.each(['retained', 'new', 'overtaken', 'list-only-newer', 'reloaded', 'reloaded-unavailable', 'reloaded-removed'] as const)('hydrates %s pinned Bots alongside list and dual-surface pins', async membership => {
        const pins = [
            { sessionId: 'list-only', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false },
            { sessionId: 'rail-only', sortKey: 'b', pinnedAt: 2, listPinned: false, railPinned: true },
            { sessionId: 'both', sortKey: 'c', pinnedAt: 3, listPinned: true, railPinned: true },
        ];
        const snapshot = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            schemaVersion: 1, version: 1, pins, folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        } });
        const emptySnapshot = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            ...snapshot.snapshot, version: 0, pins: [],
        } });
        let pinsAvailable = membership !== 'new';
        let serveNewerRow = false;
        let staleSnapshotAvailable = false;
        const sourceMetadata = { path: '/bot', host: 'fixture', bot: { kind: 'bot' } };
        const owner = createSessionOwnerMetadataV1({ metadata: sourceMetadata });
        if (!owner.ok) throw new Error('Bot owner metadata fixture was rejected');
        const metadata = projectSessionSharedMetadataV1({ metadata: sourceMetadata });
        const records = new Map(pins.map(pin => [pin.sessionId, SessionCurrentProjectionRecordV1Schema.parse({
            id: pin.sessionId, seq: 0, createdAt: 1, updatedAt: 2, active: false, activeAt: 1,
            archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify(metadata), metadataVersion: 1, agentState: null, agentStateVersion: 0,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        })]));
        const exactReads: string[] = [];
        const readSession = (path: string): Response | undefined => {
            const sessionId = path.startsWith('/v2/sessions/') ? decodeURIComponent(path.slice('/v2/sessions/'.length)) : '';
            const record = records.get(sessionId);
            if (!record) return undefined;
            exactReads.push(sessionId);
            if (membership === 'reloaded-unavailable' && staleSnapshotAvailable && sessionId === 'rail-only') {
                return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            if (membership === 'reloaded-removed' && staleSnapshotAvailable && sessionId === 'rail-only') {
                return Response.json(V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 });
            }
            return Response.json({ session: serveNewerRow
                ? { ...record, seq: 14, updatedAt: 3, metadataVersion: 2 }
                : record });
        };
        const sessionBoundary = createSessionReadBatchHttpBoundary(request => readSession(request.path));
        connection = await restoreServerAccountForTest({
            serverUrl: `https://${membership}-rail-hydration.example.test`,
            serverIdentityId: `srv_rail-hydration-${membership}`, accountId: 'rail-account',
            request: async (url, init) => {
                const target = new URL(String(url));
                const path = target.pathname;
                if (path === '/v2/sessions/read-batch') return await sessionBoundary.handle({
                    home: membership, accountId: 'rail-account', url: target, path, method: init?.method ?? 'GET',
                    headers: new Headers(init?.headers), signal: init?.signal,
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                }) ?? null;
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }));
                if (path === '/v2/session-organization') return Response.json(pinsAvailable ? snapshot : emptySnapshot);
                if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
                if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({
                    sessions: staleSnapshotAvailable ? [records.get('rail-only')] : [],
                    nextCursor: null, hasNext: false,
                });
                return readSession(path) ?? null;
            },
        });
        const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
        await fetchAndApplySessionOrganizationSnapshot({ credentials: connection.credentials, serverId, serverUrl: connection.home.serverUrl });
        // External Agent mutations arrive through the refresh, after the app
        // already has a last-known organization snapshot.
        pinsAvailable = true;
        const { sync } = await import('./sync');
        // Join bootstrap's public queue before arranging the later live read.
        await sync.refreshSessions();
        if (membership === 'overtaken') {
            // A live detail read has already hydrated a newer revision than
            // the exact-id row returned by this list refresh.
            serveNewerRow = true;
            await sync.ensureSessionVisibleForMessageRoute('rail-only', { forceRefresh: true, hydrateMessages: false });
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            serveNewerRow = false;
        }
        if (membership === 'reloaded' || membership === 'reloaded-unavailable' || membership === 'reloaded-removed') {
            await sync.refreshSessions({ awaitSessionListHydration: true });
            // Navigation opens newer tuple data. A reload keeps the warm list
            // projection but retires the opened Session entity.
            serveNewerRow = true;
            await sync.ensureSessionVisibleForMessageRoute('rail-only', { forceRefresh: true, hydrateMessages: false });
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            const { ['rail-only']: _railSession, ...sessions } = storage.getState().sessions;
            storage.setState({ sessions });
            staleSnapshotAvailable = true;
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
        }
        staleSnapshotAvailable = staleSnapshotAvailable || membership === 'overtaken' || membership === 'list-only-newer';
        if (membership === 'reloaded-unavailable') {
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).rejects.toBeInstanceOf(Error);
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            return;
        }
        if (membership === 'list-only-newer') {
            // A newer list projection without the opened Session entity cannot
            // be promoted to successful required hydration.
            const { ['rail-only']: _railSession, ...sessions } = storage.getState().sessions;
            storage.setState({ sessions });
            storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
                sessionId: 'rail-only', patch: { seq: 14, updatedAt: 3, metadataVersion: 2 },
            }]);
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).rejects.toThrow('Required session hydration failed for rail-only');
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            return;
        }
        await sync.refreshSessions({ awaitSessionListHydration: true });

        if (membership === 'reloaded-removed') {
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toBeUndefined();
            return;
        }

        expect(new Set(exactReads)).toEqual(new Set(['list-only', 'rail-only', 'both']));
        const organization = readSessionOrganizationProjectionCached(storage.getState(), serverId);
        expect(organization.pinnedSessionIds).toEqual(['list-only', 'both']);
        expect(organization.railPinnedSessionIds).toEqual(['rail-only', 'both']);
        const { buildAppRailEntries } = await import('@/components/navigation/shell/appRail/appRailModel');
        const entries = buildAppRailEntries([], { botHomes: [{ serverId, organization,
            rowsBySessionId: storage.getState().sessionListRowsByServerId[serverId] ?? {} }] });
        expect(entries.bots.map(entry => entry.sessionId)).toEqual(['rail-only', 'both']);
        if (membership === 'overtaken' || membership === 'reloaded') {
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
        }
        if (membership === 'retained') {
            const address = { serverId, sessionId: 'rail-only' };
            const { retainVisibleSessionListSurfaces } = await import('./domains/session/sessionSurfaceVisibility');
            const release = retainVisibleSessionListSurfaces([address]);
            try {
                // The exact read establishes this Home's ordinary hydration;
                // returning to a visible row must not force another witness.
                await sync.ensureSessionVisibleForMessageRoute(address.sessionId, {
                    serverId, forceRefresh: true, hydrateMessages: false,
                });
                const readsAfterHydration = exactReads.length;
                await sync.hydrateSessionListRows([address]);
                expect(exactReads).toHaveLength(readsAfterHydration);
                // A newer canonical tuple still demands a read; a retained
                // opened row is not a cache that can overrule list invalidation.
                serveNewerRow = true;
                storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
                    sessionId: address.sessionId, patch: { seq: 14, updatedAt: 3, metadataVersion: 2 },
                }]);
                await sync.hydrateSessionListRows([address]);
                expect(exactReads).toHaveLength(readsAfterHydration + 1);
                expect(storage.getState().sessions[address.sessionId]).toMatchObject({ seq: 14, metadataVersion: 2 });
                await sync.hydrateSessionListRows([address]);
                expect(exactReads).toHaveLength(readsAfterHydration + 1);
                // Mutation/disclosure callers' explicit exact witness is kept.
                await sync.ensureSessionVisibleForMessageRoute(address.sessionId, {
                    serverId, forceRefresh: true, hydrateMessages: false,
                });
                expect(exactReads).toHaveLength(readsAfterHydration + 2);
            } finally { release(); }
        }
    });
});
