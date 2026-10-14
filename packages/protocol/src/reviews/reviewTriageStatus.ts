import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const ReviewTriageStatusSchema = lazyZodSchema(() => z.enum(['accept', 'reject', 'defer', 'needs_refinement']));
export type ReviewTriageStatus = z.infer<typeof ReviewTriageStatusSchema>;
