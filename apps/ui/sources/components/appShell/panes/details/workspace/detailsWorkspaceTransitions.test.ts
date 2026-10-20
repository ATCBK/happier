import { describe, expect, it } from 'vitest';

import {
    applyCloseDetailsTab,
    applyMoveDetailsTabToGroup,
    applyOpenDetailsTab,
    applyPinDetailsTab,
    applyUnpinDetailsTab,
    applySetDetailsTabState,
    applySetActiveDetailsTab,
    applySetDetailsSplitRatio,
    applySplitDetailsGroup,
    createEmptyPaneDetailsState,
} from './detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from './migrateLegacyDetailsWorkspaceState';

function openFile(state: ReturnType<typeof createEmptyPaneDetailsState>, name: string) {
    return applyOpenDetailsTab(state, {
        tab: { key: `file:${name}`, kind: 'file', title: name, resource: { path: name } },
        openAs: 'pinned',
    });
}

describe('Details tab group transitions', () => {
    it('keeps a dirty file pinned when unpin is followed by opening another preview', () => {
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'unsaved' };
        let state = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:a', kind: 'file', title: 'a', resource: { path: 'a' } }, openAs: 'preview',
        });
        state = applySetDetailsTabState(state, 'file:a', draft);
        state = applyPinDetailsTab(state, 'file:a');
        state = applyUnpinDetailsTab(state, 'file:a');
        state = applyOpenDetailsTab(state, {
            tab: { key: 'file:b', kind: 'file', title: 'b', resource: { path: 'b' } }, openAs: 'preview',
        });
        expect(state.tabsByKey['file:a']).toMatchObject({ isPinned: true, isPreview: false });
        expect(state.tabState['file:a']).toEqual(draft);
    });
    it('returns to the most recently active surviving tab when the active tab closes', () => {
        let state = createEmptyPaneDetailsState();
        state = openFile(state, 'a');
        state = openFile(state, 'b');
        state = openFile(state, 'c');
        state = applySetActiveDetailsTab(state, 'file:a');
        state = applySetActiveDetailsTab(state, 'file:c');
        state = applySetActiveDetailsTab(state, 'file:b');

        state = applyCloseDetailsTab(state, 'file:b');

        expect(state.groupsById['group:1']?.activeTabKey).toBe('file:c');
    });

    it('moves a tab through nested split groups, resizes, collapses, and restores the Details tree', () => {
        let state = openFile(createEmptyPaneDetailsState(), 'a');
        state = applySplitDetailsGroup(state, { axis: 'vertical', groupId: 'group:1' });
        state = openFile(state, 'b');
        state = applySplitDetailsGroup(state, { axis: 'horizontal', groupId: 'group:2' });
        state = openFile(state, 'c');

        const outerSplitId = state.root?.id;
        expect(outerSplitId).toBeTruthy();
        state = applySetDetailsSplitRatio(state, outerSplitId!, 0.6);
        state = applyMoveDetailsTabToGroup(state, { tabKey: 'file:b', targetGroupId: 'group:3' });

        expect(state.groupsById['group:2']).toBeUndefined();
        expect(state.groupsById['group:3']?.tabKeys).toEqual(['file:c', 'file:b']);
        expect(state.focusedGroupId).toBe('group:3');
        expect(state.root).toMatchObject({ kind: 'split', axis: 'row', ratio: 0.6 });

        state = applyCloseDetailsTab(state, 'file:b');
        const restored = migrateLegacyDetailsWorkspaceState(serializeDetailsWorkspaceState(state));
        expect(restored.groupsById['group:3']?.activeTabKey).toBe('file:c');
        expect(restored.root).toEqual(state.root);
    });
});
