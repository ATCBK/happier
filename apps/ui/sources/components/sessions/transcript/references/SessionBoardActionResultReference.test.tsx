import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { createSessionSurfaceNoteDocumentV1, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';

import { makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionSystemRecordHttpFixture,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SessionCompanionRevealPortProvider } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import {
    useSessionCompanionController,
    type SessionCompanionController,
    type SessionCompanionMutationOutcome,
} from '@/components/sessions/companion/state/useSessionCompanionController';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = SessionSurfaceItemV1Schema.parse({
    v: 1, destination: 'transcript', title: 'Release checklist', frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Ship the release') },
});
const openFullSurface = () => {};

function CompanionProbe(props: Readonly<{
    serverId: string;
    capture: (controller: SessionCompanionController) => void;
}>) {
    props.capture(useSessionCompanionController({ sessionId: 'session-1', serverId: props.serverId, openFullSurface }));
    return null;
}

/** Keep Sync, record decoding, preferences and presentation policy real; replace only HTTP/Socket transport. */
async function renderReference(options: Readonly<{ foreignRevealPort?: boolean }> = {}) {
    const previous = storage.getState();
    retirePresentationNotice();
    const record = SessionSystemRecordStoredSchema.parse({
        id: 'item-record',
        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'item-1' },
        content: { t: 'plain', v: item }, revision,
        createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
    });
    const fixture = createSessionSystemRecordHttpFixture({ sessionId: 'session-1', records: [record] });
    const connection = await restoreServerAccountForTest({
        serverUrl: 'https://inline-reference-presentation.test', request: fixture.request,
    });
    // Device-local state is a genuine fixture boundary. Start without a saved preference.
    storage.setState(state => ({ localSettings: { ...state.localSettings, sessionCompanionPreferencesBySessionV1: {} } }));
    onTestFinished(async () => {
        standardCleanup();
        retirePresentationNotice();
        await connection.dispose();
        storage.setState(previous, true);
    });
    const serverId = connection.home.id;
    const tool = makeToolCall({
        name: 'mcp__happier__session_board_item_upsert', state: 'completed',
        input: { itemId: 'item-1', expectedItemRevision: null, destination: 'transcript', item },
        result: { v: 1, serverId, sessionId: 'session-1',
            result: { operation: 'upsert_item', itemId: 'item-1', outcome: 'created', itemRevision: revision },
            destination: null, itemDestination: 'transcript' },
    });
    const revealedItems: string[] = [];
    const revealedMutations: SessionCompanionMutationOutcome[] = [];
    const probe: { controller: SessionCompanionController | null } = { controller: null };
    const capture = (controller: SessionCompanionController) => { probe.controller = controller; };
    const screen = await renderScreen(
        <SessionCompanionRevealPortProvider
            address={{ serverId: options.foreignRevealPort ? 'another-home' : serverId, sessionId: 'session-1' }}
            openFullSurface={openFullSurface}
            revealAfterMutation={outcome => { revealedMutations.push(outcome); }}
            revealBoardItem={itemId => { revealedItems.push(itemId); }}
        >
            <SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1" />
            <CompanionProbe serverId={serverId} capture={capture} />
        </SessionCompanionRevealPortProvider>,
    );
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Ship the release'));
    const readController = () => {
        if (!probe.controller) throw new Error('Companion observer did not mount');
        return probe.controller;
    };
    const readActions = (): React.ComponentProps<typeof ItemRowActions>['actions'] | undefined => {
        const menu = screen.tree.root.findAllByType(ItemRowActions)
            .find(node => node.props.overflowTriggerTestID === 'transcript-board-widget-item-1-actions');
        return menu?.props.actions;
    };
    const addToCompanion = async () => {
        const action = readActions()?.find(candidate => candidate.id === 'add-to-companion');
        expect(action?.onPress).toBeTypeOf('function');
        // Invoke the real rendered menu action; its domain controller and local persistence remain real.
        await act(async () => { action?.onPress?.(); });
    };
    return { screen, fixture, readController, readActions, addToCompanion, revealedItems, revealedMutations };
}

describe('inline reference exact presentation and local Companion operations', () => {
    it('reveals the acknowledged item through its exact Home/Session presentation port', async () => {
        const { screen, fixture, revealedItems } = await renderReference();
        await screen.pressByTestIdAsync('transcript-board-item-item-1-open');
        expect(revealedItems).toEqual(['item-1']);
        expect(fixture.recordReads).toEqual(['item-1']);
    });

    it('renders content but does not borrow reveal actions from another Home\'s same-id Session', async () => {
        const { screen, readActions, readController, revealedItems, revealedMutations } =
            await renderReference({ foreignRevealPort: true });
        expect(screen.findByTestId('transcript-board-item-item-1-open')).toBeNull();
        expect(readActions()?.map(action => action.id) ?? []).not.toContain('add-to-companion');
        expect(readController().preference.visible).toBe(false);
        expect(revealedItems).toEqual([]);
        expect(revealedMutations).toEqual([]);
        expect(readPresentationNotice()).toBeNull();
    });

    it('shows the exact item with a safe Undo that preserves a newer unrelated density choice', async () => {
        const { addToCompanion, readController, revealedMutations } = await renderReference();
        expect(readController().availability).toBe('ready');
        await addToCompanion();
        expect(readController().preference.visible).toBe(true);
        expect(readController().preference.items).toContainEqual({ kind: 'widget', widgetId: 'item-1' });
        expect(revealedMutations).toHaveLength(1);
        expect(revealedMutations[0]?.applied).toEqual(readController().preference);
        const undo = readPresentationNotice()?.undo;
        expect(undo).toBeDefined();

        await act(async () => { readController().setDensity('compact'); });
        await act(async () => { undo?.run(); });
        expect(readController().preference.visible).toBe(false);
        expect(readController().preference.items).not.toContainEqual({ kind: 'widget', widgetId: 'item-1' });
        expect(readController().preference.density).toBe('compact');
    });

    it('does not reveal or publish another notice for an unchanged Companion mutation', async () => {
        const { addToCompanion, revealedMutations } = await renderReference();
        await addToCompanion();
        expect(readPresentationNotice()?.undo).toBeDefined();
        retirePresentationNotice();
        await addToCompanion();
        expect(revealedMutations).toHaveLength(1);
        expect(readPresentationNotice()).toBeNull();
    });

    it('does not let an old Add notice overwrite a newer edit to the same item', async () => {
        const { addToCompanion, readController } = await renderReference();
        await addToCompanion();
        const undo = readPresentationNotice()?.undo;
        expect(undo).toBeDefined();
        await act(async () => {
            readController().setItemFrameStyle({ kind: 'widget', widgetId: 'item-1' }, 'plain');
        });
        const latest = readController().preference;
        await act(async () => { undo?.run(); });
        expect(readController().preference).toBe(latest);
        expect(readController().preference.items).toContainEqual({
            kind: 'widget', widgetId: 'item-1', frameStyle: 'plain',
        });
    });
});
