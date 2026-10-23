import {
    readAgentStartupFailureCode,
    readSessionPreparationFailureCode,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
    ProviderBrokerAdmissionFailureCodeV1Schema,
    type ProviderBrokerAdmissionFailureCodeV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

function isTeamCredentialRefusal(code: string): code is ProviderBrokerAdmissionFailureCodeV1 {
    return ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success;
}

/**
 * The localized cause and recovery step for a closed startup-failure code, or null for any other code.
 * Protocol admits the code; the translation keys are named by it, so a code Protocol adds cannot be
 * presented until every locale has its copy. Broker refusals share one Team-credential message.
 */
export function presentSessionStartupFailureCause(code: unknown): string | null {
    const startup = readAgentStartupFailureCode(code);
    if (startup) return t(`session.startFailure.cause.${startup}`);
    const preparation = readSessionPreparationFailureCode(code);
    if (!preparation) return null;
    return isTeamCredentialRefusal(preparation)
        ? t('session.startFailure.cause.teamCredential')
        : t(`session.startFailure.cause.${preparation}`);
}

/** Present the source's cause (localized when its code is a closed startup failure) and reported reset; no recovery is inferred. */
export function presentSessionRuntimeIssue(issue: SessionRuntimeIssueV1 | null | undefined): Readonly<{
    message: string | null;
    reset: string | null;
}> {
    const resetAtMs = issue?.usageLimit?.resetAtMs;
    const resetDate = resetAtMs == null ? null : new Date(resetAtMs);
    return {
        message: presentSessionStartupFailureCause(issue?.code) ?? issue?.sanitizedPreview ?? null,
        reset: resetDate !== null && Number.isFinite(resetDate.getTime())
            ? t('usage.board.plans.capacityResets', { time: formatWithCachedDateTimeFormatter(resetDate, undefined, {
                dateStyle: 'medium', timeStyle: 'short',
            }) })
            : null,
    };
}
