import { z } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

import type { AgentSurfaceAvailabilityV1 } from '@happier-dev/protocol';

import type { MaybePromise } from '../engine/contracts.js';
import type {
  AgentSurfaceDiagnosticV1,
  AgentSurfaceOperationReceiptV1,
} from './primitives.js';

export type CheckpointRestoreScopeV1 =
  | 'conversation'
  | 'workspace';

export type CheckpointTimingV1 =
  | 'idle'
  | 'activeTurn';

export type CheckpointRestoreAnchorEvidenceV1 = Readonly<{
  turnId?: string;
  messageSeq?: number;
  seqRange?: Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
  }>;
}>;

export type CheckpointRestoreAnchorV1 = Readonly<{
  kind: 'before_user_message';
  messageId: string;
  evidence?: CheckpointRestoreAnchorEvidenceV1;
}>;

export type CheckpointProviderTargetRefV1 =
  | Readonly<{ kind: 'provider_checkpoint'; checkpointId: string }>
  | Readonly<{ kind: 'provider_message'; messageId: string }>
  | Readonly<{ kind: 'provider_turn'; turnId: string }>
  | Readonly<{ kind: 'provider_restore_token'; token: string }>;

export type CheckpointDescriptorV1 = Readonly<{
  id: string;
  target: CheckpointProviderTargetRefV1;
  createdAt?: string;
  label?: string;
  timing: CheckpointTimingV1;
  checkpointScopes: readonly CheckpointRestoreScopeV1[];
  checkpointCombinations?: readonly (readonly CheckpointRestoreScopeV1[])[];
  restoreScopes: readonly CheckpointRestoreScopeV1[];
  restoreCombinations?: readonly (readonly CheckpointRestoreScopeV1[])[];
  partialRestore?: 'unsupported' | 'supported';
}>;

export type CheckpointAvailabilityOperationV1 =
  | 'list'
  | 'resolveRestoreTarget'
  | 'checkpoint'
  | 'restore';

export type CheckpointAvailabilityRequestV1 = Readonly<{
  operation: CheckpointAvailabilityOperationV1;
  sessionId: string;
  anchor?: CheckpointRestoreAnchorV1;
  target?: CheckpointProviderTargetRefV1;
  scopes?: readonly CheckpointRestoreScopeV1[];
  timing?: CheckpointTimingV1;
}>;

export type ListCheckpointsRequestV1 = Readonly<{
  sessionId: string;
  timing?: CheckpointTimingV1;
}>;

export type ResolveCheckpointRestoreTargetRequestV1 = Readonly<{
  sessionId: string;
  anchor: CheckpointRestoreAnchorV1;
  scopes: readonly CheckpointRestoreScopeV1[];
}>;

export type CreateCheckpointRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  scopes: readonly CheckpointRestoreScopeV1[];
  timing: CheckpointTimingV1;
  label?: string;
  signal?: AbortSignal;
}>;

export type RestoreCheckpointByAnchorRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  anchor: CheckpointRestoreAnchorV1;
  target?: never;
  scopes: readonly CheckpointRestoreScopeV1[];
  signal?: AbortSignal;
}>;

export type RestoreCheckpointByTargetRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  anchor?: never;
  target: CheckpointProviderTargetRefV1;
  scopes: readonly CheckpointRestoreScopeV1[];
  signal?: AbortSignal;
}>;

export type RestoreCheckpointRequestV1 =
  | RestoreCheckpointByAnchorRequestV1
  | RestoreCheckpointByTargetRequestV1;

export type RestoreCheckpointFailureCodeV1 =
  | 'checkpoint_not_found'
  | 'restore_target_stale'
  | 'scope_not_supported'
  | 'restore_failed';

export type RestoreCheckpointResultV1 =
  | Readonly<{
      ok: true;
      outcome: 'completed' | 'partial';
      restoredScopes: readonly CheckpointRestoreScopeV1[];
      failedScopes?: readonly Readonly<{
        scope: CheckpointRestoreScopeV1;
        code: RestoreCheckpointFailureCodeV1;
        message?: string;
      }>[];
      receipt?: AgentSurfaceOperationReceiptV1;
      diagnostics?: readonly AgentSurfaceDiagnosticV1[];
    }>
  | Readonly<{
      ok: false;
      code: RestoreCheckpointFailureCodeV1;
      message?: string;
      retryable?: boolean;
      receipt?: AgentSurfaceOperationReceiptV1;
      diagnostics?: readonly AgentSurfaceDiagnosticV1[];
    }>;

export type CheckpointSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: CheckpointAvailabilityRequestV1) => MaybePromise<AgentSurfaceAvailabilityV1>;
  list?: (request: ListCheckpointsRequestV1) => MaybePromise<readonly CheckpointDescriptorV1[]>;
  resolveRestoreTarget?: (request: ResolveCheckpointRestoreTargetRequestV1) => MaybePromise<CheckpointProviderTargetRefV1 | null>;
  checkpoint?: (request: CreateCheckpointRequestV1) => MaybePromise<CheckpointDescriptorV1>;
  restore?: (request: RestoreCheckpointRequestV1) => MaybePromise<RestoreCheckpointResultV1>;
}>;

const NonEmptyStringSchema = z.string().check(z.trim(), z.minLength(1));
const CheckpointRestoreScopeV1Schema = z.enum(['conversation', 'workspace']);
const CheckpointTimingV1Schema = z.enum(['idle', 'activeTurn']);

const AbortSignalLikeSchema = z.custom<AbortSignal>((value) => {
  if (value === undefined) {
    return true;
  }
  return !!value
    && typeof value === 'object'
    && 'aborted' in value
    && typeof (value as { aborted?: unknown }).aborted === 'boolean';
});

export const CheckpointRestoreAnchorEvidenceV1Schema = z.strictObject({
  turnId: z.optional(NonEmptyStringSchema),
  messageSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  seqRange: z.optional(z.readonly(z.strictObject({
    startSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    endSeqInclusive: z.number().check(z.int(), z.nonnegative()),
  }))),
});

export const CheckpointRestoreAnchorV1Schema = z.strictObject({
  kind: z.literal('before_user_message'),
  messageId: NonEmptyStringSchema,
  evidence: z.optional(CheckpointRestoreAnchorEvidenceV1Schema),
});

export const CheckpointProviderTargetRefV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider_checkpoint'),
    checkpointId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_message'),
    messageId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_turn'),
    turnId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_restore_token'),
    token: NonEmptyStringSchema,
  }),
]);

const CheckpointScopesSchema = z.readonly(z.array(CheckpointRestoreScopeV1Schema).check(z.minLength(1), z.superRefine((scopes, ctx) => {
  const seen = new Set<CheckpointRestoreScopeV1>();
  scopes.forEach((scope, index) => {
    if (seen.has(scope)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint scope selections must not contain duplicates',
        path: [index],
      });
      return;
    }
    seen.add(scope);
  });
})));

export const CheckpointAvailabilityRequestV1Schema = z.strictObject({
  operation: z.enum(['list', 'resolveRestoreTarget', 'checkpoint', 'restore']),
  sessionId: NonEmptyStringSchema,
  anchor: z.optional(CheckpointRestoreAnchorV1Schema),
  target: z.optional(CheckpointProviderTargetRefV1Schema),
  scopes: z.optional(CheckpointScopesSchema),
  timing: z.optional(CheckpointTimingV1Schema),
}).check(z.superRefine((request, ctx) => {
  if (request.operation === 'resolveRestoreTarget' && !request.anchor) {
    ctx.addIssue({
      code: 'custom',
      message: 'CheckpointAvailabilityRequestV1 resolveRestoreTarget requires anchor',
      path: ['anchor'],
    });
  }
  if (request.operation === 'restore') {
    const semanticSources = Number(request.anchor !== undefined) + Number(request.target !== undefined);
    if (semanticSources !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'CheckpointAvailabilityRequestV1 restore requires exactly one of anchor or target',
        path: ['anchor'],
      });
    }
  }
}));

export const ResolveCheckpointRestoreTargetRequestV1Schema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema,
  scopes: CheckpointScopesSchema,
});

export const CreateCheckpointRequestV1Schema = z.strictObject({
  operationId: z.optional(NonEmptyStringSchema),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  timing: CheckpointTimingV1Schema,
  label: z.optional(NonEmptyStringSchema),
  signal: z.optional(AbortSignalLikeSchema),
});

export const RestoreCheckpointRequestV1Schema = z.strictObject({
  operationId: z.optional(NonEmptyStringSchema),
  sessionId: NonEmptyStringSchema,
  anchor: z.optional(CheckpointRestoreAnchorV1Schema),
  target: z.optional(CheckpointProviderTargetRefV1Schema),
  scopes: CheckpointScopesSchema,
  signal: z.optional(AbortSignalLikeSchema),
}).check(z.superRefine((request, ctx) => {
  const semanticSources = Number(request.anchor !== undefined) + Number(request.target !== undefined);
  if (semanticSources !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'RestoreCheckpointRequestV1 must provide exactly one of anchor or target',
      path: ['anchor'],
    });
  }
}));

function formatCheckpointSchemaIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function parseCheckpointRequest<T>(params: Readonly<{
  label: string;
  schema: z.ZodMiniType<T>;
  input: unknown;
}>): T {
  const parsed = params.schema.safeParse(params.input, { error: en().localeError });
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`${params.label} is invalid: ${formatCheckpointSchemaIssues(parsed.error.issues)}`);
}

export function parseCheckpointAvailabilityRequestV1(input: unknown): CheckpointAvailabilityRequestV1 {
  return parseCheckpointRequest({
    label: 'CheckpointAvailabilityRequestV1',
    schema: CheckpointAvailabilityRequestV1Schema,
    input,
  });
}

export function parseResolveCheckpointRestoreTargetRequestV1(
  input: unknown,
): ResolveCheckpointRestoreTargetRequestV1 {
  return parseCheckpointRequest({
    label: 'ResolveCheckpointRestoreTargetRequestV1',
    schema: ResolveCheckpointRestoreTargetRequestV1Schema,
    input,
  });
}

export function parseCreateCheckpointRequestV1(input: unknown): CreateCheckpointRequestV1 {
  return parseCheckpointRequest({
    label: 'CreateCheckpointRequestV1',
    schema: CreateCheckpointRequestV1Schema,
    input,
  });
}

export function parseRestoreCheckpointRequestV1(input: unknown): RestoreCheckpointRequestV1 {
  return parseCheckpointRequest({
    label: 'RestoreCheckpointRequestV1',
    schema: RestoreCheckpointRequestV1Schema as z.ZodMiniType<RestoreCheckpointRequestV1>,
    input,
  });
}
