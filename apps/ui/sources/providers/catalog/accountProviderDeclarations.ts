import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import {
    BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS,
    BUNDLED_CANONICAL_AGENT_DECLARATIONS,
} from '@/agents/registry/generatedBundledPluginEntries';

const providerDeclarations: readonly AccountProviderDeclarationV1[] = Object.freeze(Object.values(BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS));

/** Admitted portable source facts only. Dynamic plugins need their current declaration authority. */
export function readAccountProviderDeclarations(): readonly AccountProviderDeclarationV1[] {
    return providerDeclarations;
}

/**
 * The model-picker kind of a saved connection's source: `custom`, or its admitted declaration's kind.
 * Without an admitted declaration there is no kind, so no default is guessed from a name or count.
 */
export function readProviderConnectionPickerKind(source: ProviderConnectionV1['source'] | undefined): ProviderModelPickerSourceKind | undefined {
    if (source?.kind === 'custom') return 'custom';
    if (source?.kind !== 'contribution') return undefined;
    return providerDeclarations.find(declaration =>
        areProviderContributionKeysEqualV1(declaration.contributionKey, source.contributionKey))?.definition.kind;
}

/** A contribution's fallback icon token; packaged brands resolve from the plugin identity. */
export function readProviderContributionIcon(contributionKey: string | null | undefined): string | null {
    if (!contributionKey) return null;
    return providerDeclarations.find(declaration =>
        areProviderContributionKeysEqualV1(declaration.contributionKey, contributionKey))?.definition.icon ?? null;
}

export function readAccountAgentProviderRequirements(agentTargetKey: string): AgentProviderRequirementsV1 | null {
    let target: ReturnType<typeof parseBackendTargetKeyV2>;
    try { target = parseBackendTargetKeyV2(agentTargetKey); } catch { return null; }
    if (target.kind === 'agent') {
        if (target.definitionId !== undefined) return null;
        return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(declaration =>
            declaration.identity.pluginId === target.identity.pluginId
            && declaration.identity.localId === target.identity.localId)?.providerRequirements ?? null;
    }
    if (target.configuredBackendId !== undefined || target.sourceKind === 'configured') return null;
    return Object.entries(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(([routingId]) => routingId === target.backendId)
        ?.[1]?.providerRequirements ?? null;
}
