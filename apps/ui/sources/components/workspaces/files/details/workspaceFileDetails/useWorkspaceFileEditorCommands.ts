import * as React from 'react';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { registerFileEditorActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';
import type { WorkspaceFileEditorHeaderModel } from './workspaceFileEditorHeaderModel';

/** Mounted-owner, keyboard and departure adapters all call the same file hook. */
export function useWorkspaceFileEditorCommands(input: Readonly<{
    editor: WorkspaceFileEditorState;
    tabKey: string;
    serverId: string | null;
    accountId: string | null;
    focused: boolean;
    onStart(at?: { line: number }): void;
}>): WorkspaceFileEditorHeaderModel {
    // A pending Action or departure retains its admitted Home/Account binding.
    const latest = React.useMemo(() => ({ current: input }), [input.serverId, input.accountId, input.tabKey]);
    latest.current = input;
    const dirty = React.useMemo(() => ({ current: input.editor.editorDirty }), [latest]);
    dirty.current = input.editor.editorDirty;
    const shortcutLabel = useKeyboardShortcutLabel('files.editor.save');
    const save = React.useCallback(() => { void latest.current.editor.saveFileEdits(); }, [latest]);
    const handlers = React.useMemo(() => input.focused && input.editor.isEditingFile && !input.editor.isSavingEdits
        ? { 'files.editor.save': save } : {}, [input.focused, input.editor.isEditingFile, input.editor.isSavingEdits, save]);
    useKeyboardShortcutHandlers(handlers);
    React.useEffect(() => {
        if (!input.editor.isEditingFile) return;
        return registerFileEditorActionOwner(() => ({
            tabId: input.tabKey,
            serverId: input.serverId,
            accountId: input.accountId,
            save: async () => {
                const editor = latest.current.editor;
                if (!editor.isEditingFile) return { status: 'unavailable' };
                if (editor.conflict) return { status: 'conflict' };
                await editor.editorHandleRef.current?.flushPendingChange();
                const text = editor.editorHandleRef.current?.getValue() ?? editor.getEditorText();
                if (text === editor.editorOriginalText) return { status: 'clean' };
                const saved = await editor.saveFileEdits();
                const snapshot = editor.readSnapshot();
                if (saved) return { status: 'saved', ...(snapshot.hash ? { hash: snapshot.hash } : {}) };
                return { status: snapshot.conflict ? 'conflict' : 'unavailable' };
            },
            resolve: async resolution => {
                const editor = latest.current.editor;
                if (!editor.isEditingFile) return { status: 'unavailable' };
                if (resolution === 'discardDraft') editor.cancelEditingFile();
                else {
                    if (!editor.conflict) return { status: 'unavailable' };
                    await editor.resolveConflict(resolution);
                    if (editor.readSnapshot().conflict) return { status: 'unavailable' };
                }
                const snapshot = editor.readSnapshot();
                return { status: 'resolved', ...(snapshot.hash ? { hash: snapshot.hash } : {}) };
            },
        }));
    }, [input.editor.isEditingFile, input.tabKey, input.serverId, input.accountId, latest]);
    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        tag: 'workspace-file-editor', isDirtyRef: dirty,
        prepareGuard: async () => {
            const editor = latest.current.editor;
            await editor.editorHandleRef.current?.flushPendingChange();
            const value = editor.editorHandleRef.current?.getValue() ?? editor.getEditorText();
            editor.onEditorChange(value);
            dirty.current = editor.isEditingFile && value !== editor.editorOriginalText;
        },
        requestDecision: () => promptUnsavedChangesAlert(Modal.alert, {
            title: t('common.discardChanges'), message: t('common.unsavedChangesWarning'), discardText: t('common.discardChanges'),
            saveText: t('common.save'), keepEditingText: t('common.keepEditing'),
        }),
        onSave: () => latest.current.editor.saveFileEdits(),
        onDiscard: () => latest.current.editor.cancelEditingFile(),
        continueOnSave: false,
    }), [dirty, latest]);
    useActiveUnsavedChangesGuard({ navigation: null, guard, tabId: input.tabKey, focused: input.focused, enabled: input.editor.isEditingFile });
    return React.useMemo(() => ({ status: input.editor.editorStatus, saved: input.editor.savedAtMs !== null,
        refusal: input.editor.refusal, conflict: input.editor.conflict, canSave: input.editor.editorDirty && !input.editor.isSavingEdits && !input.editor.conflict,
        shortcutLabel, draftPersistenceFailed: input.editor.draftPersistenceFailed, lineEndingNormalization: input.editor.lineEndingNormalization, onSave: save,
        onDone: input.editor.doneEditingFile, onCancel: input.editor.cancelEditingFile, onStart: input.onStart,
        onCompare: input.editor.startComparison, onResolve: choice => { void latest.current.editor.resolveConflict(choice); },
    }), [input.editor.editorStatus, input.editor.savedAtMs, input.editor.refusal, input.editor.conflict, input.editor.editorDirty,
        input.editor.isSavingEdits, input.editor.draftPersistenceFailed, input.editor.lineEndingNormalization, input.editor.doneEditingFile, input.editor.cancelEditingFile,
        input.editor.startComparison, input.onStart, save, shortcutLabel]);
}
