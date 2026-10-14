import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { z } from 'zod/mini';

import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SessionTurnV1Schema } from '../turns/sessionTurnV1.js';
import {
  ContentProvenanceV1Schema,
  ExternalActorV1Schema,
  SessionInputAdmissionReceiptV1Schema,
  SessionInputSourceAuthorityV1Schema,
  SessionRoleUserProducerKindV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';

const MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS = 50_000;

/** The approved semantic-page budget; the server reads one extra row as lookahead. */
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 = 100;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 = 2 * 1024 * 1024;

/**
 * The same 2 MiB budget applies to the whole route response, including its
 * transaction witness. Server selection uses this helper on its response
 * envelope; Protocol schemas use it on the projection and witness shapes.
 */
export function isExternalShareableTranscriptWirePayloadWithinLimitV1(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      && new TextEncoder().encode(serialized).byteLength <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1;
  } catch {
    return false;
  }
}

const ExternalShareableTextV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => Array.from(value).length <= MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS, `External transcript text must contain at most ${MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS} Unicode code points`)));

const ExternalShareableSourceAuthorityV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.pick(SessionInputSourceAuthorityV1Schema, {
  mediatorPluginId: true,
  sourceRef: true,
  sourceRevisionOrEpoch: true,
})));

export const ExternalShareableActorV1Schema = lazyZodSchema(() => z.enum(['owner', 'collaborator', 'machine']));
export type ExternalShareableActorV1 = z.infer<typeof ExternalShareableActorV1Schema>;

/**
 * Maps the server-only admission receipt to the one coarse fact that may
 * cross the external transcript boundary. Account identity and the exact
 * shared role remain receipt-local.
 */
export function deriveExternalShareableActorFromAdmissionReceiptV1(
  inputAdmissionReceipt: unknown,
  mode: 'input' | 'stored' = 'input',
): ExternalShareableActorV1 | null {
  const receipt = (mode === 'stored' ? createStoredReadSchema(SessionInputAdmissionReceiptV1Schema)
    : SessionInputAdmissionReceiptV1Schema).safeParse(inputAdmissionReceipt);
  if (!receipt.success) return null;
  if (receipt.data.issuer === 'authenticatedMachine') return 'machine';
  return receipt.data.sessionRelationship === 'owner' ? 'owner' : 'collaborator';
}

export const ExternalShareableOriginV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  actor: ExternalShareableActorV1Schema,
  sourceAuthority: z.optional(ExternalShareableSourceAuthorityV1Schema),
  externalActor: z.optional(ExternalActorV1Schema),
  contentProvenance: z.optional(ContentProvenanceV1Schema),
}).check(z.superRefine((value, context) => {
  if ((value.externalActor === undefined) === (value.contentProvenance === undefined)) return;
  context.addIssue({
    code: "custom",
    path: value.externalActor === undefined ? ['externalActor'] : ['contentProvenance'],
    message: 'External actor and content provenance must be supplied together',
  });
})));
export type ExternalShareableOriginV1 = z.infer<typeof ExternalShareableOriginV1Schema>;

const ExternalShareableConsumedInputV1Schema = lazyZodSchema(() => z.strictObject({
  localId: z.string().check(z.minLength(1)),
  origin: ExternalShareableOriginV1Schema,
}));

export const ExternalShareableTranscriptItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('userText'),
    sessionId: z.string().check(z.minLength(1)),
    seq: z.number().check(z.int(), z.nonnegative()),
    itemId: z.string().check(z.minLength(1)),
    localId: z.string().check(z.minLength(1)),
    text: ExternalShareableTextV1Schema,
    origin: ExternalShareableOriginV1Schema,
  }),
  z.strictObject({
    kind: z.literal('assistantText'),
    sessionId: z.string().check(z.minLength(1)),
    seq: z.number().check(z.int(), z.nonnegative()),
    itemId: z.string().check(z.minLength(1)),
    turnId: z.string().check(z.minLength(1)),
    final: z.literal('completed'),
    text: ExternalShareableTextV1Schema,
    consumedInputs: z.readonly(z.array(ExternalShareableConsumedInputV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1))),
  }),
]));
export type ExternalShareableTranscriptItemV1 = z.infer<typeof ExternalShareableTranscriptItemV1Schema>;

export const ExternalShareableTranscriptPageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.readonly(z.array(ExternalShareableTranscriptItemV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1))),
  nextCursor: z.optional(z.string().check(z.minLength(1))),
  scannedThroughSeq: z.number().check(z.int(), z.nonnegative()),
  hasMore: z.boolean(),
}).check(z.superRefine((page, context) => {
  const consumedInputCount = page.items.reduce(
    (total, item) => total + (item.kind === 'assistantText' ? item.consumedInputs.length : 0),
    0,
  );
  if (consumedInputCount > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1) {
    context.addIssue({
      code: "custom",
      message: `External transcript page contains more than ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1} consumed inputs`,
    });
  }
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(page)) {
    context.addIssue({
      code: "custom",
      message: `External transcript page exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
})));
export type ExternalShareableTranscriptPageV1 = z.infer<typeof ExternalShareableTranscriptPageV1Schema>;

const ExternalShareableReferencedUserRowV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  seq: z.number().check(z.int(), z.nonnegative()),
  localId: z.string().check(z.minLength(1)),
  messageRole: z.literal('user'),
  content: SessionStoredMessageContentSchema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  externalShareableActor: z.optional(ExternalShareableActorV1Schema),
}));

/**
 * One database-transaction witness for an external transcript page. Its turns
 * are already publication-visible; the optional barriers mark the earliest
 * row that must not advance a cursor until publication or turn settlement is
 * visible. Referenced user rows are the exact, least-disclosure inputs needed
 * to project a final assistant row from the same transaction.
 */
export const ExternalShareableTranscriptSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  turns: z.readonly(z.array(SessionTurnV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1))),
  publicationBlockedFromSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  turnSettlementBlockedFromSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  referencedUserRows: z.optional(z.readonly(z.array(ExternalShareableReferencedUserRowV1Schema).check(z.maxLength(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1)))),
}).check(z.superRefine((snapshot, context) => {
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(snapshot)) {
    context.addIssue({
      code: "custom",
      message: `External transcript snapshot exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
})));
export type ExternalShareableTranscriptSnapshotV1 = z.infer<
  typeof ExternalShareableTranscriptSnapshotV1Schema
>;

export function filterExternalShareableOriginForCallerV1(params: Readonly<{
  origin: ExternalShareableOriginV1;
  callerPluginId?: string | null;
}>): ExternalShareableOriginV1 {
  const origin = ExternalShareableOriginV1Schema.parse(params.origin);
  if (
    !origin.sourceAuthority
    || !params.callerPluginId
    || !PluginIdSchema.safeParse(params.callerPluginId).success
    || origin.sourceAuthority.mediatorPluginId !== params.callerPluginId
  ) {
    const { sourceAuthority: _sourceAuthority, ...leastDisclosure } = origin;
    return leastDisclosure;
  }
  return origin;
}
