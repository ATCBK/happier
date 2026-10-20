import { describe, expect, it } from 'vitest';

import { readWorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import { applyMoveDetailsTabToGroup, applyOpenDetailsTab, applySetDetailsTabState, applySplitDetailsGroup, createEmptyPaneDetailsState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from '@/components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState';

const aliceDraft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'a'.repeat(64), editorText: '{"version":' };

describe('workspace file editor draft ownership', () => {
    it('retains draft bytes through a tab group move and serialized pane remount without a module cache', () => {
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'unsaved' };
        let details = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:a', kind: 'file', title: 'a', resource: { path: 'a' } }, openAs: 'pinned',
        });
        details = applySetDetailsTabState(details, 'file:a', draft);
        details = applySplitDetailsGroup(details, { axis: 'horizontal', groupId: 'group:1' });
        details = applyMoveDetailsTabToGroup(details, { tabKey: 'file:a', targetGroupId: 'group:2' });
        const remounted = migrateLegacyDetailsWorkspaceState(JSON.parse(JSON.stringify(serializeDetailsWorkspaceState(details))));
        expect(remounted.groupsById['group:2']?.tabKeys).toContain('file:a');
        expect(remounted.tabState['file:a']).toEqual(draft);
        expect(readWorkspaceFileEditorDraft(remounted.tabState['file:a'], 'alice')?.editorText).toBe('unsaved');
    });
    it('restores only explicitly hash-qualified drafts and strips obsolete and unknown fields', () => {
        const current = { accountId: 'alice', isEditingFile: true, editorOriginalHash: null, editorText: 'unfinished' };
        expect(readWorkspaceFileEditorDraft({ ...current, editorOriginalText: 'obsolete', future: true }, 'alice')).toEqual(current);
        const { editorOriginalHash: _, ...withoutHash } = current;
        expect(readWorkspaceFileEditorDraft(withoutHash, 'alice')).toBeNull();
        expect(readWorkspaceFileEditorDraft({ ...current, editorOriginalHash: 42 }, 'alice')).toBeNull();
        expect(readWorkspaceFileEditorDraft(Object.assign(Object.create({ editorOriginalHash: null }), withoutHash), 'alice')).toBeNull();
    });
    it('qualifies persisted bytes and editing metadata before any pane consumer receives them', () => {
        expect(readWorkspaceFileEditorDraft(aliceDraft, 'alice')).toEqual(aliceDraft);
        expect(readWorkspaceFileEditorDraft(aliceDraft, 'bob')).toBeNull();
        expect(readWorkspaceFileEditorDraft(aliceDraft, null)).toBeNull();
        const legacy = { isEditingFile: true, editorOriginalText: 'original', editorText: 'unqualified private bytes' };
        expect(readWorkspaceFileEditorDraft(legacy, 'alice')).toBeNull();
        expect(legacy.editorText).toBe('unqualified private bytes');
    });
});
