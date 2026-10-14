import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SocialFriendsCapabilitiesSchema = lazyZodSchema(() => z.object({
  allowUsername: z.boolean(),
  requiredIdentityProviderId: z.nullable(z.string()),
}));

export type SocialFriendsCapabilities = z.infer<typeof SocialFriendsCapabilitiesSchema>;

export const DEFAULT_SOCIAL_FRIENDS_CAPABILITIES: SocialFriendsCapabilities = {
  allowUsername: false,
  requiredIdentityProviderId: null,
};
