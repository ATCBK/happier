import { z } from 'zod';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** t is the end of the measured minute; null preserves unavailable counter deltas. */
export const MachineVitalsMinuteRecordV1Schema = lazyZodSchema(() => z.object({
  t: z.number().int().nonnegative(),
  cpu: z.number().min(0).max(100).nullable(),
  cpuMax: z.number().min(0).max(100).nullable(),
  mem: z.number().nonnegative().nullable(),
  memMax: z.number().nonnegative().nullable(),
  lvl: z.enum(['calm', 'elevated', 'critical', 'not_reported']),
  swp: z.number().nonnegative().nullable(),
  rx: z.number().nonnegative().nullable(),
  tx: z.number().nonnegative().nullable(),
}).strict());
export type MachineVitalsMinuteRecordV1 = z.infer<typeof MachineVitalsMinuteRecordV1Schema>;
export const MachineVitalsMinuteRecordV1StoredReadSchema = createStoredReadSchema(MachineVitalsMinuteRecordV1Schema);

export const MachineVitalsAlertEpisodeV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('alert'),
  rule: z.enum(['memory', 'cpu', 'disk']),
  volumeId: z.string().min(1).optional(),
  state: z.enum(['fired', 'recovered']),
  at: z.number().int().nonnegative(),
}).strict());
export type MachineVitalsAlertEpisodeV1 = z.infer<typeof MachineVitalsAlertEpisodeV1Schema>;
export const MachineVitalsAlertEpisodeV1StoredReadSchema = createStoredReadSchema(MachineVitalsAlertEpisodeV1Schema);

/** Chart buckets use t at the bucket start; network fields remain bytes per bucket. */
export const MachineVitalsHistoryV1Schema = lazyZodSchema(() => z.object({
  range: z.enum(['1h', '24h', '7d']),
  bucketMs: z.number().int().positive(),
  points: z.array(MachineVitalsMinuteRecordV1Schema.nullable()),
  today: z.object({ rxBytes: z.number().nonnegative(), txBytes: z.number().nonnegative() }).strict(),
}).strict());
export type MachineVitalsHistoryV1 = z.infer<typeof MachineVitalsHistoryV1Schema>;
