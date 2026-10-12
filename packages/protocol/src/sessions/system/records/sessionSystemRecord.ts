import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { SessionSystemRecordAddressSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';
import { SessionIdSchema } from '../../idsV1.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';

/** Server-proved creation attribution, independent of caller-authored content. */
export const SessionSystemRecordCreatorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }).strict(),
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('plugin') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]));
export type SessionSystemRecordCreatorV1 = z.infer<typeof SessionSystemRecordCreatorV1Schema>;

export const SessionSystemRecordSchema = lazyZodSchema(() => z
  .object({
    id: z.string().trim().min(1),
    address: SessionSystemRecordAddressSchema,
    content: StrictJsonValueSchema,
    /** Historical records and supported older servers may omit this fact. */
    creator: SessionSystemRecordCreatorV1Schema.optional(),
    revision: SessionSystemRecordRevisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict());
export type SessionSystemRecord = z.infer<typeof SessionSystemRecordSchema>;
