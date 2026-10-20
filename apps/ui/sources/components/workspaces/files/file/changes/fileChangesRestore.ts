import type { ScmComparison, ScmComparisonDiscardEntry } from '@happier-dev/protocol/scm';
import { ScmChangeDiscardEntrySchema } from '@happier-dev/protocol/scm';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';

/** Whole-file restore uses the comparison arm, never the irreversible HEAD discard arm. */
export function buildFileChangesRestoreEntry(input: Readonly<{
    path: string;
    selector: SessionScmReviewComparison;
    comparison: ScmComparison | null;
    sessionId?: string;
    expectedHash?: string | null;
}>): Omit<ScmComparisonDiscardEntry, 'includeUndo'> | null {
    const comparison = input.comparison;
    if (input.selector.kind !== 'workingTree' && (!comparison
        || (input.selector.comparisonId && input.selector.comparisonId !== comparison.id)
        || !scmReviewComparisonMatchesSource(input.selector, comparison.source, comparison))) return null;
    const parsed = ScmChangeDiscardEntrySchema.safeParse({
        kind: 'comparison', path: input.path,
        against: input.selector.kind === 'workingTree' ? { source: { kind: 'workingTree' } }
            : { source: comparison!.source, comparisonId: comparison!.id, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        ...(input.expectedHash !== undefined && input.expectedHash !== null ? { expectedHash: input.expectedHash } : {}),
    });
    return parsed.success && parsed.data.kind === 'comparison' ? parsed.data : null;
}

/** The rendered request is also the menu's authority; a later tab selection cannot retarget it. */
export function resolveFileChangesRestoreIntent(input: Parameters<typeof buildFileChangesRestoreEntry>[0]) {
    const entry = buildFileChangesRestoreEntry(input);
    return { entry, restoreBeforeTurn: entry !== null && input.selector.kind === 'turnCheckpoint' };
}
