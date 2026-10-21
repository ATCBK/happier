import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref, quotaTestResponse, quotaTestProviderUsageSnapshot } from './qualifiedConnectedAccountQuotaTestHarness';
import { useQualifiedConnectedAccountQuota } from './useQualifiedConnectedAccountQuota';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import 'fake-indexeddb/auto';
import type { Socket } from 'socket.io-client';
import { ChangeEntrySchema } from '@happier-dev/protocol/changes';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { FeedResponseSchema } from '@/sync/domains/social/feedTypes';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { SESSION_DRAFT_V2_ROUTE_LIST, SessionDraftListResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();
// The loaded app already owns Sync before an Account's first Action; warm that real graph before restoration.
await loadSyncSingletonForTests();

describe('mounted quota settlement through Home Account-change transport', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
    function Wrapper({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={boundary.account.credentials}>{children}</InjectedAuthProvider>;
    }

    beforeEach(() => { __resetQualifiedConnectedAccountQuotaSnapshotStore(); });
    afterEach(async () => {
        standardCleanup();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary?.dispose();
        vi.restoreAllMocks();
    });

    it.each([false, true])('settles a mounted pending refresh through real socket/HTTP catch-up after same-Home reconfiguration=%s', async reconfigure => {
        const sockets: Socket[] = [];
        let terminal = false;
        let changesReads = 0;
        const baseline = projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
            snapshot: quotaTestProviderUsageSnapshot(1), ref,
        });
        boundary = await createQualifiedQuotaTestHarness({
            serverUrl: 'https://qualified-quota-settlement.test', serverIdentityId: 'srv_quota_settlement_fixture',
            snapshot: baseline,
            configureSocket: socket => { sockets.push(socket); },
            request: async input => {
                const url = new URL(String(input));
                if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'quota-account' });
                if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
                if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
                if (url.pathname === SESSION_DRAFT_V2_ROUTE_LIST) return Response.json(SessionDraftListResponseV2Schema.parse({ items: [] }));
                if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                if (url.pathname === '/v1/machines') return Response.json([
                    createPlainMachineRowFixture({ id: 'machine-selected', accountId: 'quota-account' }),
                ]);
                if (url.pathname === '/v1/artifacts') return Response.json([]);
                if (url.pathname === '/v1/friends' || url.pathname === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
                if (url.pathname === '/v1/kv') return Response.json({ items: [] });
                if (url.pathname === '/v1/feed') return Response.json(FeedResponseSchema.parse({ items: [], hasMore: false }));
                if (url.pathname === '/v2/changes') {
                    changesReads++;
                    return Response.json({ changes: terminal ? [ChangeEntrySchema.parse({
                        cursor: 1, kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1,
                        changedAt: 11, hint: null,
                    })] : [], nextCursor: terminal ? 1 : 0 });
                }
                return null;
            },
        });
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(baseline));
        await waitForHomeGovernance(() => expect(sockets.some(current => current.listenersAny().length > 0)).toBe(true));
        boundary.refresh.mockImplementation(async () => {
            boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(baseline, 'ok', 10)));
            return Response.json({ success: true });
        });
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ snapshot: baseline, refreshing: true, error: null });
        if (reconfigure) {
            // A same-Home authority application must retain delivery to mounted readers.
            // Exercise the public transport owner, never stub its event handlers.
            const current = boundary.context().serverBasis;
            apiSocket.initialize({ endpoint: boundary.account.home.serverUrl, token: boundary.account.credentials.token,
                serverId: current.serverId, generation: current.generation }, null);
            // A server can publish to the replacement socket only after ingress is bound.
            await waitForHomeGovernance(() => expect(sockets.some(current => current.listenersAny().length > 0)).toBe(true));
        }
        const settled = projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
            snapshot: quotaTestProviderUsageSnapshot(11), ref,
        });
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(settled)));
        terminal = true;
        const socket = [...sockets].reverse().find(current => current.listenersAny().length > 0);
        expect(socket, 'the restored Home binds the production update ingress').toBeDefined();
        await act(async () => {
            for (const listener of socket!.listenersAny()) {
                await listener('update', { id: 'quota-settled', seq: 1, createdAt: 11, body: { t: 'account-change' } });
            }
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ snapshot: settled, refreshing: false }));
        expect(changesReads).toBeGreaterThan(0);
        expect(boundary.refresh).toHaveBeenCalledOnce();
    });

});
