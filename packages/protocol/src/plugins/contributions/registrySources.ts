import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { REGISTRY_FORMAT_KINDS_V1, RegistryKindV1Schema } from '../../registries/registrySourcesV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

/** Closed data-only declaration; registry adapters and credentials remain host-owned. */
export const PluginRegistrySourceContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.string().min(1),
  format: z.enum(['git', 'claude-marketplace', 'mcp-registry', 'acp-registry', 'happier-catalog']),
  kinds: z.array(RegistryKindV1Schema).min(1),
  url: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Registry declarations require credential-free HTTPS'),
  path: z.string().optional(),
  ref: z.string().min(1).optional(),
}).strict().superRefine((source, context) => {
  if (source.kinds.some(kind => !REGISTRY_FORMAT_KINDS_V1[source.format].includes(kind))) {
    context.addIssue({ code: 'custom', path: ['kinds'], message: 'Kind not supported by source format' });
  }
}));

export type PluginRegistrySourceContributionV1 = z.infer<typeof PluginRegistrySourceContributionV1Schema>;
