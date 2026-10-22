import { describe, expect, it } from 'vitest';

import { isExecutionRunConnectedServiceGenerationCurrent } from './executionRunGenerationAdmission';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { parseConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';

const projection = {
  groups: [{ serviceId: 'openai-codex', groupId: 'default', activeProfileId: 'work', generation: 4 }],
  credentialRevisions: [{ serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }],
  resolveCredentialRevision: (_serviceId: string, _profileId: string) => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
} as any;

describe('isExecutionRunConnectedServiceGenerationCurrent', () => {
  it('accepts only the exact materialized group generation and credential revision', () => {
    const target = {
      materializationKey: 'run-1',
      activeBindings: [{
        serviceId: 'openai-codex', groupId: 'default', profileId: 'work',
        groupGeneration: 4, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }],
    } as any;
    expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'run-1', target, projection })).toBe(true);
    expect(isExecutionRunConnectedServiceGenerationCurrent({
      runId: 'run-1',
      target: { ...target, activeBindings: [{ ...target.activeBindings[0], groupGeneration: 3 }] },
      projection,
    })).toBe(false);
  });

  it('rejects a direct profile after its credential revision changes', () => {
    expect(isExecutionRunConnectedServiceGenerationCurrent({
      runId: 'run-direct',
      target: {
        materializationKey: 'run-direct',
        activeBindings: [{
          serviceId: 'openai-codex', groupId: null, profileId: 'work',
          groupGeneration: null, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }],
      } as any,
      projection,
    })).toBe(false);
  });

  it('checks only locally materialized profiles for an admitted brokered Team route', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bindings = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered',
    } } } as const;
    const target = registry.registerRunTarget({ runKey: 'brokered-run', pid: process.pid, agentId: 'codex',
      materializationKey: 'brokered-run', connectedServicesBindingsRaw: bindings, connectedServiceSelectionsEnv: {} });
    const emptyProjection = parseConnectedServiceProjectionSnapshot({ connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] });
    expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'brokered-run', target, projection: emptyProjection })).toBe(true);
    expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'another-run', target, projection: emptyProjection })).toBe(false);
    for (const raw of [null, { v: 2, bindingsByServiceId: {} }, { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'unmaterialized' },
    } }]) {
      const unproven = registry.registerRunTarget({ runKey: 'brokered-run', pid: process.pid,
        materializationKey: 'brokered-run', connectedServicesBindingsRaw: raw, connectedServiceSelectionsEnv: {} });
      expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'brokered-run', target: unproven, projection: emptyProjection })).toBe(false);
    }
    const mixed = registry.registerRunTarget({ runKey: 'brokered-run', pid: process.pid, materializationKey: 'brokered-run',
      connectedServicesBindingsRaw: { ...bindings, bindingsByServiceId: { ...bindings.bindingsByServiceId,
        'happier.agent.claude/anthropic': { source: 'connected', selection: 'profile', profileId: 'local' },
      } }, connectedServiceSelectionsEnv: {} });
    expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'brokered-run', target: mixed, projection: emptyProjection })).toBe(false);
  });
});
