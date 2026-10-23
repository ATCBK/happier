import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { renderHook, flushHookEffects, createSessionAccessFixture } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let fail = false;
let sessionIds = ['own'];
let requests = 0;
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: { sessions: { filteredListing: { enabled: true } } } }),
    configureSocket: socket => {
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
}, request: async url => {
    const path = new URL(String(url)).pathname;
    if (path !== '/v2/sessions' && path !== '/v1/sessions' && path !== '/v2/sessions/query') return null;
    requests += 1;
    if (fail) return new Response('{}', { status: 503 });
    const page = { sessions: sessionIds.map(id => ({ ...V2SessionRecordSchema.parse({
        id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadata: JSON.stringify({ path: '/repo', machineId: 'machine', projectId: id === 'other' ? 'other-project' : 'anchor' }),
        metadataVersion: 1, agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        responsibleAccountId: null, responsibleAccount: null,
    }), viewer: {
        latestFailureSeq: null,
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
    } })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    return Response.json(path === '/v2/sessions/query' ? SessionListQueryResponseV1Schema.parse(page) : page);
} });

const { useProjectSessionsWidgetBody } = await import('./useProjectSessionsWidgetBody');
const { storage } = await import('@/sync/domains/state/storageStore');

describe('binder-admitted Project Session body model', () => {
    it('uses real list acquisition, retains rows on refresh failure, recovers to acknowledged empty and withdraws on Account retirement', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        requests = 0;
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const hook = await renderHook(() => useProjectSessionsWidgetBody(checkout), { wrapper: runtime.Wrapper });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect({ ids: hook.getCurrent().items.map(item => item.sessionId), requests, access: hook.getCurrent().access,
                presentation: hook.getCurrent().presentation.kind,
                failures: Object.values(hook.getCurrent().query.statesByServerId).map(state => state?.failureCode ?? state?.failureReason) })
                .toEqual({ ids: ['own'], requests: expect.any(Number), access: 'available', presentation: 'ready', failures: [null] });
            expect(hook.getCurrent().presentation).toMatchObject({ kind: 'ready', complete: true });
        });
        expect(requests).toBeGreaterThan(0);
        fail = true;
        await act(async () => { await hook.getCurrent().query.refresh(); });
        expect(hook.getCurrent().items.map(item => item.sessionId)).toEqual(['own']);
        expect(hook.getCurrent().presentation.kind).not.toBe('ready');
        fail = false;
        sessionIds = [];
        await act(async () => { await hook.getCurrent().query.refresh(); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().items).toEqual([]);
            expect(hook.getCurrent().presentation).toMatchObject({ kind: 'ready', complete: true });
        });
        await act(async () => { storage.setState({ profileScope: { serverId: runtime.serverId, accountId: 'different-account' } }); });
        expect(hook.getCurrent().items).toEqual([]);
        await hook.unmount();
    });
});
