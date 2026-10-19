import type { WorkflowReviewResultSourceV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useActiveServerAccountScopeLifetime, useUser } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * Who answered a Wait or review, in one quiet line beside the completed answer.
 *
 * Only a human-accepted result names a person. The name comes from the Account display-name owner and
 * only for a profile this viewer already holds; an Account the viewer cannot name stays anonymous
 * rather than being guessed from the Run's starter or a Team grant.
 */
export function resolveAnsweredByLabel(input: Readonly<{
    resultSource: WorkflowReviewResultSourceV1 | undefined;
    viewerAccountId: string | null;
    profile: Readonly<{ name?: string | null; username?: string | null }> | null | undefined;
}>): string | null {
    const source = input.resultSource;
    if (source?.kind !== 'human') return null;
    if (source.accountId === input.viewerAccountId) return t('workflows.run.answeredByYou');
    const name = input.profile ? formatAccountDisplayName(input.profile) : null;
    return name ? t('workflows.run.answeredBy', { name }) : t('workflows.run.answeredByPerson');
}

export function useAnsweredByLabel(resultSource: WorkflowReviewResultSourceV1 | undefined): string | null {
    const viewerAccountId = useActiveServerAccountScopeLifetime()?.scope.accountId ?? null;
    const profile = useUser(resultSource?.kind === 'human' ? resultSource.accountId : undefined);
    return resolveAnsweredByLabel({ resultSource, viewerAccountId, profile });
}
