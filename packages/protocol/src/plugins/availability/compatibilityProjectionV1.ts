import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { PluginUiArtifactsManifestV2Schema, type PluginUiArtifactsManifestV2 } from '../ui/uiArtifactsManifest.js';

/**
 * Availability consumes the canonical manifest parser's output. The manifest schema
 * already rejects source/private locator fields; source verification remains at the
 * acquisition owner and is deliberately not persisted here.
 */
export const PluginPortableReleaseManifestV1Schema: typeof PluginManifestV2Schema = PluginManifestV2Schema;
export type PluginPortableReleaseManifestV1 = z.infer<typeof PluginPortableReleaseManifestV1Schema>;

/**
 * The generated compatibility input published beside an immutable
 * package version. It deliberately contains only canonical manifest and UI
 * artifact facts: host/SDK build provenance is not an author-controlled
 * compatibility switch and therefore has no field here.
 */
export const PluginCompatibilityProjectionV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  manifest: PluginPortableReleaseManifestV1Schema,
  uiArtifacts: PluginUiArtifactsManifestV2Schema,
}).strict());
export type PluginCompatibilityProjectionV1 = z.infer<typeof PluginCompatibilityProjectionV1Schema>;

/**
 * Generates the only comparison payload from the canonical manifest and
 * generated UI inventory already admitted by package build/staging owners.
 */
export function createPluginCompatibilityProjectionV1(input: Readonly<{
  manifest: PluginPortableReleaseManifestV1;
  uiArtifacts: PluginUiArtifactsManifestV2;
}>): PluginCompatibilityProjectionV1 {
  return PluginCompatibilityProjectionV1Schema.parse({
    version: 1,
    manifest: input.manifest,
    uiArtifacts: input.uiArtifacts,
  });
}

export function pluginCompatibilityProjectionEqualV1(
  left: unknown,
  right: unknown,
): boolean {
  return createCanonicalJsonSigningInput(PluginCompatibilityProjectionV1Schema.parse(left))
    === createCanonicalJsonSigningInput(PluginCompatibilityProjectionV1Schema.parse(right));
}

