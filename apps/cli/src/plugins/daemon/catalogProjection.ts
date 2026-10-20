import { z } from 'zod/mini';

/** A freshness hint, never executable authority. Both identity and fact are closed. */
export const DaemonPluginCatalogProjectionSchema = z.strictObject({
  runtimeId: z.string().check(z.minLength(1)),
  contributionRegistryProjectionRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
});
export type DaemonPluginCatalogProjection = Readonly<z.infer<typeof DaemonPluginCatalogProjectionSchema>>;

/** Omission preserves the full display catalog for administration readers. */
export const DaemonPluginCatalogReadRequestSchema = z.strictObject({
  selection: z.optional(z.literal('tools')),
});
export type DaemonPluginCatalogReadRequest = Readonly<z.infer<typeof DaemonPluginCatalogReadRequestSchema>>;
