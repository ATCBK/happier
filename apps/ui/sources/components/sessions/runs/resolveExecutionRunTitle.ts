import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import { t } from '@/text';

/**
 * What a Run is for, in words: the title it was given (the intent or prompt it was started with),
 * else its kind of work. Never its id — a tab, a header or a menu row that reads "run 7f3a…" names
 * plumbing, not the work (agents lab RP1, audit §3.2).
 */
export function resolveExecutionRunTitle(
    run: Readonly<{ display?: Pick<NonNullable<ExecutionRunPublicState['display']>, 'title'> | null; intent?: string | null }>,
    surface: 'summary' | 'conversation' | 'recipient' = 'summary',
): string {
    if (run.intent === 'scm_diff_summary') {
        if (surface === 'conversation') return t('walkthrough.conversationTitle');
        if (surface === 'recipient') return t('walkthrough.eyebrow');
    }
    const displayTitle = run.display?.title?.trim();
    if (displayTitle) return displayTitle;
    switch (run.intent) {
        case 'review': return t('runPage.intentTitles.review');
        case 'plan': return t('runPage.intentTitles.plan');
        case 'delegate': return t('runPage.intentTitles.delegate');
        case 'scm_diff_summary': return t('runPage.intentTitles.scmDiffSummary');
        default: return t('runPage.untitledRun');
    }
}
