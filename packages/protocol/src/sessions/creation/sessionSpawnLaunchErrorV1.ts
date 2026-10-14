import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Redacted presentation of a failed launch; never launch or retry authority. */
export const SessionSpawnLaunchErrorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('launch_error'),
  code: z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)),
  message: z.string().check(z.refine(value => value.trim().length > 0)),
}));
export type SessionSpawnLaunchErrorV1 = z.infer<typeof SessionSpawnLaunchErrorV1Schema>;
