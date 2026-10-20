import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage } from '@/sync/domains/state/storage';
import { archiveSessionReports, confirmSessionArchive } from './confirmSessionArchive';
import { Modal } from '@/modal';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { SessionActionExecutionContext } from './sessionActionTypes';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => {
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {} });
});

describe('archiveSessionReports', () => {
    it('archives only unarchived direct reports in the lead Home, through the existing archive Action', async () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', manager: { sessionId: 'lead' } });
        const otherHome = createSessionFixture({ id: 'other', serverId: 'home-b', manager: { sessionId: 'lead' } });
        const unqualified = createSessionFixture({ id: 'unqualified', manager: { sessionId: 'lead' } });
        const archived = createSessionFixture({ id: 'archived', serverId: 'home-a', manager: { sessionId: 'lead' }, archivedAt: 4 });
        const grandchild = createSessionFixture({ id: 'grandchild', serverId: 'home-a', manager: { sessionId: 'child' } });
        // The report was never opened: ordinary list hydration still has to make cascade reachable.
        getStorage().setState({ sessions: { otherHome, unqualified, archived, grandchild },
            sessionListRowsByServerId: { 'home-a': { child: buildSessionListRenderableFromSession(child) } } });
        const archivedAddresses: Array<{ sessionId: string; serverId: string | null | undefined }> = [];
        const context: SessionActionExecutionContext = {
            operations: {
                archiveSession: async (sessionId, options) => {
                    archivedAddresses.push({ sessionId, serverId: options?.serverId });
                    return { success: true };
                },
                clearSessionVisibleWhenInactive: () => {},
            },
        };
        await archiveSessionReports({ leadSessionId: 'lead', serverId: 'home-a', context });
        expect(archivedAddresses).toEqual([{ sessionId: 'child', serverId: 'home-a' }]);
        archivedAddresses.length = 0;
        await archiveSessionReports({ leadSessionId: 'lead', serverId: null, context });
        expect(archivedAddresses).toEqual([]);
    });
});


describe('archive confirmation policy', () => {
    it('does not put a local confirmation in front of an allowed archive Action', async () => {
        const settings = getStorage().getState().settings;
        getStorage().setState({ settings: { ...settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) } });
        vi.mocked(Modal.confirm).mockClear();
        try {
            expect(await confirmSessionArchive({ leadSessionId: 'lead', serverId: 'home-a' })).toEqual({ confirmed: true, alsoArchiveReports: false });
            expect(Modal.confirm).not.toHaveBeenCalled();
        } finally {
            getStorage().setState({ settings });
        }
    });

    it('leaves explicit archive approval to the Action front door rather than asking twice', async () => {
        const settings = getStorage().getState().settings;
        getStorage().setState({ settings: { ...settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: { 'session.archive': { approvalRequiredSurfaces: ['ui'] } },
        }) } });
        vi.mocked(Modal.confirm).mockClear();
        try {
            expect(await confirmSessionArchive({ leadSessionId: 'lead', serverId: 'home-a' })).toEqual({ confirmed: true, alsoArchiveReports: false });
            expect(Modal.confirm).not.toHaveBeenCalled();
        } finally {
            getStorage().setState({ settings });
        }
    });

});

describe('archive confirmation scope', () => {
    const lead = (reports: ReadonlyArray<ReturnType<typeof createSessionFixture>>) => getStorage().setState({
        sessions: Object.fromEntries(reports.map((report) => [report.id, report])),
        sessionListRowsByServerId: {},
    });

    it('does not offer "Also archive" when the only sub-session is already archived', async () => {
        lead([createSessionFixture({ id: 'done', serverId: 'home-a', manager: { sessionId: 'lead' }, archivedAt: 4 })]);
        vi.mocked(Modal.show).mockClear();
        expect(await confirmSessionArchive({ leadSessionId: 'lead', serverId: 'home-a' }))
            .toEqual({ confirmed: true, alsoArchiveReports: false });
        expect(Modal.show).not.toHaveBeenCalled();
    });

    it('counts only the sub-sessions the cascade would archive', async () => {
        lead([
            createSessionFixture({ id: 'live', serverId: 'home-a', manager: { sessionId: 'lead' } }),
            createSessionFixture({ id: 'done', serverId: 'home-a', manager: { sessionId: 'lead' }, archivedAt: 4 }),
        ]);
        vi.mocked(Modal.show).mockClear();
        const pending = confirmSessionArchive({ leadSessionId: 'lead', serverId: 'home-a' });
        const shown = vi.mocked(Modal.show).mock.calls[0]![0] as unknown as { props: { reportCount: number; onResolve: (r: { confirmed: boolean; alsoArchiveReports: boolean }) => void } };
        expect(shown.props.reportCount).toBe(1);
        shown.props.onResolve({ confirmed: false, alsoArchiveReports: false });
        await pending;
    });
});
