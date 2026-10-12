import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryContentRefV1Schema } from './registryItemsV1.js';

export const RegistryUpstreamV1Schema = lazyZodSchema(() => z.object({
  state: z.enum(['current', 'update_available', 'removed_from_source']),
  latest: RegistryContentRefV1Schema.optional(),
}).strict());
export type RegistryUpstreamV1 = z.infer<typeof RegistryUpstreamV1Schema>;
