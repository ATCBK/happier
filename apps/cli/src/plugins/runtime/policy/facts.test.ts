import { describe, expect, it } from 'vitest';

import { evaluatePluginFinalPolicy } from '@happier-dev/protocol';
import { createPluginRuntimeOccurrenceId } from '../runtimeSlots';

import {
  resolvePluginFinalPolicyAuthorizationFacts,
  resolveRequiredPluginNetworkOrigins,
} from './facts';

const currentOccurrenceId = createPluginRuntimeOccurrenceId('occurrence-7');
const current = Object.freeze({
  occurrenceId: currentOccurrenceId,
  sourceCustody: Object.freeze({
    kind: 'managed' as const,
    immutableGenerationId: 'generation-7',
    installSource: 'npm' as const,
  }),
  desiredOccurrenceId: currentOccurrenceId,
  appliedOccurrenceId: currentOccurrenceId,
  applied: true,
  selectedAccess: Object.freeze([]),
});

describe('resolvePluginFinalPolicyAuthorizationFacts', () => {
  it('admits a current cold declaration while execution still requires the applied occurrence', () => {
    const cold = { ...current, appliedOccurrenceId: null, applied: false };
    const declaration = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin', current: cold, purpose: 'declaration',
    });
    const evaluate = (facts: typeof declaration) => evaluatePluginFinalPolicy({
      ...facts, serviceAvailability: [], currentIntent: 'notRequired',
    });
    expect(declaration.generation.appliedGeneration).toBeNull();
    expect(evaluate(declaration)).toMatchObject({ outcome: 'visible' });
    expect(evaluate(resolvePluginFinalPolicyAuthorizationFacts({ pluginId: 'acme.plugin', current: cold })))
      .toMatchObject({ outcome: 'unavailable', code: 'plugin_final_generation_not_applied' });
    expect(evaluate(resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin', current: { ...cold, desiredOccurrenceId: null }, purpose: 'declaration',
    }))).toMatchObject({ outcome: 'unavailable', code: 'plugin_final_generation_retired' });
  });
  it('binds every consumer to the direct applied generation without package-trust copies', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current,
    });

    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'visible', code: 'plugin_final_available' });
    expect(authorization).not.toHaveProperty('packageTrust');
  });

  it('keeps a retained target generation distinct from durable desired and applied facts', () => {
    const desiredOccurrenceId = createPluginRuntimeOccurrenceId('occurrence-8');
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current: {
        ...current,
        desiredOccurrenceId,
        appliedOccurrenceId: currentOccurrenceId,
      },
      targetGenerationMode: 'retained',
    });

    expect(authorization.generation).toEqual({
      targetGeneration: currentOccurrenceId,
      desiredGeneration: desiredOccurrenceId,
      appliedGeneration: currentOccurrenceId,
      targetGenerationMode: 'retained',
    });
    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'visible', code: 'plugin_final_available' });
  });

  it('fails closed when a direct current generation is unavailable', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current: null,
    });

    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'unavailable', code: 'plugin_final_generation_retired' });
  });

  it('projects network disclosure only from required manifest configuration', () => {
    const required = [{
      id: 'model-download',
      capability: 'network' as const,
      reason: 'Download the selected model',
      scope: { targets: [{ kind: 'fixedOrigin' as const, origin: 'https://models.example.test' }] },
    }];

    expect(resolveRequiredPluginNetworkOrigins({
      required,
    })).toEqual(['https://models.example.test']);
  });
});
