import { describe, expect, it } from 'vitest';
import { readConnectedServiceRuntimeSnapshot } from './connectedServiceRuntimeSnapshot';

describe('readConnectedServiceRuntimeSnapshot', () => {
  it('retains known stored binding and materialization identity fields across retired fields', () => {
    expect(readConnectedServiceRuntimeSnapshot({
      connectedServices: { v: 2, retiredBindingsField: true, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work', retiredBindingField: true },
      } },
      connectedServicesUpdatedAt: 10,
      connectedServiceMaterializationIdentityV1: {
        v: 1, id: 'csm_test', createdAt: 10, source: 'first_spawn', retiredIdentityField: true,
      },
    })).toEqual({
      connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      } },
      connectedServicesUpdatedAt: 10,
      connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_test', createdAt: 10, source: 'first_spawn', retiredIdentityField: true },
    });
    expect(readConnectedServiceRuntimeSnapshot({ connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 123, retiredBindingField: true },
    } } })).toEqual({});
  });
});
