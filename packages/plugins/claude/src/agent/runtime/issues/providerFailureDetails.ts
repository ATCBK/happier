import { z } from 'zod';

export const ClaudeSessionRuntimeUsageLimitDetailsSchema = z.object({
  v: z.literal(1),
  resetAtMs: z.number().int().nonnegative().nullable(),
  retryAfterMs: z.number().int().nonnegative().nullable(),
  quotaScope: z.enum(['account', 'workspace', 'organization', 'model', 'provider', 'unknown']),
  recoverability: z.enum(['wait', 'switch_account', 'manual', 'unknown']),
  providerLimitId: z.string().trim().min(1).optional(),
  planType: z.string().trim().min(1).nullable().optional(),
  utilization: z.number().finite().min(0).max(100).nullable().optional(),
  limitCategory: z.enum([
    'usage_limit',
    'rate_limit',
    'capacity',
    'temporary_throttle',
    'auth_invalid',
    'plan_invalid',
    'validation_failed',
    'disabled',
    'unknown',
  ]).optional(),
  quotaSnapshotRef: z.object({
    serviceId: z.string().trim().min(1),
    profileId: z.string().trim().min(1).optional(),
    groupId: z.string().trim().min(1).optional(),
    fetchedAtMs: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  effectiveMeterId: z.string().trim().min(1).optional(),
  effectiveRemainingPct: z.number().finite().min(0).max(100).optional(),
  allWindows: z.array(z.object({
    meterId: z.string().trim().min(1),
    scope: z.string().trim().min(1).optional(),
    remainingPct: z.number().finite().min(0).max(100).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
    status: z.string().trim().min(1).optional(),
  }).strict()).optional(),
  recoveryDecision: z.enum([
    'switching',
    'waiting_for_reset',
    'manual_intervention',
    'not_recoverable',
  ]).optional(),
  overage: z.object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
    resetAtMs: z.number().int().nonnegative().nullable(),
    disabledReason: z.string().trim().min(1).nullable().optional(),
  }).strict().nullable().optional(),
  action: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('open_url'),
      labelKey: z.string().trim().min(1).optional(),
      url: z.string().url(),
    }).strict(),
    z.object({ kind: z.literal('settings') }).strict(),
    z.object({ kind: z.literal('none') }).strict(),
  ]).nullable().optional(),
  connectedService: z.object({
    serviceId: z.string().trim().min(1),
    profileId: z.string().trim().min(1).nullable(),
    groupId: z.string().trim().min(1).nullable(),
    groupExhausted: z.boolean().optional(),
  }).strict().nullable().optional(),
}).strict();

export const ClaudeSessionRuntimeTemporaryThrottleDetailsSchema = z.object({
  v: z.literal(1),
  retryAfterMs: z.number().int().nonnegative().nullable(),
  recoverability: z.enum(['retry', 'manual', 'wait', 'unknown']),
}).strict();
