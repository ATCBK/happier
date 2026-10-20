import { describe, expect, it } from 'vitest';

import {
  evaluateContributionAvailability,
  evaluatePluginPolicyExpressionV2,
  PluginAvailabilityDescriptorV2Schema,
  PluginPolicyExpressionV2Schema,
  resolveInvocationContributionPolicyFacts,
} from './publicTypes.js';

describe('PluginPolicyExpressionV2', () => {
  it('evaluates tri-state boolean algebra in the Protocol owner', () => {
    const expression = PluginPolicyExpressionV2Schema.parse({
      all: [
        { fact: 'host.platform', operator: 'equals', value: 'web' },
        { any: [
          { fact: 'host.feature', operator: 'enabled', value: 'preview' },
          { fact: 'session.exists', operator: 'equals', value: true },
        ] },
      ],
    });

    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'web',
      'host.feature': ['preview'],
      'session.exists': false,
    })).toBe(true);
    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'web',
      'session.exists': false,
    })).toBe(null);
    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'ios',
    })).toBe(false);
  });

  it('keeps unknown facts distinct from false and applies not through tri-state', () => {
    expect(evaluatePluginPolicyExpressionV2(
      { not: { fact: 'session.capability', operator: 'contains', value: 'voice' } },
      {},
    )).toBe(null);
    expect(evaluatePluginPolicyExpressionV2(
      { not: { fact: 'session.capability', operator: 'contains', value: 'voice' } },
      { 'session.capability': [] },
    )).toBe(true);
  });
});

describe('contribution availability', () => {
  it('uses explicit portable-host facts without inventing Machine or Session authority', () => {
    const availability = PluginAvailabilityDescriptorV2Schema.parse({
      when: { all: [
        { fact: 'plugin.enabled', operator: 'equals', value: true },
        { fact: 'host.platform', operator: 'notEquals', value: 'desktop' },
        { fact: 'session.exists', operator: 'equals', value: false },
      ] },
    });
    const facts = resolveInvocationContributionPolicyFacts({ hostPlatform: 'ios' });
    expect(evaluateContributionAvailability({ availability, facts }))
      .toEqual({ outcome: 'visible', code: 'plugin_contribution_available' });
    expect(evaluateContributionAvailability({
      availability: { when: { fact: 'machine.id', operator: 'notEquals', value: 'offline' } },
      facts,
    })).toEqual({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    expect(evaluateContributionAvailability({
      availability,
      facts: resolveInvocationContributionPolicyFacts(),
    })).toEqual({ outcome: 'hidden', code: 'plugin_contribution_not_applicable' });
  });

  it('keeps missing facts fail-closed and respects predicate precedence', () => {
    const availability = PluginAvailabilityDescriptorV2Schema.parse({
      when: { fact: 'plugin.enabled', operator: 'equals', value: true },
      disabledWhen: { fact: 'session.state', operator: 'equals', value: 'blocked' },
      disabledReason: 'Blocked session',
    });
    expect(evaluateContributionAvailability({ availability, facts: {} }))
      .toEqual({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    expect(evaluateContributionAvailability({ availability, facts: { 'plugin.enabled': false } }))
      .toEqual({ outcome: 'hidden', code: 'plugin_contribution_not_applicable' });
    expect(evaluateContributionAvailability({ availability, facts: { 'plugin.enabled': true } }))
      .toEqual({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    expect(evaluateContributionAvailability({
      availability, facts: { 'plugin.enabled': true, 'session.state': 'blocked' },
    })).toEqual({ outcome: 'disabled', code: 'plugin_contribution_disabled' });
    expect(evaluateContributionAvailability({ availability: undefined, facts: {} }))
      .toEqual({ outcome: 'visible', code: 'plugin_contribution_available' });
  });
});
