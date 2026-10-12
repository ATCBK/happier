import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const duration = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idleRule = () => z.object({ enabled: z.boolean().default(false), afterMs: duration().min(60_000).default(7_200_000),
  warnBeforeMs: duration().default(300_000) }).strict();
export const MachineGuardPolicyV1Schema = lazyZodSchema(() => z.object({
  memoryGuard: z.object({ enabled: z.boolean().default(false), actAt: z.enum(['elevated', 'critical']).default('critical'),
    sustainMs: duration().min(60_000).default(120_000), cooldownMs: duration().min(60_000).default(60_000),
    steps: z.object({ browsers: z.boolean().default(true), devServers: z.boolean().default(true), idleSessions: z.boolean().default(true) }).strict().default(() => ({ browsers: true, devServers: true, idleSessions: true })),
    pausedUntil: duration().nullable().default(null),
  }).strict().default(() => ({ enabled: false, actAt: 'critical' as const, sustainMs: 120_000, cooldownMs: 60_000,
    steps: { browsers: true, devServers: true, idleSessions: true }, pausedUntil: null })),
  idleSessions: idleRule().default(() => ({ enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 })),
  idleTerminals: idleRule().default(() => ({ enabled: false, afterMs: 7_200_000, warnBeforeMs: 300_000 })),
  leftBehind: z.object({ mode: z.enum(['off', 'ask', 'automatic']).default('off'), graceMs: duration().default(0) }).strict().default(() => ({ mode: 'off' as const, graceMs: 0 })),
  sessionMemoryCeiling: z.object({ bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
    warnAtPercent: z.number().min(1).max(99).default(90) }).strict().default(() => ({ bytes: null, warnAtPercent: 90 })),
  keepAwake: z.enum(['off', 'on', 'on_power']).default('on'),
}).strict().superRefine((policy, context) => {
  for (const key of ['idleSessions', 'idleTerminals'] as const) {
    if (policy[key].warnBeforeMs >= policy[key].afterMs) context.addIssue({ code: 'custom', path: [key, 'warnBeforeMs'], message: 'Warning must precede the idle deadline' });
  }
}));
export type MachineGuardPolicyV1 = z.infer<typeof MachineGuardPolicyV1Schema>;
export const MachineGuardPolicyPatchV1Schema = lazyZodSchema(() => {
  const full = MachineGuardPolicyV1Schema.shape;
  const idlePatch = () => z.object({ enabled: z.boolean().optional(), afterMs: duration().min(60_000).optional(), warnBeforeMs: duration().optional() }).strict();
  return z.object({
    memoryGuard: z.object({ enabled: z.boolean().optional(), actAt: z.enum(['elevated', 'critical']).optional(),
      sustainMs: duration().min(60_000).optional(), cooldownMs: duration().min(60_000).optional(), pausedUntil: duration().nullable().optional(),
      steps: z.object({ browsers: z.boolean().optional(), devServers: z.boolean().optional(), idleSessions: z.boolean().optional() }).strict().optional(),
    }).strict().optional(),
    idleSessions: idlePatch().optional(), idleTerminals: idlePatch().optional(),
    leftBehind: z.object({ mode: z.enum(['off', 'ask', 'automatic']).optional(), graceMs: duration().optional() }).strict().optional(),
    sessionMemoryCeiling: z.object({ bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(), warnAtPercent: z.number().min(1).max(99).optional() }).strict().optional(),
    keepAwake: full.keepAwake.removeDefault().optional(),
  }).strict();
});
export type MachineGuardPolicyPatchV1 = z.infer<typeof MachineGuardPolicyPatchV1Schema>;
export function mergeMachineGuardPolicyV1(current: MachineGuardPolicyV1, patch: MachineGuardPolicyPatchV1 | undefined) {
  return { ...current, ...patch,
    memoryGuard: { ...current.memoryGuard, ...patch?.memoryGuard, steps: { ...current.memoryGuard.steps, ...patch?.memoryGuard?.steps } },
    idleSessions: { ...current.idleSessions, ...patch?.idleSessions }, idleTerminals: { ...current.idleTerminals, ...patch?.idleTerminals },
    leftBehind: { ...current.leftBehind, ...patch?.leftBehind }, sessionMemoryCeiling: { ...current.sessionMemoryCeiling, ...patch?.sessionMemoryCeiling },
  };
}
