import { SessionGoalControlFailureV1Schema, SessionWorkStateGetResponseV1Schema,
    type SessionGoalControlFailureV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

import { t } from '@/text';

export type SessionGoalOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string; errorCode?: string; goalControlFailure?: SessionGoalControlFailureV1 }>;

/** Read the Goal operation itself, including when an Action has already accepted its envelope. */
export function readGoalOperationResult(response: unknown): SessionGoalOperationResult {
    if (response && typeof response === 'object') {
        const raw = response as Record<string, unknown>;
        if (raw.ok === true) return { ok: true };
        if (typeof raw.error === 'string') {
            const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(raw.goalControlFailure);
            return { ok: false, error: raw.error, ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
                ...(goalControlFailure.success ? { goalControlFailure: goalControlFailure.data } : {}) };
        }
        if (SessionWorkStateGetResponseV1Schema.safeParse(raw).success) return { ok: true };
    }
    return { ok: false, error: t('session.workState.goal.errorUnsupportedResponse') };
}
