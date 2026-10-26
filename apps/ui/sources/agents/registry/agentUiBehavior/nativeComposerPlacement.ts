import { listAgentUniverseIds } from '@/agents/catalog/agentUniverse';
import type { AgentInputControlPlacement, AgentInputPlacementContext } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { listProjectedAgentUiBehaviorIds } from '../agentUiBehaviorProjection';
import { resolveAgentUiBehavior } from '../registryUiBehavior';
import { getBooleanOptionActionChipPlacement } from './booleanOptionChipPlacement';

type NativeComposerPlacementDefinition = Readonly<{
    controlId: 'providerOption';
    placement: AgentInputControlPlacement;
    contexts: readonly AgentInputPlacementContext[];
}>;

/** On-demand metadata over the generated inventory and current already-held Account declarations. */
export function readNativeAgentComposerPlacementDefinitions(
    accountScope?: ServerAccountScope | null,
): readonly NativeComposerPlacementDefinition[] {
    const agentIds = new Set([...listAgentUniverseIds(), ...listProjectedAgentUiBehaviorIds(accountScope)]);
    const definitions = new Map<string, NativeComposerPlacementDefinition>();
    for (const agentId of agentIds) {
        const behavior = resolveAgentUiBehavior(agentId, undefined, accountScope);
        for (const definition of behavior.newSession?.agentInputExtraActionChipDefinitions ?? []) {
            const placement = getBooleanOptionActionChipPlacement(definition);
            definitions.set(placement.id, { controlId: 'providerOption', placement, contexts: ['newSession'] });
        }
    }
    return [...definitions.values()];
}
