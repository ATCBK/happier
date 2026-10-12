import { expect, it } from 'vitest';
import { removeTransferredProviderConnectionsSourceV1 } from './providerConnectionsCatalogV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from './connectionRowsV1.js';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema } from '../selection/v1.js';

it('keeps an existing annotated default while retiring a transferred source without admitting invalid selections', () => {
  const selection = { v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-5' }, updatedAt: 10 };
  const defaults = { 'agent:codex': selection };
  expect(ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse(defaults)).toEqual(defaults);
  const retainedDefaults = { 'agent:codex': { ...selection, retired: true,
    ref: { ...selection.ref, retired: true } } };
  const raw = { unrelated: 'keep', providerSettingsV1: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    providerDefaultModelSelectionsByAgentTargetKeyV1: retainedDefaults };
  expect(removeTransferredProviderConnectionsSourceV1(raw)).toEqual({ status: 'ready',
    raw: { unrelated: 'keep', providerDefaultModelSelectionsByAgentTargetKeyV1: retainedDefaults }, preferenceHandoffRequired: false });
  expect(removeTransferredProviderConnectionsSourceV1({ ...raw,
    providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:codex': { ...selection, updatedAt: -1, retired: true } } }))
    .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
});
