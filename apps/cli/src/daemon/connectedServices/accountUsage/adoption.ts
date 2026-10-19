import { z } from 'zod/mini';

import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageRecordKeyV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';

const ProviderAccountUsageAdoptionProofV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('id_token_account_id'),
        issuer: z.optional(z.string().check(z.trim(), z.minLength(1))),
    }),
    z.strictObject({
        kind: z.literal('provider_account_id_match'),
    }),
    z.strictObject({
        kind: z.literal('provider_owned_subject_proof'),
        detail: z.optional(z.string().check(z.trim(), z.minLength(1))),
    }),
]);

export const ProviderAccountUsageAdoptionV1Schema = z.strictObject({
    providerId: z.string().check(z.trim(), z.minLength(1)),
    fromRecordId: ProviderAccountUsageRecordIdSchema,
    toRecordId: ProviderAccountUsageRecordIdSchema,
    stableRecordKey: ProviderAccountUsageRecordKeyV1Schema,
    proof: ProviderAccountUsageAdoptionProofV1Schema,
    observedAtMs: z.number().check(z.int(), z.nonnegative()),
}).check(z.superRefine((adoption, ctx) => {
    if (adoption.providerId !== adoption.stableRecordKey.providerId) {
        ctx.addIssue({
            code: "custom",
            message: 'Adoption providerId must match stable record key providerId',
            path: ['providerId'],
        });
    }
}));

export type ProviderAccountUsageAdoptionV1 = z.infer<typeof ProviderAccountUsageAdoptionV1Schema>;
