import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const OAuthProviderStatusSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
}));

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;
