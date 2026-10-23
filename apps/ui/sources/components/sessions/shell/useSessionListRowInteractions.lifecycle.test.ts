import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRowInteractions, type UseSessionListRowInteractionsInput } from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';

const scope = { serverId: 'lifecycle-home', accountId: 'lifecycle-account' };
const workspace = { t: 'workspaceScope', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo' } as const;
const items: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project', workspaceKey: 'project', workspace, serverId: scope.serverId },
    { type: 'session', sessionId: 'source', serverId: scope.serverId, storageKind: 'persisted', groupKey: 'project', groupKind: 'project', folderId: null, folderDepth: 0, workspace },
];
const sessionKey = sessionAddressKey({ serverId: scope.serverId, sessionId: 'source' });
const sourceRowId = treeRowId.session(scope.serverId, 'source');

function input(): UseSessionListRowInteractionsInput {
    return { folderActionsEnabled: true, isFolderActionsEnabledForServerId: () => true,
        sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1, listItems: items, currentGroupOrderMap: {}, currentWorkspaceOrderMap: {},
        sessionListOrderingModeV1: 'custom', sessionListSectionModeV1: 'activity', manualSessionOrderingEnabled: true,
        setSessionListGroupOrderV1: vi.fn(async () => {}), setSessionWorkspaceOrderV1: vi.fn(async () => {}), setSessionFoldersV1: vi.fn(async () => {}),
        pinnedKeySet: new Set(), sessionTags: {}, setSessionPinForKey: vi.fn(), setSessionTagsForKey: vi.fn() };
}

describe('Session list canonical carry retirement', () => {
    afterEach(() => { standardCleanup(); getStorage().setState({ profileScope: null }); });

    it('does not re-render mounted drag consumers when the list receives unchanged inputs', async () => {
        getStorage().setState({ profileScope: scope });
        let renders = 0;
        const Row = React.memo(function Row(_props: { onDragStart: (key: string) => void }) {
            renders += 1;
            return null;
        });
        function List(props: { value: UseSessionListRowInteractionsInput }) {
            const interactions = useSessionListRowInteractions(props.value);
            return React.createElement(Row, { onDragStart: interactions.handleDragStart });
        }
        const value = input();
        const screen = await renderScreen(React.createElement(List, { value }));
        const mounted = renders;
        await screen.update(React.createElement(List, { value: { ...value } }));
        expect(renders - mounted).toBe(0);
        await screen.unmount();
    });

    it('clears the lifted row and retires its source when the realm cancels externally', async () => {
        getStorage().setState({ profileScope: scope });
        const hook = await renderHook(() => useSessionListRowInteractions(input()));
        const runtime = hook.getCurrent().entityDragDrop.runtime;
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        expect(hook.getCurrent().draggingSessionKey).toBe(sessionKey);
        const sourceId = runtime.getSnapshot().sourceId!;
        act(() => runtime.cancel('window-blur'));
        expect(hook.getCurrent().draggingSessionKey).toBeNull();
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        expect(runtime.begin(sourceId)).toBeNull();
        await hook.unmount();
    });

    it('starts from current keyed topology after rows move and cancels without an organization write', async () => {
        getStorage().setState({ profileScope: scope });
        const initial = input();
        const source = items[1];
        if (!source || source.type !== 'session') throw new Error('Expected the source Session fixture');
        const neighbor = { ...source, sessionId: 'neighbor' } satisfies SessionListIndexItem;
        const shiftedItems = [items[0]!, neighbor, source];
        const hook = await renderHook((props: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(props), {
            initialProps: initial,
        });
        try {
            await hook.rerender({ ...initial, listItems: shiftedItems });
            act(() => { hook.getCurrent().handleDragStart(sessionKey); });
            const snapshot = hook.getCurrent().activeDragSnapshot;
            expect(snapshot?.source.sourceRowId).toBe(sourceRowId);
            expect(snapshot?.topology.rows.filter(row => row.kind === 'leaf').map(row => row.rowId))
                .toEqual([treeRowId.session(scope.serverId, 'neighbor'), sourceRowId]);
            act(() => { hook.getCurrent().handleDragCancel(); });
            expect(hook.getCurrent().activeDragSnapshot).toBeNull();
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
            expect(initial.setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(initial.setSessionWorkspaceOrderV1).not.toHaveBeenCalled();
            expect(initial.setSessionFoldersV1).not.toHaveBeenCalled();

            await hook.rerender({ ...initial, listItems: [items[0]!, source, neighbor] });
            act(() => { hook.getCurrent().handleDragStart(sessionKey); });
            expect(hook.getCurrent().activeDragSnapshot?.topology.rows.filter(row => row.kind === 'leaf').map(row => row.rowId))
                .toEqual([sourceRowId, treeRowId.session(scope.serverId, 'neighbor')]);
            act(() => { hook.getCurrent().handleDragCancel(); });
        } finally {
            await hook.unmount();
        }
    });

    it('clears staged keyboard state on external cancellation and can pick up again', async () => {
        getStorage().setState({ profileScope: scope });
        const hook = await renderHook(() => useSessionListRowInteractions(input()));
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        act(() => hook.getCurrent().entityDragDrop.runtime.cancel('escape-layer'));
        expect(hook.getCurrent().stagedMove.view.label).toBeNull();
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        await hook.unmount();
    });

    it('retires a carry when its source leaves the current list or its mounted row retires', async () => {
        getStorage().setState({ profileScope: scope });
        const initial = input();
        const hook = await renderHook((props: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(props), { initialProps: initial });
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        await hook.rerender({ ...initial, listItems: [items[0]!] });
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        await hook.rerender(initial);
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        act(() => hook.getCurrent().unregisterTreeRowBounds(sourceRowId));
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        await hook.unmount();
    });
});
