import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
  type ContributionPolicyFacts,
} from '@happier-dev/protocol/plugins/contributions/policy-evaluation';
import { resolvePluginCommandMetadata, type PluginCommandProjection } from './pluginCommandMetadata';

export type { PluginCommandProjection, PluginCommandProjectionEntry, PluginCommandProjectionDiagnostic } from './pluginCommandMetadata';

export function resolvePluginCommandProjection(params: Readonly<{
  registry: ResolvedContributionRegistry;
  reservedRoots: ReadonlySet<string>;
  facts?: ContributionPolicyFacts;
}>): PluginCommandProjection {
  return resolvePluginCommandMetadata({
    registry: params.registry,
    reservedRoots: params.reservedRoots,
    resolveAvailability: (command) => evaluateContributionAvailability({
      availability: command.definition.availability,
      facts: resolveInvocationContributionPolicyFacts({ facts: params.facts }),
    }),
  });
}
