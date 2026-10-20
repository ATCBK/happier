import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import { readWorkspaceFileEditorDraft, type WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import { applyMoveDetailsTabToGroup, applyOpenDetailsTab, applySetDetailsTabState, applySplitDetailsGroup, createEmptyPaneDetailsState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from '@/components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState';

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const actionBoundary = getWorkspaceFileDetailsActionBoundary();

type Inputs = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string | null;
    fileHash: string | null;
    persistedDraft?: WorkspaceFileEditorDraft | null;
}>;
let serverId = 'srv1';
async function harness(initial: Inputs, onPersist?: (draft: WorkspaceFileEditorDraft | null) => void) {
    const persistDraft = vi.fn(onPersist);
    const refreshAll = vi.fn(async () => undefined);
    const mountedRef = { current: true };
    const setFileWriteSupported = vi.fn();
    return renderHook((props: Inputs) => useWorkspaceFileEditorState({
        accountId: 'alice', scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/a.ts',
        ...props, fileWriteSupported: true, setFileWriteSupported,
        fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 10,
        mountedRef, refreshAll, persistDraft,
    }), { initialProps: initial });
}

describe('file editor entry and persisted restoration', () => {
    beforeEach(async () => {
        serverId = await prepareWorkspaceFileDetailsActionBoundary();
        actionBoundary.read.mockReset().mockResolvedValue({ success: true, hash: 'saved' });
    });
    afterEach(async () => {
        await standardCleanup();
        await cleanupWorkspaceFileDetailsActionBoundary();
    });

    it.each([
        { displayMode: 'diff' as const, fileText: 'base', fileHash: 'base-hash' },
        { displayMode: 'file' as const, fileText: null, fileHash: null },
    ])('opens the requested editor once complete content is available ($displayMode)', async (initial) => {
        const hook = await harness(initial);
        await act(async () => hook.getCurrent().startEditingFile());
        expect(hook.getCurrent().isEditingFile).toBe(false);
        await hook.rerender({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
    });

    it('keeps the save callback stable across equivalent disk rerenders', async () => {
        const inputs: Inputs = { displayMode: 'file', fileText: 'base', fileHash: 'hash' };
        const hook = await harness(inputs);
        const save = hook.getCurrent().saveFileEdits;
        await hook.rerender({ ...inputs });
        expect(hook.getCurrent().saveFileEdits).toBe(save);
    });

    it('adopts external content while the editor is clean', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        await act(async () => hook.getCurrent().startEditingFile());
        await hook.rerender({ displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash' });
        expect(hook.getCurrent().getEditorText()).toBe('disk');
        expect(hook.getCurrent().conflict).toBeNull();
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('restores persisted draft bytes and derives a conflict against changed disk without original text', async () => {
        const draft: WorkspaceFileEditorDraft = {
            accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base-hash', editorText: 'unfinished draft',
        };
        const hook = await harness({ displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash', persistedDraft: draft });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('unfinished draft');
        expect(hook.getCurrent().conflict).toEqual({ theirsText: 'disk', theirsHash: 'disk-hash' });
    });

    it('flushes the last edit through persisted tab state before a group move and editor remount', async () => {
        let details = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:src/a.ts', kind: 'file', title: 'a.ts', resource: { path: 'src/a.ts' } }, openAs: 'pinned',
        });
        const disk: Inputs = { displayMode: 'file', fileText: 'base', fileHash: 'base-hash' };
        const hook = await harness(disk, draft => { details = applySetDetailsTabState(details, 'file:src/a.ts', draft); });
        await act(async () => {
            hook.getCurrent().startEditingFile();
            hook.getCurrent().onEditorChange('last unsaved edit');
        });
        await hook.unmount();
        details = applySplitDetailsGroup(details, { axis: 'horizontal', groupId: 'group:1' });
        details = applyMoveDetailsTabToGroup(details, { tabKey: 'file:src/a.ts', targetGroupId: 'group:2' });
        const remounted = migrateLegacyDetailsWorkspaceState(JSON.parse(JSON.stringify(serializeDetailsWorkspaceState(details))));
        const persistedDraft = readWorkspaceFileEditorDraft(remounted.tabState['file:src/a.ts'], 'alice');
        expect(persistedDraft).toEqual({ accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base-hash', editorText: 'last unsaved edit' });
        const restored = await harness({ ...disk, persistedDraft });
        expect(restored.getCurrent().getEditorText()).toBe('last unsaved edit');
        expect(restored.getCurrent().editorDirty).toBe(true);
    });

    it('ignores a dev-intermediate draft without its original hash', async () => {
        const oldDraft = { accountId: 'alice', isEditingFile: true, editorOriginalText: 'old', editorText: 'draft' };
        const hook = await harness({
            displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash',
            persistedDraft: readWorkspaceFileEditorDraft(oldDraft, 'alice'),
        });
        expect(hook.getCurrent().isEditingFile).toBe(false);
    });
});
