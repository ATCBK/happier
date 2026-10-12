import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

// Evaluators consume whole minute records and can read seven days of history.
const sustainMs = () => z.number().int().min(60_000).max(7 * 24 * 60 * 60_000).multipleOf(60_000);
export const MachineVitalsDiskThresholdV1Schema = lazyZodSchema(() => z.union([
  z.object({ freeFraction: z.number().min(0).max(1) }).strict(),
  z.object({ freeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
]));
export const MachineVitalsAlertsPolicyV1Schema = lazyZodSchema(() => z.object({
  memory: z.object({ enabled: z.boolean().default(false), level: z.enum(['elevated', 'critical']).default('critical'),
    sustainMs: sustainMs().default(300_000) }).strict().default({ enabled: false, level: 'critical', sustainMs: 300_000 }),
  cpu: z.object({ enabled: z.boolean().default(false), abovePct: z.number().min(1).max(100).default(90),
    sustainMs: sustainMs().default(900_000) }).strict().default({ enabled: false, abovePct: 90, sustainMs: 900_000 }),
  disk: z.object({ enabled: z.boolean().default(false), threshold: MachineVitalsDiskThresholdV1Schema.default({ freeFraction: 0.1 }) })
    .strict().default({ enabled: false, threshold: { freeFraction: 0.1 } }),
}).strict());
export type MachineVitalsAlertsPolicyV1 = z.infer<typeof MachineVitalsAlertsPolicyV1Schema>;
export const MachineVitalsAlertsPolicyPatchV1Schema = lazyZodSchema(() => z.object({
  memory: z.object({ enabled: z.boolean().optional(), level: z.enum(['elevated', 'critical']).optional(), sustainMs: sustainMs().optional() }).strict().optional(),
  cpu: z.object({ enabled: z.boolean().optional(), abovePct: z.number().min(1).max(100).optional(), sustainMs: sustainMs().optional() }).strict().optional(),
  disk: z.object({ enabled: z.boolean().optional(), threshold: MachineVitalsDiskThresholdV1Schema.optional() }).strict().optional(),
}).strict());
