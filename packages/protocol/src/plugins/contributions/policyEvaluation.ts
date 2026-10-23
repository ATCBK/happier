import type { PluginAvailabilityDescriptorV2 } from './publicTypes.js';

export type PluginPolicyExpressionV2 =
  | { fact: string; operator: string; value: boolean | string }
  | { all: PluginPolicyExpressionV2[] }
  | { any: PluginPolicyExpressionV2[] }
  | { not: PluginPolicyExpressionV2 };
export type PluginPolicyFactValueV2 = boolean | string | readonly string[] | undefined;
export type PluginPolicyFactsV2 = Readonly<Record<string, PluginPolicyFactValueV2>>;
export type ContributionAvailabilityOutcome = 'visible' | 'hidden' | 'disabled' | 'unavailable';
export type ContributionAvailabilityDecision = Readonly<{ outcome: ContributionAvailabilityOutcome; code: string }>;
export type ContributionPolicyFacts = PluginPolicyFactsV2;

/** Pure tri-state evaluation; unknown facts remain unknown. */
export function evaluatePluginPolicyExpressionV2(expression: PluginPolicyExpressionV2, facts: PluginPolicyFactsV2): boolean | null {
  if ('all' in expression) {
    let unknown = false;
    for (const child of expression.all) {
      const result = evaluatePluginPolicyExpressionV2(child, facts);
      if (result === false) return false;
      if (result === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in expression) {
    let unknown = false;
    for (const child of expression.any) {
      const result = evaluatePluginPolicyExpressionV2(child, facts);
      if (result === true) return true;
      if (result === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in expression) {
    const result = evaluatePluginPolicyExpressionV2(expression.not, facts);
    return result === null ? null : !result;
  }
  const value = facts[expression.fact];
  if (value === undefined) return null;
  switch (expression.operator) {
    case 'equals': return value === expression.value;
    case 'notEquals': return value !== expression.value;
    case 'enabled':
    case 'contains': return Array.isArray(value) ? value.includes(expression.value as string) : false;
  }
  return null;
}

export function resolveInvocationContributionPolicyFacts(params: Readonly<{
  sessionId?: string;
  projectId?: string;
  browserOrigin?: string;
  hostPlatform?: 'web' | 'ios' | 'android' | 'desktop';
  featureIds?: readonly string[];
  facts?: ContributionPolicyFacts;
}> = {}): ContributionPolicyFacts {
  return Object.freeze({
    'plugin.enabled': true,
    'session.exists': Boolean(params.sessionId),
    'project.exists': Boolean(params.projectId),
    'browser.exists': Boolean(params.browserOrigin),
    'host.platform': params.hostPlatform ?? 'desktop',
    ...(params.featureIds ? { 'host.feature': Object.freeze([...params.featureIds]) } : {}),
    ...(params.projectId ? { 'project.id': params.projectId } : {}),
    ...(params.browserOrigin ? { 'browser.origin': params.browserOrigin } : {}),
    ...(params.facts ?? {}),
  });
}

/** Shared executable-contribution admission; unresolved policy facts fail closed. */
export function evaluateContributionAvailability(params: Readonly<{
  availability: PluginAvailabilityDescriptorV2 | undefined;
  facts: ContributionPolicyFacts;
}>): ContributionAvailabilityDecision {
  const when = params.availability?.when;
  if (when) {
    const result = evaluatePluginPolicyExpressionV2(when, params.facts);
    if (result === null) return Object.freeze({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    if (!result) return Object.freeze({ outcome: 'hidden', code: 'plugin_contribution_not_applicable' });
  }
  const disabledWhen = params.availability?.disabledWhen;
  if (disabledWhen) {
    const result = evaluatePluginPolicyExpressionV2(disabledWhen, params.facts);
    if (result === null) return Object.freeze({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    if (result) return Object.freeze({ outcome: 'disabled', code: 'plugin_contribution_disabled' });
  }
  return Object.freeze({ outcome: 'visible', code: 'plugin_contribution_available' });
}
