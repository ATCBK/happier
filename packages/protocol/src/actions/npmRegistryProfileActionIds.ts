import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const NPM_REGISTRY_PROFILE_ACTION_IDS_V1 = [
  'plugins.npm_registry_profiles.list', 'plugins.npm_registry_profiles.add', 'plugins.npm_registry_profiles.update',
  'plugins.npm_registry_profiles.remove', 'plugins.npm_registry_profiles.login', 'plugins.npm_registry_profiles.logout',
  'plugins.npm_registry_profiles.test',
] as const;
export type NpmRegistryProfileActionIdV1 = typeof NPM_REGISTRY_PROFILE_ACTION_IDS_V1[number];
export const NpmRegistryProfileActionIdV1Schema = lazyZodSchema(() => z.enum(NPM_REGISTRY_PROFILE_ACTION_IDS_V1));
