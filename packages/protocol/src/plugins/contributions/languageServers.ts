import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { PluginJsonValueV2Schema } from './publicTypes.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Cold declarations; the Machine host owns process and document lifetime. */
export const PluginLanguageServerContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: NonEmptyStringSchema,
  languageIds: z.record(NonEmptyStringSchema, NonEmptyStringSchema),
  filePatterns: z.optional(z.array(NonEmptyStringSchema)),
  rootMarkers: z.optional(z.array(NonEmptyStringSchema)),
  executable: PluginDeclaredExecutableRefSchema,
  args: z.array(z.string().check(z.refine(value => !value.includes('\0'), 'Process arguments cannot contain null bytes'))),
  initializationOptions: z.optional(PluginJsonValueV2Schema),
  settings: z.optional(PluginJsonValueV2Schema),
}));

export type PluginLanguageServerContributionV1 = z.infer<typeof PluginLanguageServerContributionV1Schema>;
