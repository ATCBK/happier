import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';

/** P3 owns header composition; this model projects P4's one editor owner. */
export type WorkspaceFileEditorHeaderModel = Readonly<{
    status: WorkspaceFileEditorState['editorStatus'];
    saved: boolean;
    refusal: WorkspaceFileEditorState['refusal'];
    conflict: WorkspaceFileEditorState['conflict'];
    canSave: boolean;
    shortcutLabel: string | undefined;
    draftPersistenceFailed: boolean;
    lineEndingNormalization: 'lf' | 'crlf' | null;
    onSave(): void;
    onDone(): void;
    onCancel(): void;
    onStart(at?: { line: number }): void;
    onCompare(): void;
    onResolve(choice: 'useMine' | 'useTheirs'): void;
}>;
