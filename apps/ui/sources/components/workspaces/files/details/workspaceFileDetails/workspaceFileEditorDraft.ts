export type WorkspaceFileEditorDraft = Readonly<{
    accountId: string;
    isEditingFile: boolean;
    editorOriginalHash: string | null;
    editorText: string;
}>;

/** Draft bytes are Account-qualified; unknown fields never become editor state. */
export function readWorkspaceFileEditorDraft(value: unknown, accountId: string | null): WorkspaceFileEditorDraft | null {
    if (!accountId?.trim() || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const draft = value as Partial<Record<keyof WorkspaceFileEditorDraft, unknown>>;
    if (draft.accountId !== accountId || typeof draft.isEditingFile !== 'boolean'
        || !Object.prototype.hasOwnProperty.call(draft, 'editorOriginalHash')
        || (draft.editorOriginalHash !== null && typeof draft.editorOriginalHash !== 'string')
        || typeof draft.editorText !== 'string') return null;
    return {
        accountId,
        isEditingFile: draft.isEditingFile,
        editorOriginalHash: draft.editorOriginalHash,
        editorText: draft.editorText,
    };
}

