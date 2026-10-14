import type { SessionDiscussionErrorCodeV1, SESSION_DISCUSSION_NOT_TRACKED_CODE_V1 } from '@happier-dev/protocol/sessions/discussions/api';

export type SessionDiscussionFailureCode =
    | SessionDiscussionErrorCodeV1
    | typeof SESSION_DISCUSSION_NOT_TRACKED_CODE_V1;

export type SessionDiscussionResult<TValue> =
    | Readonly<{ ok: true; value: TValue }>
    | Readonly<{ ok: false; error: SessionDiscussionFailureCode }>;

export function discussionFailure(error: SessionDiscussionFailureCode): SessionDiscussionResult<never> {
    return { ok: false, error };
}

export function discussionSuccess<TValue>(value: TValue): SessionDiscussionResult<TValue> {
    return { ok: true, value };
}
