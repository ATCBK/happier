import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const ImageRefSchema = lazyZodSchema(() => z.object({
  path: z.string(),
  url: z.string(),
  width: z.optional(z.number()),
  height: z.optional(z.number()),
  thumbhash: z.optional(z.string()),
}));

export type ImageRef = z.infer<typeof ImageRefSchema>;
