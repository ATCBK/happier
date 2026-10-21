import type { AgentSessionCatalogResult } from '@happier-dev/plugin-sdk/agents/runtime';
import type { VendorPluginCatalogItemV1 } from '@happier-dev/protocol/runtime/catalog/vendorPlugins';

export function projectNativeVendorPluginCatalog(
  agentId: string,
  result: AgentSessionCatalogResult,
): Readonly<{
  vendorPlugins: readonly VendorPluginCatalogItemV1[];
  unsupported?: true;
  diagnostic?: string;
}> {
  if (result.status !== 'ok' || result.kind !== 'vendorPlugins') {
    return {
      unsupported: true,
      vendorPlugins: [],
      diagnostic: result.status === 'ok'
        ? 'native_vendor_plugin_catalog_kind_mismatch'
        : result.diagnostic.code,
    };
  }
  return {
    vendorPlugins: result.items.map(item => ({
      v: 1,
      backendId: agentId,
      agentId,
      vendorPluginRef: item.id,
      name: item.name,
      displayName: item.displayName,
      ...(item.description ? { description: item.description } : {}),
      installed: item.installed,
      enabled: item.enabled,
      mentionable: item.mentionable,
    })),
  };
}
