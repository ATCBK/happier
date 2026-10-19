import { z } from 'zod/mini';

export const ClaudeSessionRuntimeUsageLimitDetailsSchema = z.strictObject({
  v: z.literal(1),
  resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
  retryAfterMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
  quotaScope: z.enum(['account', 'workspace', 'organization', 'model', 'provider', 'unknown']),
  recoverability: z.enum(['wait', 'switch_account', 'manual', 'unknown']),
  providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  planType: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  utilization: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(100)))),
  limitCategory: z.optional(z.enum([
    'usage_limit',
    'rate_limit',
    'capacity',
    'temporary_throttle',
    'auth_invalid',
    'plan_invalid',
    'validation_failed',
    'disabled',
    'unknown',
  ])),
  quotaSnapshotRef: z.optional(z.strictObject({
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    groupId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    fetchedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  })),
  effectiveMeterId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  effectiveRemainingPct: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
  allWindows: z.optional(z.array(z.strictObject({
    meterId: z.string().check(z.trim(), z.minLength(1)),
    scope: z.optional(z.string().check(z.trim(), z.minLength(1))),
    remainingPct: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
    resetAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    status: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }))),
  recoveryDecision: z.optional(z.enum([
    'switching',
    'waiting_for_reset',
    'manual_intervention',
    'not_recoverable',
  ])),
  overage: z.optional(z.nullable(z.strictObject({
    status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
    resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    disabledReason: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  }))),
  action: z.optional(z.nullable(z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('open_url'),
      labelKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
      url: z.string().check(z.url()),
    }),
    z.strictObject({ kind: z.literal('settings') }),
    z.strictObject({ kind: z.literal('none') }),
  ]))),
  connectedService: z.optional(z.nullable(z.strictObject({
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    profileId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    groupId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    groupExhausted: z.optional(z.boolean()),
  }))),
});

export const ClaudeSessionRuntimeTemporaryThrottleDetailsSchema = z.strictObject({
  v: z.literal(1),
  retryAfterMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
  recoverability: z.enum(['retry', 'manual', 'wait', 'unknown']),
});
