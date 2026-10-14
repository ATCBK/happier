import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
} from '../../../connect/connectedServiceSchemas.js';
import { ConnectedAccountServiceKeyIngressSchema } from '../../../connect/connectedServiceBindings.js';

export const SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID = 'runtime.usageLimitRecovery' as const;
export const SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY = 'sessionUsageLimitRecoveryV1' as const;

const SessionUsageLimitRecoveryNativeAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('native'),
    serviceId: z.optional(z.nullable(ConnectedAccountServiceKeyIngressSchema)),
  }));

const SessionUsageLimitRecoveryProfileAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('profile'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: ConnectedServiceProfileIdSchema,
  }));

const SessionUsageLimitRecoveryGroupAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('group'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    profileId: z.nullable(ConnectedServiceProfileIdSchema),
  }));

export const SessionUsageLimitRecoveryAuthSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionUsageLimitRecoveryNativeAuthSelectionV1Schema,
  SessionUsageLimitRecoveryProfileAuthSelectionV1Schema,
  SessionUsageLimitRecoveryGroupAuthSelectionV1Schema,
]));
export type SessionUsageLimitRecoveryAuthSelectionV1 = z.infer<
  typeof SessionUsageLimitRecoveryAuthSelectionV1Schema
>;

export const SessionUsageLimitRecoveryStatusV1Schema = lazyZodSchema(() => z.enum([
  'armed',
  'waiting',
  'checking',
  'paused',
  'exhausted',
  'cancelled',
]));
export type SessionUsageLimitRecoveryStatusV1 = z.infer<typeof SessionUsageLimitRecoveryStatusV1Schema>;

export const SessionUsageLimitRecoveryResumePromptModeV1Schema = lazyZodSchema(() => z.enum(['standard', 'off', 'custom']));
export type SessionUsageLimitRecoveryResumePromptModeV1 =
  z.infer<typeof SessionUsageLimitRecoveryResumePromptModeV1Schema>;

export const SessionUsageLimitRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    status: SessionUsageLimitRecoveryStatusV1Schema,
    resumePromptMode: z._default(SessionUsageLimitRecoveryResumePromptModeV1Schema, 'standard'),
    issueFingerprint: z.string().check(z.trim(), z.minLength(1)),
    armedAtMs: z.number().check(z.int(), z.nonnegative()),
    runtimeAuthRecoveryAttemptId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    nextCheckAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    attemptCount: z.number().check(z.int(), z.nonnegative()),
    maxAttempts: z.number().check(z.int(), z.nonnegative()),
    lastProbeError: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1Schema,
    recoveryCredits: z.optional(ConnectedServiceQuotaRecoveryCreditsV1Schema),
  }));
export type SessionUsageLimitRecoveryV1 = z.infer<typeof SessionUsageLimitRecoveryV1Schema>;

export const SessionStateUsageLimitRecoveryValueSchema = SessionUsageLimitRecoveryV1Schema;
