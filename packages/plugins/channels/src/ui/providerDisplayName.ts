import { useCallback } from 'react';
import { usePluginBrandDisplayNameResolver, useSurfaceContext } from '@happier-dev/plugin-ui';
import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/channels-protocol/v1';

/** All Channels surfaces use the host's admitted provider presentation. */
export function useConversationProviderDisplayNameResolver(): (pluginId: string | undefined) => string | undefined {
  const { targetedContributions } = useSurfaceContext();
  const resolveBrandName = usePluginBrandDisplayNameResolver();
  return useCallback((pluginId: string | undefined): string | undefined => {
    if (pluginId === undefined) return undefined;
    const point = targetedContributions?.target.pluginId === CONVERSATION_CORE_PLUGIN_ID_V1
      ? targetedContributions.points.find((entry) => entry.pointId === CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1)
      : undefined;
    const protocol = point?.protocols.find((entry) => (
      entry.protocol.id === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1
      && entry.protocol.version === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1
    ));
    const descriptor = protocol?.contributions.find((entry) => entry.contributor.pluginId === pluginId)?.descriptor;
    // The host already admitted this descriptor; only narrow the public JSON carrier here.
    if (descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor)
      && typeof descriptor.displayName === 'string') return descriptor.displayName;
    return resolveBrandName(pluginId);
  }, [resolveBrandName, targetedContributions]);
}

export function useConversationProviderDisplayName(pluginId: string | undefined): string | undefined {
  return useConversationProviderDisplayNameResolver()(pluginId);
}
