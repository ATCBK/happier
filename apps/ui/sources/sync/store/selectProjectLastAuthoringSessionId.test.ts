import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activatePendingQueueScope } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { storage } from '@/sync/domains/state/storage';
import { selectProjectLastAuthoringSessionId } from './selectProjectLastAuthoringSessionId';

const workspace: WorkspaceAddressV1 = { serverId: 'server_1', workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
const accountId = 'account_a';

function authoringSession(id: string, updatedAt: number, originPatch: Partial<PluginUiNewSessionSeedOriginV1> = {}) {
    return createSessionFixture({ id, serverId: workspace.serverId, updatedAt, metadata: {
        machineId: workspace.machineId, path: '/repo', host: 'host',
        work: { authoringOriginV1: { kind: 'project', accountId, workspace, page: 'scripts', ...originPatch } },
    } });
}

beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState(storage.getInitialState(), true);
    await activatePendingQueueScope({ serverId: workspace.serverId, accountId });
});

afterEach(() => {
    storage.setState(storage.getInitialState(), true);
    vi.restoreAllMocks();
});

describe('latest Project authoring Session selector', () => {
    it('shares checkout derivation and preserves primitive subscriptions without rescanning Sessions on unrelated updates', () => {
        storage.getState().applySessions([authoringSession('older', 10), authoringSession('latest', 20),
            createSessionFixture({ id: 'ordinary', updatedAt: 1 })]);
        const values = vi.spyOn(Object, 'values');
        const state = storage.getState();
        expect(selectProjectLastAuthoringSessionId(state, workspace, accountId)).toBe('latest');
        expect(selectProjectLastAuthoringSessionId(state, { ...workspace }, accountId)).toBe('latest');
        expect(values.mock.calls.filter(([input]) => input === state.projectAuthoringSessions)).toHaveLength(1);
        expect(values.mock.calls.filter(([input]) => input === state.sessions)).toHaveLength(0);

        const notifications = [0, 0];
        const cleanups = notifications.map((_, index) => {
            let previous = selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId);
            return storage.subscribe((next) => {
                const selected = selectProjectLastAuthoringSessionId(next, workspace, accountId);
                if (selected !== previous) { notifications[index] += 1; previous = selected; }
            });
        });
        try {
            values.mockClear();
            storage.getState().applySessions([createSessionFixture({ id: 'ordinary', updatedAt: 2 })]);
            const next = storage.getState();
            expect(next.projectAuthoringSessions).toBe(state.projectAuthoringSessions);
            expect(selectProjectLastAuthoringSessionId(next, workspace, accountId)).toBe('latest');
            expect(notifications).toEqual([0, 0]);
            // Other store consumers may inspect Sessions; count only this owner's projection.
            expect(values.mock.calls.filter(([input]) => input === next.projectAuthoringSessions)).toHaveLength(0);
            storage.getState().applySessions([authoringSession('older', 30)]);
            expect(notifications).toEqual([1, 1]);
            expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('older');
            expect(values.mock.calls.filter(([input]) => input === storage.getState().projectAuthoringSessions)).toHaveLength(1);
        } finally { cleanups.forEach((dispose) => dispose()); }
    });

    it('uses the stored original checkout and Account rather than the editable launch Machine', () => {
        const target = authoringSession('original-checkout', 10);
        target.metadata = { ...target.metadata!, machineId: 'worker-b', path: '/edited' };
        storage.getState().applySessions([target,
            authoringSession('other-root', 20, { workspace: { ...workspace, rootPath: '/repo/other' } }),
            authoringSession('other-account', 30, { accountId: 'other-account' }),
            authoringSession('other-machine', 40, { workspace: { ...workspace, machineId: 'other-machine' } }),
            authoringSession('other-home', 50, { workspace: { ...workspace, serverId: 'other-home' } }),
            authoringSession('review', 60, { page: 'changes' }),
        ]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe(target.id);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, null)).toBeNull();
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, 'other-account')).toBe('other-account');
    });

    it('updates when owner metadata is projected, requalified, or removed independently of the Session list view', () => {
        const session = authoringSession('author', 10);
        storage.getState().applySessions([{ ...session, metadataLayoutVersion: 1, ownerMetadataView: null }]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBeNull();
        storage.getState().applySessions([{ ...session, metadataLayoutVersion: 1, ownerMetadataView: session.metadata }]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe(session.id);
        const changedOrigin = authoringSession(session.id, 10, { workspace: { ...workspace, rootPath: '/other' } });
        storage.getState().applySessions([{ ...session, metadataLayoutVersion: 1, ownerMetadataView: changedOrigin.metadata, metadataVersion: 2 }]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBeNull();
        expect(selectProjectLastAuthoringSessionId(storage.getState(), { ...workspace, rootPath: '/other' }, accountId)).toBe(session.id);
        storage.getState().applySessions([{ ...session, metadataLayoutVersion: 1, ownerMetadataView: null, metadataVersion: 3 }]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), { ...workspace, rootPath: '/other' }, accountId)).toBeNull();
    });

    it('tracks terminal timestamps, exact-Home retirement, and store reset', () => {
        storage.getState().applySessions([authoringSession('older', 10), authoringSession('latest', 20)]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('latest');
        storage.getState().applySessionTerminalLifecycle('older', 40);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('older');
        storage.getState().deleteSession('older', 'other-home');
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('older');
        storage.getState().deleteSession('older', workspace.serverId);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('latest');
        storage.getState().activateSessionLocalStateScope({ serverId: workspace.serverId, accountId: 'other-account' });
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, 'other-account')).toBeNull();
        storage.setState(storage.getInitialState(), true);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBeNull();
    });

    it('retires the projection with the canonical Sync disconnect transaction before a new carrier arrives', async () => {
        storage.getState().applySessions([authoringSession('old-account-session', 100)]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('old-account-session');
        const { sync } = await import('@/sync/sync');
        sync.disconnectServer();
        expect(storage.getState().projectAuthoringSessions).toEqual({});
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBeNull();
        storage.getState().applySessions([authoringSession('new-carrier', 1)]);
        expect(selectProjectLastAuthoringSessionId(storage.getState(), workspace, accountId)).toBe('new-carrier');
    });
});
