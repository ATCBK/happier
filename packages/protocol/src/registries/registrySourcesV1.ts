import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const RegistryFormatV1Schema = lazyZodSchema(() => z.enum([
  'skills-sh', 'git', 'claude-marketplace', 'mcp-registry', 'acp-registry', 'happier-catalog', 'happier-npm',
]));
export type RegistryFormatV1 = z.infer<typeof RegistryFormatV1Schema>;
