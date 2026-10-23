import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ResolvedAgentContribution } from '../types';

export type BundledAgentRegistrationBinding = Readonly<{
    identity: PluginContributionIdentityV1;
    implementationOwnerId: string;
    registrationFamily: string;
}>;

export function manifestAgentKey(pluginId: string, localId: string): string {
    return `${pluginId}\u0000${localId}`;
}

export function indexAgentBindings(bindings: readonly BundledAgentRegistrationBinding[]): Readonly<{
    byIdentity: ReadonlyMap<string, BundledAgentRegistrationBinding>;
    byImplementationOwnerId: ReadonlyMap<string, BundledAgentRegistrationBinding>;
}> {
    const byIdentity = new Map<string, BundledAgentRegistrationBinding>();
    const byAgentId = new Map<string, BundledAgentRegistrationBinding>();
    for (const binding of bindings) {
        if (binding.registrationFamily !== 'agents') continue;
        if (byAgentId.has(binding.implementationOwnerId)) throw new Error(`Duplicate bundled agent implementation binding '${binding.implementationOwnerId}'`);
        const identity = manifestAgentKey(binding.identity.pluginId, binding.identity.localId);
        if (byIdentity.has(identity)) throw new Error(`Duplicate bundled agent registration identity '${binding.identity.pluginId}/${binding.identity.localId}'`);
        byAgentId.set(binding.implementationOwnerId, binding);
        byIdentity.set(identity, binding);
    }
    return Object.freeze({ byIdentity, byImplementationOwnerId: byAgentId });
}

/** Canonical bundled identity overlay; private runtime compatibility stays outside it. */
export function projectBuiltInAgentFields(manifestContribution: ResolvedAgentContribution, canonicalAgentId: string): ResolvedAgentContribution {
    const richDefinition = manifestContribution.richDefinition ? Object.freeze({
        ...manifestContribution.richDefinition,
        definition: Object.freeze({ ...manifestContribution.richDefinition.definition, id: canonicalAgentId }),
    }) : undefined;
    return Object.freeze({
        ...manifestContribution,
        id: canonicalAgentId,
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: Object.freeze({ ...manifestContribution.definition, id: canonicalAgentId }),
        richDefinition,
        runtimeSpec: manifestContribution.runtimeSpec ? Object.freeze({ ...manifestContribution.runtimeSpec, id: canonicalAgentId }) : null,
    });
}
