import type { ScmWorktreeEnrichmentEntry } from '@happier-dev/protocol/scm';
import type { StorageCategoryVerdict } from '../categories/types';
import { check } from '../categories/filesystem';

export type WorktreeVerdictFacts = Readonly<{
    isMain?: boolean;
    inUse: boolean | 'unknown';
    scm?: ScmWorktreeEnrichmentEntry;
    draft: 'present' | 'absent' | 'unknown';
    pullRequest: 'open' | 'none' | 'unknown';
}>;
/** Keep reasons outrank incomplete evidence; unknown evidence never establishes Can delete. */
export function worktreeVerdict(facts: WorktreeVerdictFacts): StorageCategoryVerdict {
    const keep = (code: 'main_checkout' | 'in_use' | 'changed_files' | 'unpushed_commits' | 'unsaved_edits' | 'open_pr', count?: number): StorageCategoryVerdict => {
        const reason = { code, ...(count !== undefined ? { detail: { count } } : {}) };
        return { verdict: 'keep', reason, collectable: true, loses: [reason] };
    };
    if (facts.isMain) return keep('main_checkout');
    if (facts.inUse === true) return keep('in_use');
    if ((facts.scm?.changeCount ?? 0) > 0) return keep('changed_files', facts.scm?.changeCount);
    if ((facts.scm?.ahead ?? 0) > 0) return keep('unpushed_commits', facts.scm?.ahead);
    if (facts.draft === 'present') return keep('unsaved_edits');
    if (facts.pullRequest === 'open') return keep('open_pr');
    const scm = facts.scm;
    if (facts.inUse === 'unknown' || facts.draft === 'unknown' || facts.pullRequest === 'unknown'
        || !scm || scm.changeCount === undefined || scm.ahead === undefined || scm.upstream === undefined
        || scm.upstreamGone === undefined || scm.mergedIntoDefault === undefined || !scm.headOid) return check;
    const code = scm.mergedIntoDefault ? 'merged_clean' : scm.upstreamGone ? 'branch_gone' : 'clean_pushed';
    return { verdict: 'safe', reason: { code }, collectable: true };
}
