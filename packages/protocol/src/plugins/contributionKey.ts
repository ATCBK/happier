import type { PluginContributionIdentityV1 } from './contributionIdentity.js';

/**
 * Binds a declaration-local reference to its declaring plugin. Declaration
 * ingress owns validation; the contribution catalog owns reference resolution.
 */
export function qualifyPluginContributionReferenceV1(reference: string | PluginContributionIdentityV1, declaringPluginId: string): PluginContributionIdentityV1 {
  return typeof reference === 'string'
    ? { pluginId: declaringPluginId, localId: reference }
    : { pluginId: reference.pluginId, localId: reference.localId };
}

export function buildQualifiedPluginContributionKey(identity: PluginContributionIdentityV1): string {
  return `${identity.pluginId}/${identity.localId}`;
}
