// Captured from ../0.2 at 37a6541578749067b49d4579be8c752c9591b8c8.
// actionOperationV1.ts and sessionFork.ts were clean at inspection. This is
// the actual predecessor snapshot parser; only its enum import is inlined.
import { z } from 'zod/mini';

const SessionForkStrategySchema = z.enum(['auto', 'native', 'provider_native', 'acp_fork_latest', 'replay']);

const ACTION_OPERATION_ID_MAX_LENGTH = 2_000;
const ACTION_OPERATION_PHASE_MAX_LENGTH = 200;
const ACTION_OPERATION_LABEL_MAX_LENGTH = 1_000;
const ACTION_OPERATION_TITLE_MAX_LENGTH = 10_000;
const ACTION_OPERATION_ERROR_CODE_MAX_LENGTH = 200;
const ACTION_OPERATION_ERROR_MAX_LENGTH = 10_000;

export const ACTION_OPERATION_RPC_METHODS_V1 = Object.freeze({
  list: 'actionOperation.list.v1',
  get: 'actionOperation.get.v1',
  cancel: 'actionOperation.cancel.v1',
} as const);

const ActionOperationIdentifierSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ID_MAX_LENGTH));
const ActionOperationTimestampSchema = z.number().check(z.int(), z.nonnegative());

export const ActionOperationStateV1Schema = z.enum([
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type ActionOperationStateV1 = z.infer<typeof ActionOperationStateV1Schema>;

const ActionOperationProgressLabelSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_LABEL_MAX_LENGTH));

export const ActionOperationProgressV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('indeterminate'),
    label: z.optional(ActionOperationProgressLabelSchema),
  }),
  z.strictObject({
    kind: z.literal('phase'),
    phase: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PHASE_MAX_LENGTH)),
    label: ActionOperationProgressLabelSchema,
  }),
  z.strictObject({
    kind: z.literal('determinate'),
    current: z.number().check(z.nonnegative()),
    total: z.number().check(z.positive()),
    label: z.optional(ActionOperationProgressLabelSchema),
  }).check(z.refine((progress) => progress.current <= progress.total, {
    message: 'current must not exceed total',
    path: ['current'],
  })),
]);
export type ActionOperationProgressV1 = z.infer<typeof ActionOperationProgressV1Schema>;

/** Redacted Action executor failure projection safe for public operation UI. */
export const ActionOperationFailureV1Schema = z.strictObject({
  errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH)),
  error: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ERROR_MAX_LENGTH)),
});
export type ActionOperationFailureV1 = z.infer<typeof ActionOperationFailureV1Schema>;

export const ActionOperationScopeV1Schema = z.strictObject({
  accountId: ActionOperationIdentifierSchema,
  machineId: ActionOperationIdentifierSchema,
  sessionId: z.optional(ActionOperationIdentifierSchema),
});
export type ActionOperationScopeV1 = z.infer<typeof ActionOperationScopeV1Schema>;

export const ActionOperationDomainRefV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('forkRequest'),
    id: ActionOperationIdentifierSchema,
    strategy: z.optional(SessionForkStrategySchema),
  }),
  z.strictObject({ kind: z.literal('spawnAttempt'), id: ActionOperationIdentifierSchema }),
  z.strictObject({
    kind: z.literal('handoff'),
    id: ActionOperationIdentifierSchema,
    targetMachineId: z.optional(ActionOperationIdentifierSchema),
  }),
]);
export type ActionOperationDomainRefV1 = z.infer<typeof ActionOperationDomainRefV1Schema>;

const ActionOperationSnapshotV1BaseSchema = z.strictObject({
  version: z.literal(1),
  operationId: ActionOperationIdentifierSchema,
  requestId: z.optional(ActionOperationIdentifierSchema),
  revision: z.number().check(z.int(), z.minimum(1)),
  actionId: ActionOperationIdentifierSchema,
  state: ActionOperationStateV1Schema,
  scope: ActionOperationScopeV1Schema,
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_TITLE_MAX_LENGTH)),
  createdAt: ActionOperationTimestampSchema,
  startedAt: z.optional(ActionOperationTimestampSchema),
  settledAt: z.optional(ActionOperationTimestampSchema),
  progress: z.optional(ActionOperationProgressV1Schema),
  result: z.optional(z.unknown()),
  error: z.optional(ActionOperationFailureV1Schema),
  domainRef: z.optional(ActionOperationDomainRefV1Schema),
  cancellation: z.enum(['unsupported', 'supported']),
});

export const ActionOperationSnapshotV1Schema = ActionOperationSnapshotV1BaseSchema.check(z.superRefine((snapshot, ctx) => {
  const hasResult = Object.prototype.hasOwnProperty.call(snapshot, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(snapshot, 'error');

  if (snapshot.startedAt !== undefined && snapshot.startedAt < snapshot.createdAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['startedAt'],
      message: 'startedAt must not precede createdAt',
    });
  }
  if (snapshot.settledAt !== undefined) {
    if (snapshot.startedAt === undefined || snapshot.settledAt < snapshot.startedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['settledAt'],
        message: 'settledAt requires and must not precede startedAt',
      });
    }
  }

  if (snapshot.state === 'accepted') {
    if (snapshot.startedAt !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['startedAt'], message: 'accepted operations have not started' });
    }
    if (snapshot.settledAt !== undefined || hasResult || hasError) {
      ctx.addIssue({ code: 'custom', path: ['state'], message: 'accepted operations cannot have terminal fields' });
    }
    return;
  }

  if (snapshot.startedAt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt is required after acceptance' });
  }

  if (snapshot.state === 'running') {
    if (snapshot.settledAt !== undefined || hasResult || hasError) {
      ctx.addIssue({ code: 'custom', path: ['state'], message: 'running operations cannot have terminal fields' });
    }
    return;
  }

  if (snapshot.settledAt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['settledAt'], message: 'terminal operations require settledAt' });
  }

  if (snapshot.state === 'succeeded') {
    if (hasError) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'succeeded operations cannot have an error' });
    }
    return;
  }

  if (snapshot.state === 'failed') {
    if (!hasError) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'failed operations require an error' });
    }
    if (hasResult) {
      ctx.addIssue({ code: 'custom', path: ['result'], message: 'failed operations cannot have a result' });
    }
    return;
  }

  if (hasResult || hasError) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'cancelled operations cannot have result or error fields' });
  }
}));
export type ActionOperationSnapshotV1 = z.infer<typeof ActionOperationSnapshotV1Schema>;


export const ActionOperationListV1ResponseSchema = z.strictObject({
  items: z.array(ActionOperationSnapshotV1Schema),
  nextCursor: z.nullable(ActionOperationIdentifierSchema),
});
export const ActionOperationGetV1ResponseSchema = z.union([
  z.strictObject({ kind: z.literal('found'), operation: ActionOperationSnapshotV1Schema }),
  z.strictObject({ kind: z.literal('not_found') }),
]);
