import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { SessionSystemRecordAddressSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';
import { SessionIdSchema } from '../../idsV1.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';

/** Server-proved creation attribution, independent of caller-authored content. */
export const SessionSystemRecordCreatorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }),
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('plugin') }),
  z.strictObject({ kind: z.literal('unknown') }),
]));
export type SessionSystemRecordCreatorV1 = z.infer<typeof SessionSystemRecordCreatorV1Schema>;

export const SessionSystemRecordSchema = lazyZodSchema(() => z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    address: SessionSystemRecordAddressSchema,
    content: StrictJsonValueSchema,
    /** Historical records and supported older servers may omit this fact. */
    creator: z.optional(SessionSystemRecordCreatorV1Schema),
    revision: SessionSystemRecordRevisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }));
export type SessionSystemRecord = z.infer<typeof SessionSystemRecordSchema>;
