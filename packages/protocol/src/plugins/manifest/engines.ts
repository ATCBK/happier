import { z } from 'zod';
import semver from 'semver';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const PluginEnginesV2Schema = lazyZodSchema(() => z.object({
  happier: z.string().trim().min(1).refine(
    (value) => !/[x*]/i.test(value) && semver.validRange(value) !== null,
    'engines.happier must be a non-wildcard semver range.',
  ).optional(),
}).strict().optional());
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;
