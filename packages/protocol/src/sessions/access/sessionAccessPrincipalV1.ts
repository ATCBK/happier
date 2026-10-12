import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { AccountDisplayProfileV1BaseSchema, readAccountNameFromLegacyProfileV1 } from '../../account/accountDisplayProfileV1.js';

/** An authorized Session projection's neutral Account identity, never a social profile. */
export const SessionAccessAccountSummaryV1Schema = lazyZodSchema(() => AccountDisplayProfileV1BaseSchema.extend({
  kind: z.literal('account'),
  accountId: z.string().min(1),
}).strict().transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) })));
export type SessionAccessAccountSummaryV1 = z.infer<typeof SessionAccessAccountSummaryV1Schema>;
