import { z } from 'zod/mini';

/** The installed catalog's envelope, independent of executable row admission. */
export function createPluginStateFileSchema<T extends z.ZodMiniType>(plugins: T) {
  return z.strictObject({ t: z.literal('happier_plugin_state_v1'), schemaVersion: z.literal(1), plugins });
}
