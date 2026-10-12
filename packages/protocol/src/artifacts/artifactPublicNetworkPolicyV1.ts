import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { normalizeUiSurfaceCapabilityRequestV1, type UiSurfaceNetworkPolicyV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { WidgetDefinitionV1StoredSchema, isWidgetDefinitionPubliclyRenderableV1, readWidgetDefinitionNetworkOverrideV1 } from '../widgets/widgetDefinitionV1.js';
import { ArtifactHtmlBundleV1Schema, artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from './artifactHtmlV1.js';

/** Unopened binary content is unavailable; it cannot prove a no-network consequence. */
export function readArtifactPublicNetworkPolicyV1(resource: Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; body?: ArtifactBodyV1 | null;
  /** Already opened/integrity-checked binary content, when the Artifact body is a blob reference. */
  htmlBundle?: ArtifactHtmlBundleV1;
}>): UiSurfaceNetworkPolicyV1 | null {
  let request: unknown;
  if (resource.header.kind === 'html') {
    if (!resource.htmlBundle && typeof resource.body !== 'string') return null;
    try {
      const bundle = resource.htmlBundle ? createStoredReadSchema(ArtifactHtmlBundleV1Schema).parse(resource.htmlBundle)
        : typeof resource.body === 'string' ? artifactHtmlBundleFromBodyV1(resource.body,
          typeof resource.header.mime === 'string' ? resource.header.mime : 'text/html', 'stored') : undefined;
      request = bundle?.requestedCapabilities;
    } catch { /* Malformed saved content has no network authority. */ }
  }
  else if (resource.header.kind === 'widget-definition.v1' && resource.header.v === 1) {
    try {
      const parsed = WidgetDefinitionV1StoredSchema.safeParse(typeof resource.body === 'string' ? JSON.parse(resource.body) : null);
      if (parsed.success && parsed.data.id === resource.artifactId && isWidgetDefinitionPubliclyRenderableV1(parsed.data)) {
        request = readWidgetDefinitionNetworkOverrideV1(parsed.data);
      }
    } catch { /* Malformed saved content has no network authority. */ }
  }
  const normalized = normalizeUiSurfaceCapabilityRequestV1(request);
  return { network: normalized?.network ?? 'none', networkOrigins: normalized?.networkOrigins ?? [] };
}
