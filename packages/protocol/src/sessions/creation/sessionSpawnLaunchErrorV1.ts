import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Redacted presentation of a failed launch; never launch or retry authority. */
export const SessionSpawnLaunchErrorV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('launch_error'),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u),
  message: z.string().refine(value => value.trim().length > 0),
}).strict());
export type SessionSpawnLaunchErrorV1 = z.infer<typeof SessionSpawnLaunchErrorV1Schema>;
