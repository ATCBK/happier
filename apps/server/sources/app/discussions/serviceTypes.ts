import type { DiscussionErrorCodeV1, DISCUSSION_NOT_TRACKED_CODE_V1 } from '@happier-dev/protocol/discussions/api';

export type DiscussionFailureCode =
    | DiscussionErrorCodeV1
    | typeof DISCUSSION_NOT_TRACKED_CODE_V1;

export type DiscussionResult<TValue> =
    | Readonly<{ ok: true; value: TValue }>
    | Readonly<{ ok: false; error: DiscussionFailureCode }>;

export function discussionFailure(error: DiscussionFailureCode): DiscussionResult<never> {
    return { ok: false, error };
}

export function discussionSuccess<TValue>(value: TValue): DiscussionResult<TValue> {
    return { ok: true, value };
}
