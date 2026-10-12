import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Presentation-only cause of an already failed launch; carries no execution authority. */
export const SpawnFailureV1Schema = lazyZodSchema(() => z.object({
    reason: z.enum(['too_many_open_files', 'no_ptys', 'process_limit', 'out_of_memory', 'other']),
    errno: z.string().regex(/^E[A-Z0-9_]+$/u).optional(),
}).strict());
export type SpawnFailureV1 = z.infer<typeof SpawnFailureV1Schema>;
