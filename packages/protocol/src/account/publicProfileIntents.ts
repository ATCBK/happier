import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema } from '../inputs/usageQuery.js';
import { ScmCredentialFreeRepositorySelectorV1Schema } from '../scm/repositoryClone.js';
import { PublicProfileMetadataV1Schema, PublicProfilePolicyV1Schema } from './publicProfile.js';
import { PublicProfilePublishBodyV1Schema, PublicProfileUpdateBodyV1Schema,
  PublicProfileViewV1Schema, PublicProfileOwnerRecordV1Schema, PublicProfileUnavailableReasonV1Schema } from './publicProfilePublication.js';

/** Repository publicity is observed by the host, never asserted in an Action input. */
export const PublicProfileMetadataSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(PublicProfileMetadataV1Schema, { projects: true }).shape,
  projectSelections: z.optional(z.array(ScmCredentialFreeRepositorySelectorV1Schema)),
}));
export type PublicProfileMetadataSelectionV1 = z.infer<typeof PublicProfileMetadataSelectionV1Schema>;

export const PublicProfilePreviewIntentV1Schema = lazyZodSchema(() => z.strictObject({
  policy: PublicProfilePolicyV1Schema,
  metadataSelection: PublicProfileMetadataSelectionV1Schema,
  query: UsageQuerySchema,
  layout: PublicProfilePublishBodyV1Schema.shape.layout,
  appearance: PublicProfilePublishBodyV1Schema.shape.appearance,
}));
export type PublicProfilePreviewIntentV1 = z.infer<typeof PublicProfilePreviewIntentV1Schema>;
export const PublicProfilePublishIntentV1Schema = lazyZodSchema(() => z.strictObject({
  ...PublicProfilePreviewIntentV1Schema.shape, intent: z.literal('publish'),
}));
export type PublicProfilePublishIntentV1 = z.infer<typeof PublicProfilePublishIntentV1Schema>;
export const PublicProfileUpdateIntentV1Schema = lazyZodSchema(() => z.strictObject({
  policy: z.optional(PublicProfilePolicyV1Schema),
  metadataSelection: z.optional(PublicProfileMetadataSelectionV1Schema),
  query: z.optional(UsageQuerySchema),
  layout: PublicProfileUpdateBodyV1Schema.shape.layout,
  appearance: PublicProfileUpdateBodyV1Schema.shape.appearance,
}).check(z.refine(value => Object.values(value).some(member => member !== undefined))));
export type PublicProfileUpdateIntentV1 = z.infer<typeof PublicProfileUpdateIntentV1Schema>;

export const PublicProfilePreparationUnavailableReasonV1Schema = z.enum([
  ...PublicProfileUnavailableReasonV1Schema.options, 'usage_unavailable', 'usage_query_result_invalid',
  'project_visibility_unavailable', 'preparation_unavailable',
]);
export const PublicProfilePreviewResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), view: PublicProfileViewV1Schema }),
  z.strictObject({ kind: z.literal('unavailable'), reason: PublicProfilePreparationUnavailableReasonV1Schema }),
]));
export const PublicProfileUpdateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('updated'), record: z.nullable(PublicProfileOwnerRecordV1Schema),
    refresh: z.enum(['not_needed', 'complete', 'unavailable', 'pending_approval', 'failed']),
    refreshReason: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ kind: z.literal('unavailable'), reason: PublicProfilePreparationUnavailableReasonV1Schema }),
]));
