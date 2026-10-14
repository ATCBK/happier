import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginUiArtifactHostingCapabilityV1Schema } from '../../../plugins/availability/v1.js';

export const PluginsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  uiArtifactHosting: PluginUiArtifactHostingCapabilityV1Schema,
}));

export const DEFAULT_PLUGINS_CAPABILITIES = Object.freeze({
  uiArtifactHosting: { enabled: false as const },
});
