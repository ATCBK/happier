import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { renderScreen, flushHookEffects, createSessionAccessFixture } from '@/dev/testkit';
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
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
    } })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    return Response.json(path === '/v2/sessions/query' ? SessionListQueryResponseV1Schema.parse(page) : page);
} });

const { ProjectSessionsWidgetBody } = await import('./ProjectSessionsWidgetBody');
const { storage } = await import('@/sync/domains/state/storageStore');

describe('Project Sessions widget body', () => {
    it('lists only this Project\'s Sessions as rows', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        requests = 0;
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('w.session:own')).not.toBeNull();
        });
        expect(screen.findByTestId('w.session:other')).toBeNull();
        expect(screen.findByTestId('w.empty')).toBeNull();
    });

    it('says the Project has no Sessions only once the roster answered complete', async () => {
        fail = false;
        sessionIds = ['other'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const screen = await renderScreen(<runtime.Wrapper><ProjectSessionsWidgetBody checkout={checkout} testID="w" /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('w.empty')).not.toBeNull();
        });
        expect(screen.findByTestId('w.session:other')).toBeNull();
    });
});
