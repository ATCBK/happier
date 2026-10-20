export type WorkspaceFileEditorConflict = Readonly<{ theirsText: string; theirsHash: string }>;

/** The disk and buffer observations belong to the file editor, not to the header. */
export function deriveWorkspaceFileEditorConflict(input: Readonly<{
    isEditingFile: boolean;
    baseHash: string | null;
    diskHash: string | null;
    diskText: string | null;
    draftText: string;
}>): WorkspaceFileEditorConflict | null {
    if (!input.isEditingFile || input.baseHash === null || input.diskHash === null || input.diskText === null) return null;
    return input.baseHash !== input.diskHash && input.draftText !== input.diskText
        ? { theirsText: input.diskText, theirsHash: input.diskHash } : null;
}
