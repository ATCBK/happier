import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage } from '@/sync/domains/state/storage';
import { archiveSessionReports, confirmSessionArchive } from './confirmSessionArchive';
import { Modal } from '@/modal';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { t } from '@/text';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => {
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {} });
});

describe('archiveSessionReports', () => {
    it('uses the existing generic failure notice when the owner cannot discover every report', async () => {
        vi.mocked(Modal.alert).mockClear();
        await archiveSessionReports({ reports: [], reportsError: { errorCode: 'target_unavailable', error: 'target_unavailable' } });
        expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), t('sessionInfo.failedToArchiveSession'));
    });
    it('presents the owner result without discovering or mutating cached reports', async () => {
        const known = createSessionFixture({ id: 'known', serverId: 'home-a', metadata: { name: 'Known session' } });
        const foreign = createSessionFixture({ id: 'unknown', serverId: 'home-b', metadata: { name: 'Another Home' } });
        getStorage().setState({ sessions: { known, foreign }, sessionListRowsByServerId: {
            'home-a': { known: buildSessionListRenderableFromSession(known) },
            'home-b': { unknown: buildSessionListRenderableFromSession(foreign) },
        } });
        vi.mocked(Modal.alert).mockClear();
        await archiveSessionReports({ serverId: 'home-a', reports: [
            { sessionId: 'archived', title: 'Finished', status: 'archived' },
            { sessionId: 'known', status: 'failed', errorCode: 'permission_denied', error: 'permission_denied' },
            { sessionId: 'refused', title: 'Protected', status: 'failed', errorCode: 'permission_denied', error: 'permission_denied' },
            { sessionId: 'pending', title: 'Awaiting approval', status: 'approval_pending', artifactId: 'approval-one' },
            { sessionId: 'unknown', status: 'failed', errorCode: 'permission_denied', error: 'permission_denied' },
        ] });
        expect(Modal.alert).toHaveBeenCalledWith(expect.any(String), 'Known session\nProtected\nAwaiting approval\nunknown');
        vi.mocked(Modal.alert).mockClear();
        await archiveSessionReports({ reports: [{ sessionId: 'done', status: 'archived' }] });
        expect(Modal.alert).not.toHaveBeenCalled();
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

    it('counts list-only direct reports in the captured Home without counting grandchildren or another Home', async () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', manager: { sessionId: 'lead' } });
        lead([
            createSessionFixture({ id: 'other-home', serverId: 'home-b', manager: { sessionId: 'lead' } }),
            createSessionFixture({ id: 'grandchild', serverId: 'home-a', manager: { sessionId: 'child' } }),
        ]);
        getStorage().setState({ sessionListRowsByServerId: { 'home-a': { child: buildSessionListRenderableFromSession(child) } } });
        vi.mocked(Modal.show).mockClear();
        const pending = confirmSessionArchive({ leadSessionId: 'lead', serverId: 'home-a' });
        const shown = vi.mocked(Modal.show).mock.calls[0]![0] as unknown as { props: { reportCount: number; onResolve: (r: { confirmed: boolean; alsoArchiveReports: boolean }) => void } };
        expect(shown.props.reportCount).toBe(1);
        shown.props.onResolve({ confirmed: false, alsoArchiveReports: false });
        await pending;
    });
});
