import { lazyZodSchema } from '../../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod/mini';

import { encodeBase64 } from '../../crypto/base64.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import {
  SessionFollowFrontierV1Schema,
  type SessionFollowFrontierV1,
} from './sessionFollowFrontierV1.js';

export const SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1 = 'session-follow-observe-pending-v1' as const;
export const SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1 = 'session-follow-acknowledge-v1' as const;
export const SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX = 'session-follow-wake:' as const;
export const SESSION_FOLLOW_WAKE_EVENT_MESSAGE = 'Followed context changed, so Happier woke this Agent with the update.' as const;

export function buildSessionFollowWakeEventLocalId(wakeId: string): string {
  const normalizedWakeId = wakeId.trim();
  if (normalizedWakeId.length === 0) throw new Error('Session Follow wake id must not be empty');
  return `${SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX}${normalizedWakeId}`;
}

export function isSessionFollowWakeEventLocalId(localId: unknown): localId is string {
  return typeof localId === 'string'
    && localId.startsWith(SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX)
    && localId.length > SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX.length;
}

const PublisherGenerationV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^(?:0|[1-9]\d{0,18})$/u), z.refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)));
const NonBlankStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
// SessionIdSchema is the Protocol composable schema; adapt it at this Zod
// composition boundary so discriminated unions receive a native Zod node
// while admission remains owned by the canonical SessionId schema.
const SessionIdZodSchema = asProtocolZod(SessionIdSchema);

const SESSION_FOLLOW_WAKE_EVENT_IDENTITY_DOMAIN_V1 = 'session-follow-wake-event:v1' as const;
const textEncoder = new TextEncoder();

function serializeWakeFrontier(frontier: SessionFollowFrontierV1) {
  return [
    frontier.transcriptSeq,
    frontier.readyEventSeq,
    frontier.agentStateVersion,
    frontier.turn === null ? null : [frontier.turn.id, frontier.turn.status],
  ] as const;
}

export const SessionFollowWakeObservationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: SessionIdZodSchema,
  edgeKind: z.optional(z.literal('reports_to')),
  attachedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  expected: SessionFollowFrontierV1Schema,
  consumed: SessionFollowFrontierV1Schema,
}).check(z.refine((value) => (value.edgeKind === 'reports_to') === (value.attachedAt !== undefined), {
  path: ['attachedAt'], message: 'Reports-to observations require their exact attachment identity',
})));
export type SessionFollowWakeObservationV1 = z.infer<typeof SessionFollowWakeObservationV1Schema>;

const SessionFollowWakeObservationBatchV1Schema = lazyZodSchema(() => z.array(SessionFollowWakeObservationV1Schema).check(z.minLength(1), z.superRefine((observations, context) => {
    const seenSourceSessionIds = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      const identity = `${observation.edgeKind ?? 'follow'}:${observation.sourceSessionId}`;
      if (seenSourceSessionIds.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'sourceSessionId'],
          message: 'Session Follow wake observations require unique source Sessions',
        });
      }
      seenSourceSessionIds.add(identity);
    }
  })));

/** Canonical byte-order normalization for the exact source batch represented by a wake event. */
export function normalizeSessionFollowWakeObservationsV1(
  observations: readonly SessionFollowWakeObservationV1[],
): SessionFollowWakeObservationV1[] {
  return SessionFollowWakeObservationBatchV1Schema.parse(observations).sort((left, right) => (
    left.sourceSessionId < right.sourceSessionId
      ? -1
      : left.sourceSessionId > right.sourceSessionId
        ? 1
        : (left.edgeKind ?? 'follow') < (right.edgeKind ?? 'follow') ? -1
          : (left.edgeKind ?? 'follow') > (right.edgeKind ?? 'follow') ? 1 : 0
  ));
}

/**
 * Derives the one durable event identity for a context-only wake attempt.
 * Sorting makes a retry independent of hydration completion order, while the
 * publisher fence and exact expected/consumed tuples prevent a later wake from
 * aliasing an earlier accepted frontier set.
 */
export function deriveSessionFollowWakeEventLocalIdV1(input: Readonly<{
  destinationSessionId: string;
  publisherGeneration: string;
  observations: readonly SessionFollowWakeObservationV1[];
}>): string {
  const destinationSessionId = SessionIdZodSchema.parse(input.destinationSessionId);
  const publisherGeneration = PublisherGenerationV1Schema.parse(input.publisherGeneration);
  const observations = normalizeSessionFollowWakeObservationsV1(input.observations);
  const canonicalIdentity = JSON.stringify([
    SESSION_FOLLOW_WAKE_EVENT_IDENTITY_DOMAIN_V1,
    destinationSessionId,
    publisherGeneration,
    observations.map((observation) => [
      observation.sourceSessionId,
      serializeWakeFrontier(observation.expected),
      serializeWakeFrontier(observation.consumed),
      ...(observation.edgeKind ? [observation.edgeKind, observation.attachedAt] : []),
    ]),
  ]);
  return buildSessionFollowWakeEventLocalId(
    encodeBase64(sha256(textEncoder.encode(canonicalIdentity)), 'base64url'),
  );
}

export const SessionFollowPendingObservationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
  edgeKind: z.optional(z.literal('reports_to')),
  attachedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  delivered: SessionFollowFrontierV1Schema,
  observed: SessionFollowFrontierV1Schema,
  mode: z._default(z.enum(['next_turn', 'wake_on_human_change']), 'next_turn'),
}).check(z.refine((value) => (value.edgeKind === 'reports_to') === (value.attachedAt !== undefined), {
  path: ['attachedAt'], message: 'Reports-to observations require their exact attachment identity',
})));
export type SessionFollowPendingObservationV1 = z.infer<typeof SessionFollowPendingObservationV1Schema>;

export const SessionFollowObservePendingRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: SessionIdZodSchema,
  includeReportsTo: z.optional(z.boolean()),
}));
export type SessionFollowObservePendingRequestV1 = z.infer<typeof SessionFollowObservePendingRequestV1Schema>;

export const SessionFollowObservePendingResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    sessionId: SessionIdZodSchema,
    publisherGeneration: PublisherGenerationV1Schema,
    currentSourceSessionIds: z.array(SessionIdZodSchema),
    observations: z.array(SessionFollowPendingObservationV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum(['invalid_request', 'forbidden', 'unsupported', 'internal']),
  }),
]));
export type SessionFollowObservePendingResponseV1 = z.infer<typeof SessionFollowObservePendingResponseV1Schema>;

export const SessionFollowAcknowledgeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  destinationSessionId: SessionIdZodSchema,
  sourceSessionId: SessionIdZodSchema,
  edgeKind: z.optional(z.literal('reports_to')),
  attachedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  expectedPublisherGeneration: PublisherGenerationV1Schema,
  expected: SessionFollowFrontierV1Schema,
  observed: SessionFollowFrontierV1Schema,
  consumed: SessionFollowFrontierV1Schema,
  acceptance: z.union([
    z.strictObject({
      kind: z.literal('admitted_input'),
      localInputId: NonBlankStringSchema,
      userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
    z.strictObject({
      kind: z.literal('context_only_wake'),
      eventLocalId: NonBlankStringSchema.check(z.refine(isSessionFollowWakeEventLocalId, {
        message: 'Expected a canonical Session Follow wake event id',
      })),
      observations: SessionFollowWakeObservationBatchV1Schema,
    }),
  ]),
}).check(z.superRefine((value, context) => {
  if ((value.edgeKind === 'reports_to') !== (value.attachedAt !== undefined)) {
    context.addIssue({ code: 'custom', path: ['attachedAt'], message: 'Reports-to ACK requires the exact attachment timestamp' });
  }
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
})));
export type SessionFollowAcknowledgeRequestV1 = z.infer<typeof SessionFollowAcknowledgeRequestV1Schema>;

export const SessionFollowAcknowledgeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    destinationSessionId: SessionIdZodSchema,
    sourceSessionId: SessionIdZodSchema,
    delivered: SessionFollowFrontierV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum([
      'invalid_request',
      'forbidden',
      'edge_not_found',
      'session_archived',
      'stale_publisher_generation',
      'stale_expected_frontier',
      'stale_terminal_turn',
      'invalid_consumed_frontier',
      'provider_acceptance_unverified',
      'source_forbidden',
      'unsupported',
      'internal',
    ]),
  }),
]));
export type SessionFollowAcknowledgeResponseV1 = z.infer<typeof SessionFollowAcknowledgeResponseV1Schema>;
