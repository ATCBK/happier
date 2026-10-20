import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { createSessionSurfaceNoteDocumentV1, SessionBoardLayoutV1Schema, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The native/browser window and portal are the measurement boundary; the Add flow stays real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 390, height: 844 }),
    }),
});

const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Build notes', frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('The release checks passed.') },
});
const layout = SessionBoardLayoutV1Schema.parse({ v: 1,
    tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] }],
});
const records = [['layout', 'layout.v1', layout], ['note-1', 'item.v1', item]].map(([localId, kind, value]) =>
    SessionSystemRecordStoredSchema.parse({ id: localId,
        address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value },
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    }));
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: { sessions: { board: { enabled: true } } } }),
    request: async url => new URL(String(url)).pathname.endsWith('/system-records')
        ? Response.json({ records, nextCursor: null, hasNext: false }) : null,
});

describe('Session Details destination Board composition', () => {
    it('reads the existing Board and opens Add from the phone instance route', async () => {
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic', experiments: true });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true })).status).toBe('ready');
        const { SessionDetailsDestinationBody } = await import('./SessionDetailsDestinationBody');
        const { SessionBoardSurface } = await import('@/components/sessions/board/SessionBoardSurface');
        const { BoardWidgetAddPopover } = await import('@/components/widgets/add/BoardWidgetAddPopover');
        const destination = (focused: boolean, visible = true) => <runtime.Wrapper>
            <DestinationInstanceHost tabId="details-phone" ref={{ kind: 'sessionDetails',
                params: { id: 's1', serverId: runtime.serverId, details: 'board' } }}
                pathname="/session/s1/details" focused={focused} visible={visible} phone
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <SessionDetailsDestinationBody />
            </DestinationInstanceHost>
        </runtime.Wrapper>;
        const screen = await renderScreen(destination(true));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('session-board-pane'), 'The hydrated phone route must render its Board destination').not.toBeNull();
        const surface = screen.tree.findAllByType(SessionBoardSurface)[0];
        expect(surface, 'The phone Details route must reach the real Board controller').toBeDefined();
        const controller = surface!.props.controller;
        expect(controller.snapshot?.itemsById.get('note-1')?.state).toMatchObject({ kind: 'ready', item });
        expect(surface!.props.resolvePrimaryHost('note-1'), 'The visible Details destination must own its executable Board bodies')
            .toBe('details');
        await screen.update(destination(false));
        expect(screen.tree.findByType(SessionBoardSurface).props.resolvePrimaryHost('note-1')).toBe('details');
        await screen.update(destination(false, false));
        expect(screen.tree.findByType(SessionBoardSurface).props.resolvePrimaryHost('note-1')).toBeNull();
        await screen.update(destination(true));
        expect(screen.findHostByTestId('session-board-pane-surface-placement-note-1')).not.toBeNull();
        expect(screen.findByTestId('session-board-pane-surface-add-trigger')).not.toBeNull();
        await screen.pressByTestIdAsync('session-board-pane-surface-add-trigger');
        expect(screen.tree.findByType(BoardWidgetAddPopover).props.open).toBe(true);
    });
});
