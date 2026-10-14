import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { TurnIdSchema } from './idsV1.js';

export const SessionUserActionRequiredRequestKindV1Schema = lazyZodSchema(() => z.enum([
  'permission',
  'user_action',
]));
export type SessionUserActionRequiredRequestKindV1 = z.infer<
  typeof SessionUserActionRequiredRequestKindV1Schema
>;

/** Content-free identity for one newly pending main-turn request. */
export const SessionUserActionRequiredOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  sourceTurnId: TurnIdSchema,
  requestKind: SessionUserActionRequiredRequestKindV1Schema,
  occurredAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionUserActionRequiredOccurrenceV1 = z.infer<
  typeof SessionUserActionRequiredOccurrenceV1Schema
>;
