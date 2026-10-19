import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

/** Present only the source's sanitized cause and reported reset; no recovery is inferred. */
export function presentSessionRuntimeIssue(issue: SessionRuntimeIssueV1 | null | undefined): Readonly<{
    message: string | null;
    reset: string | null;
}> {
    const resetAtMs = issue?.usageLimit?.resetAtMs;
    const resetDate = resetAtMs == null ? null : new Date(resetAtMs);
    return {
        message: issue?.sanitizedPreview ?? null,
        reset: resetDate !== null && Number.isFinite(resetDate.getTime())
            ? t('usage.board.plans.capacityResets', { time: formatWithCachedDateTimeFormatter(resetDate, undefined, {
                dateStyle: 'medium', timeStyle: 'short',
            }) })
            : null,
    };
}
