import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginUiRendererChainBindingV1Schema } from './ui/rendererChainBinding.js';
import { ComposerScopeKindV1Schema } from '../ui/composer.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const MAX_PLUGIN_COMPOSER_REGIONS_V1 = 64;

/** A manifest-declared rich region adjacent to the host-owned composer. */
export const PluginComposerRegionContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  placement: z.enum(['beforeComposer', 'afterComposer']),
  renderer: PluginUiRendererChainBindingV1Schema,
  scopes: z.optional(z.array(ComposerScopeKindV1Schema).check(z.minLength(1))),
  order: z.optional(z.number()),
}));
export type PluginComposerRegionContributionV1 = z.infer<
  typeof PluginComposerRegionContributionV1Schema
>;
