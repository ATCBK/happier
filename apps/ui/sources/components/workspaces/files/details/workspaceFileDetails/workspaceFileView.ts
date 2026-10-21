import type { FileChangesScope } from '@happier-dev/protocol/scm';
import { readFileChangesScope } from '@/components/workspaces/files/file/changes/fileChangesScope';
import type { FileDisplayMode } from '@/components/workspaces/files/file/filePageModel';

export type WorkspaceFileView = Readonly<{
    /** One-shot: open straight into the built-in editor (Edit from a plugin viewer's header). */
    startEditing?: boolean;
    /** Selected page mode, independent of whether a draft session remains open. */
    mode?: FileDisplayMode | 'edit';
    /** Built-in read-only text inspection, independent of the preferred plugin viewer. */
    viewer?: 'default' | 'text';
    changesScope?: FileChangesScope;
    blame?: boolean;
    scrollLine?: number;
    wrap?: boolean;
    findQuery?: string;
    previewSlice?: 'head' | 'tail';
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** Tolerant tab-state reader; draft fields remain owned by the editor. */
export function readWorkspaceFileView(tabState: unknown): WorkspaceFileView {
    const view = record(record(tabState).view);
    const changesScope = readFileChangesScope(view.changesScope);
    return {
        ...(view.mode === 'file' || view.mode === 'diff' || view.mode === 'markdown' || view.mode === 'edit' ? { mode: view.mode } : {}),
        ...(view.viewer === 'default' || view.viewer === 'text' ? { viewer: view.viewer } : {}),
        ...(changesScope ? { changesScope } : {}),
        ...(typeof view.blame === 'boolean' ? { blame: view.blame } : {}),
        ...(typeof view.scrollLine === 'number' && Number.isSafeInteger(view.scrollLine) && view.scrollLine > 0 ? { scrollLine: view.scrollLine } : {}),
        ...(typeof view.wrap === 'boolean' ? { wrap: view.wrap } : {}),
        ...(typeof view.findQuery === 'string' ? { findQuery: view.findQuery } : {}),
        ...(view.previewSlice === 'head' || view.previewSlice === 'tail' ? { previewSlice: view.previewSlice } : {}),
        ...(view.startEditing === true ? { startEditing: true } : {}),
    };
}

/** Pass this to pane.patchDetailsTabState; never replace the sibling editor draft. */
export function buildWorkspaceFileViewPatch(tabState: unknown, patch: Partial<WorkspaceFileView>) {
    return { view: { ...record(record(tabState).view), ...patch } };
}
