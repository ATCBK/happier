import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AnyClientUpgradeRequiredV1Schema } from '../../clientCompatibility/upgradeRequiredV1.js';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { V2SessionByIdResponseSchema } from '../control/contract.js';
import { SessionMessagesPageV1Schema } from '../messages/sessionMessagesPageV1.js';
import { SessionTurnsProjectionV1Schema } from '../turns/sessionTurnV1.js';

/** The application HTTP body limit owns request size; there is no competing id cap. */
export const SessionReadBatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionIds: z.array(z.string().check(z.minLength(1))),
  accessProjectionVersion: z.optional(z.literal(1)),
  includeSnapshot: z._default(z.boolean(), true),
  includeMessages: z._default(z.boolean(), false),
}).check(z.refine(value => value.includeSnapshot || value.includeMessages, {
  message: 'At least one Session read part is required',
})));
export type SessionReadBatchRequestV1 = z.infer<typeof SessionReadBatchRequestV1Schema>;

const SessionReadFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404),
    z.literal(409), z.literal(426), z.literal(429), z.literal(500), z.literal(503)]),
  body: z.union([
    z.strictObject({ error: z.string(), code: z.optional(z.string()) }),
    AnyClientUpgradeRequiredV1Schema,
    OperationUpdateRequiredV1Schema,
  ]),
}));

export const SessionReadBatchDetailV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: V2SessionByIdResponseSchema }),
  SessionReadFailureV1Schema,
]));
export const SessionReadBatchTurnsV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: SessionTurnsProjectionV1Schema }),
  SessionReadFailureV1Schema,
]));
export const SessionReadBatchMessagesV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: SessionMessagesPageV1Schema }),
  SessionReadFailureV1Schema,
]));

/** Components retain single-read admission failures; clients open their normal envelopes. */
export const SessionReadBatchResultV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  detail: z.optional(SessionReadBatchDetailV1Schema),
  turns: z.optional(SessionReadBatchTurnsV1Schema),
  messages: z.optional(SessionReadBatchMessagesV1Schema),
}));
export const SessionReadBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
  results: z.array(SessionReadBatchResultV1Schema),
}));
export type SessionReadBatchResponseV1 = z.infer<typeof SessionReadBatchResponseV1Schema>;
export type SessionReadBatchResultV1 = SessionReadBatchResponseV1['results'][number];
