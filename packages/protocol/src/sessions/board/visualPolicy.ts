import {
  normalizeUiSurfaceCapabilityRequestV1,
  type NormalizedUiSurfaceCapabilityRequestV1,
  type UiSurfaceCapabilityRequestV1,
} from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { readWidgetDefinitionNetworkOverrideV1 } from '../../widgets/widgetDefinitionV1.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from './item.js';

export function readSessionVisualHtmlBodyV1(item: SessionSurfaceItemV1) {
  if (item.source.kind !== 'widget' || item.source.instance.definition.kind !== 'inline') return null;
  const body = item.source.instance.definition.definition.body;
  return body.kind === 'html' ? body : null;
}

export function usesInheritedSessionWidgetNetworkV1(item: SessionSurfaceItemV1): boolean {
  return item.source.kind === 'widget' && readSessionVisualHtmlBodyV1(item) === null
    && item.source.instance.networkOverride === undefined
    && (item.source.instance.definition.kind !== 'inline'
      || readWidgetDefinitionNetworkOverrideV1(item.source.instance.definition.definition) === undefined);
}

/** Authored capabilities and explicit overrides, not installed renderer authority. */
export function readSessionVisualCapabilitiesV1(item: SessionSurfaceItemV1): NormalizedUiSurfaceCapabilityRequestV1 | null {
  if (item.source.kind === 'hostedHtml') return normalizeUiSurfaceCapabilityRequestV1(item.source.requestedCapabilities);
  if (item.source.kind === 'widget') {
    const instance = item.source.instance;
    const capabilities = normalizeUiSurfaceCapabilityRequestV1(readSessionVisualHtmlBodyV1(item)?.requestedCapabilities);
    if (!capabilities) return null;
    const requestedOverride = instance.networkOverride ?? (instance.definition.kind === 'inline'
      ? readWidgetDefinitionNetworkOverrideV1(instance.definition.definition) : undefined);
    const override = requestedOverride === undefined ? null : normalizeUiSurfaceCapabilityRequestV1(requestedOverride);
    return override ? { ...capabilities, network: override.network, networkOrigins: override.networkOrigins } : capabilities;
  }
  return normalizeUiSurfaceCapabilityRequestV1(undefined);
}

/** The captured Account setting changes creation effects only; existing items keep their reviewed policy. */
export function resolveSessionVisualEffectiveCapabilitiesV1(
  capabilities: NormalizedUiSurfaceCapabilityRequestV1,
  admission: Readonly<{ isCreate: boolean; networkSetting: 'allowed' | 'ask' | 'off' | null }>,
): NormalizedUiSurfaceCapabilityRequestV1 {
  return admission.isCreate && admission.networkSetting === 'off'
    ? { ...capabilities, network: 'none', networkOrigins: [] }
    : capabilities;
}

/** One materialization of the already admitted policy, shared by writes and their recovery correspondence. */
export function persistSessionVisualEffectivePolicyV1(item: SessionSurfaceItemV1, capabilities: NormalizedUiSurfaceCapabilityRequestV1): SessionSurfaceItemV1 {
  const policy: UiSurfaceCapabilityRequestV1 = {
    ...(capabilities.network === 'origins' ? {} : { network: capabilities.network }),
    networkOrigins: [...capabilities.networkOrigins],
  };
  if (item.source.kind === 'hostedHtml') return { ...item, source: { ...item.source,
    requestedCapabilities: { ...item.source.requestedCapabilities, ...policy } } };
  // Installed renderer/grant admission remains the authority when no caller
  // override was declared; persisting none here would silently revoke it.
  if (item.source.kind === 'widget' && !usesInheritedSessionWidgetNetworkV1(item)) return SessionSurfaceItemV1Schema.parse({ ...item,
    source: { ...item.source, instance: { ...item.source.instance, networkOverride: policy } } });
  return item;
}
