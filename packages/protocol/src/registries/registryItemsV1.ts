import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryFormatV1Schema } from './registrySourcesV1.js';

export const RegistryContentRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gitTree'), repo: z.string().min(1), path: z.string(),
    commit: z.string().min(1), treeSha: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('version'), version: z.string().min(1) }).strict(),
]));
export type RegistryContentRefV1 = z.infer<typeof RegistryContentRefV1Schema>;

export const RegistryProvenanceV1Schema = lazyZodSchema(() => z.object({
  sourceId: z.string().min(1), format: RegistryFormatV1Schema, sourceUrl: z.string().min(1),
  itemId: z.string().min(1), ref: RegistryContentRefV1Schema, importedAt: z.number().int().nonnegative(),
}).strict());
export type RegistryProvenanceV1 = z.infer<typeof RegistryProvenanceV1Schema>;
