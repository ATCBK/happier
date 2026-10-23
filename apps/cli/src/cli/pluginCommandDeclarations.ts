import { evaluateContributionAvailability, resolveInvocationContributionPolicyFacts } from '@happier-dev/protocol/plugins/contributions/policy-evaluation';
import type { CanonicalPluginManifest } from '../plugins/manifest/types';
import type { ResolvedContributionProvenance, ResolvedContributionSource } from '../plugins/projection/registry/types';
import { readAgentSessionCapabilities, readAgentExecutionRunCapabilities } from '../plugins/projection/registry/agentContributionDefinition';
import { readAgentCommandTitle } from '../plugins/projection/registry/agentCommandTitle';
import { toCommandDefinition } from '../plugins/projection/registry/normalize/commandDefinition';
import { resolveContributedAgentRoutingId } from '../plugins/projection/registry/agentRoutingIdentity';
import type { BundledPluginCommandMetadata } from './commandDescriptors';

/** The same declaration projection serves publication and admitted local reads. */
export function projectPluginCommandDeclarations(params: Readonly<{
  manifest: CanonicalPluginManifest;
  provenance: ResolvedContributionProvenance;
  source: ResolvedContributionSource;
  bundledAgentId?: string;
}>): BundledPluginCommandMetadata {
  const { manifest, provenance, source } = params;
  return {
    pluginId: manifest.id,
    agents: (manifest.contributes.agents ?? []).flatMap((agent) => {
      if (!readAgentSessionCapabilities(agent) && !readAgentExecutionRunCapabilities(agent)) return [];
      const routingId = params.bundledAgentId ?? resolveContributedAgentRoutingId({ pluginId: manifest.id, localId: agent.id, provenance });
      return [{
        id: routingId,
        cliSubcommand: provenance === 'first_party' ? agent.id : routingId,
        title: agent.cli ? readAgentCommandTitle({ agentId: routingId, title: agent.title, cli: agent.cli }) : routingId,
      }];
    }),
    commands: (manifest.contributes.commands ?? []).map((command) => ({
      pluginId: manifest.id,
      provenance,
      source,
      definition: toCommandDefinition(manifest.id, command),
      availability: evaluateContributionAvailability({ availability: command.availability, facts: resolveInvocationContributionPolicyFacts() }),
    })),
  };
}
