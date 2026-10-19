import { z } from 'zod/mini';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

/** Private source-to-original-owner contribution. Rule definitions and identities never leave the evaluator. */
export const SessionActivityChangedResultSchema = z.strictObject({
    personalFollow: z.optional(z.strictObject({
        sourceSessionId: z.string().check(z.minLength(1)),
        /** Proven existing source-backed Inbox effect, never a provider callback. */
        accepted: z.optional(z.literal(true)),
        requests: z.optional(z.array(z.strictObject({
            requestId: z.string().check(z.minLength(1)),
            policies: z.array(FollowPolicyV1Schema),
        }))),
        sourceMessage: z.optional(z.strictObject({
            localId: z.string().check(z.minLength(1)),
            seq: z.number().check(z.int(), z.positive()),
            policies: z.array(FollowPolicyV1Schema),
        })),
    })),
});
export type SessionActivityChangedResult = z.infer<typeof SessionActivityChangedResultSchema>;
export const SessionActivityChangedResponseSchema = z.strictObject({
    ok: z.literal(true),
    ...SessionActivityChangedResultSchema.shape,
});
