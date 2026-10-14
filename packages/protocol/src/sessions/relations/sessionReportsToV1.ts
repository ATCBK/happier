import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionFollowSourceKeyPreparationResultV1Schema, type SessionFollowSourceKeyPreparationResultV1 } from '../follow/sessionFollowSourceKeyPreparationV1.js';

const SessionIdV1Schema = asProtocolZod(SessionIdSchema);

/** V1 identity and mutation envelopes are closed; relation membership grants no rights. */
export const SessionReportsToV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: SessionIdV1Schema }));
export type SessionReportsToV1 = z.infer<typeof SessionReportsToV1Schema>;

export const SessionReportsV1Schema = lazyZodSchema(() => z.strictObject({
  total: z.number().check(z.int(), z.nonnegative()),
  working: z.number().check(z.int(), z.nonnegative()),
  needsYou: z.number().check(z.int(), z.nonnegative()),
  stalled: z.number().check(z.int(), z.nonnegative()),
}));
export type SessionReportsV1 = z.infer<typeof SessionReportsV1Schema>;

export const SessionReportsToSetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  leadSessionId: zMini.nullable(SessionIdV1Schema),
  expectedLeadSessionId: zMini.nullable(SessionIdV1Schema),
}));
export type SessionReportsToSetRequestV1 = z.infer<typeof SessionReportsToSetRequestV1Schema>;

export const SessionReportsToSetActionInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionReportsToSetRequestV1Schema, {
  sessionId: SessionIdV1Schema,
})));
export type SessionReportsToSetActionInputV1 = z.infer<typeof SessionReportsToSetActionInputV1Schema>;

export const SessionReportsToSetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true), sessionId: SessionIdV1Schema,
    leadSessionId: zMini.nullable(SessionIdV1Schema),
    attachedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    sourceKeyPreparation: zMini.optional(SessionFollowSourceKeyPreparationResultV1Schema),
  }),
  z.strictObject({ ok: z.literal(false), error: z.literal('reports_to_cycle') }),
  z.strictObject({ ok: z.literal(false), error: z.literal('reports_to_cas_conflict') }),
  z.strictObject({
    ok: z.literal(false), error: z.literal('reports_to_forbidden'),
    reason: z.enum(['read', 'input', 'pairwise']),
  }),
]));
export type SessionReportsToSetResultV1 = z.infer<typeof SessionReportsToSetResultV1Schema>;

/** Key readiness is retryable delivery state, never a refusal of an already committed relation. */
export function projectSessionReportsToSourceKeyPreparationV1(
  committed: Extract<SessionReportsToSetResultV1, Readonly<{ ok: true }>>,
  preparation: SessionFollowSourceKeyPreparationResultV1,
): Extract<SessionReportsToSetResultV1, Readonly<{ ok: true }>> {
  return preparation.kind === 'waiting' ? { ...committed, sourceKeyPreparation: preparation } : committed;
}

/** Read-only, request-scoped admission evidence; it never grants write authority. */
export const SessionReportsToOptionsRequestV1Schema = lazyZodSchema(() => z.strictObject({
  candidateSessionIds: z.array(SessionIdV1Schema),
}));
export const SessionReportsToEligibilityV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ sessionId: SessionIdV1Schema, allowed: z.literal(true) }),
  z.strictObject({ sessionId: SessionIdV1Schema, allowed: z.literal(false), reason: z.enum(['read', 'input', 'pairwise', 'cycle']) }),
]));
export const SessionReportsToOptionsV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionIdV1Schema,
  currentLeadSessionId: zMini.nullable(SessionIdV1Schema),
  candidates: z.array(SessionReportsToEligibilityV1Schema),
}));
export type SessionReportsToOptionsV1 = z.infer<typeof SessionReportsToOptionsV1Schema>;
