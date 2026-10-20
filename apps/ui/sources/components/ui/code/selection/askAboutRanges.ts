import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { upsertWorkspaceReviewCommentDraft } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { buildAskSelectionDrafts, buildAskSelectionQuote, type AskSelectionRange } from './askSelectionModel';
import { askSelectionQuote, type AskSelectionTargetContext, type AskSelectionSessionTarget } from './askSelectionTarget';
export type { AskSelectionTargetContext, AskSelectionSessionTarget } from './askSelectionTarget';

/** Shared selection/Problems entry: drafts survive until a Session composer mounts. */
export async function askAboutRanges(input: Readonly<{
    workspaceScope: WorkspaceScopeBase;
    filePath: string;
    ranges: readonly AskSelectionRange[];
    savedText: string;
    sessionTarget: AskSelectionSessionTarget | null;
    text?: string;
    source?: ReviewCommentSource;
    lines?: readonly CodeLine[];
    includeInPrompt?: boolean;
    /** Problems and other non-hook hosts use the same no-Session destination owner. */
    targetContext?: AskSelectionTargetContext;
    sideRun?: boolean;
}>): Promise<Readonly<{ created: number; drafts: readonly ReviewCommentDraft[] }>> {
    const existingDrafts = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(input.workspaceScope)] ?? [];
    const drafts = buildAskSelectionDrafts({ filePath: input.filePath, source: input.source ?? 'file',
        text: input.text ?? input.savedText, savedText: input.savedText,
        ranges: input.ranges, lines: input.lines, existingDrafts });
    if (input.targetContext && (!input.sessionTarget || input.sideRun)) {
        if (!drafts.length) return { created: 0, drafts: [] };
        const quote = drafts.map((draft) => `${buildAskSelectionQuote({ filePath: input.filePath,
            ...(draft.anchor.kind === 'range' ? { startLine: draft.anchor.startLine, endLine: draft.anchor.endLine } : {}),
            text: draft.snapshot.selectedLines.join('\n'),
        })}${draft.body ? `\n\n${draft.body}` : ''}`).join('\n\n');
        const applied = await askSelectionQuote({ workspaceScope: input.workspaceScope, sessionTarget: input.sessionTarget,
            quote, context: input.targetContext, sideRun: input.sideRun });
        return { created: applied ? drafts.length : 0, drafts: applied ? drafts : [] };
    }
    const savedDrafts = input.includeInPrompt === false ? drafts.map((draft) => ({ ...draft, includeInPrompt: false })) : drafts;
    for (const draft of savedDrafts) upsertWorkspaceReviewCommentDraft(input.workspaceScope, draft);
    if (drafts.length && input.sessionTarget) {
        input.sessionTarget.revealSessionColumn?.();
        requestRegisteredComposerFocus({ kind: 'session', sessionId: input.sessionTarget.sessionId });
    }
    return { created: savedDrafts.length, drafts: savedDrafts };
}
