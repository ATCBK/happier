import type { PluginMachineMaterializationV1, PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { projectVerifiedPluginUiReleaseSlotsV2 } from './releaseFacts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginRegistryAvailabilityInventory } from '@/plugins/store/registry/currentState';

/** Completes the persisted installation census from the corresponding admitted source registry. */
export function projectPluginInstalledAvailabilityInventory(input: Readonly<{
    inventory: PluginRegistryAvailabilityInventory;
    registry: ResolvedContributionRegistry | null;
    registryRevision: number | null;
    runtimeMaterializations: readonly NonNullable<ReleaseLessPluginDeclaration['runtimeMaterialization']>[];
}>): PluginRegistryAvailabilityInventory {
    if (!input.registry || input.registryRevision !== input.inventory.revision) {
        // A full report removes omitted installations. An absent or stale
        // source registry cannot establish those removal observations.
        throw new Error('Current installed plugin source census is unavailable');
    }
    const recorded = new Set(input.inventory.materializations.map(materialization => materialization.pluginId));
    const runtime = input.runtimeMaterializations.filter(materialization => !recorded.has(materialization.pluginId));
    // A recorded release-less installation (a registered local folder) has no release to declare it; the
    // serving source's manifest of the same version is its declaration, as for runtime-only materializations.
    const servedManifests = new Map((input.registry.pluginDeclarations ?? []).map(entry => [entry.pluginId, entry.manifest] as const));
    const declared = input.inventory.materializations.map((materialization) => {
        const manifest = materialization.portableRelease || materialization.declaredManifest
            ? undefined : servedManifests.get(materialization.pluginId);
        return manifest && manifest.version === materialization.version
            ? Object.freeze({ ...materialization, declaredManifest: manifest })
            : materialization;
    });
    const materializations = [...declared, ...runtime];
    return Object.freeze({
        ...input.inventory,
        materializations: Object.freeze(materializations.sort((left, right) => left.materializationId.localeCompare(right.materializationId))),
    });
}

/**
 * One admitted installed source's release-less declaration. Every selected
 * source is observed, including UI-only sources; only Account-scoped executable
 * contribution families request the existing Account declaration claim.
 */
export type ReleaseLessPluginDeclaration = Readonly<{
    manifest: CanonicalPluginManifest;
    materializationId: string;
    /** Installation observation does not itself request enabled Account policy. */
    claimsAccountIntent: boolean;
    /**
     * The machine materialization this runtime reports itself. Null when the
     * install registry already records and reports the plugin (a registered
     * development root).
     */
    runtimeMaterialization: Omit<
        PluginMachineMaterializationV1,
        'serverIdentityId' | 'machineId'
    > | null;
}>;

/**
 * Only the Account-scoped contributions the server gates on a declaration
 * make a plugin claim: Collections, webhooks, Events, and Machine provisioners.
 * Preset and acquisition admission resolve provisioners through that declaration.
 */
function declaresAccountScopedContributions(manifest: CanonicalPluginManifest): boolean {
    return manifest.contributes.accountCollections.length > 0
        || manifest.contributes.webhooks.length > 0
        || manifest.contributes.events.length > 0
        || manifest.contributes.machineProvisioners.length > 0;
}

/** Stable per machine and plugin, so a CLI update keeps its webhook targets. */
function runtimeMaterializationId(pluginId: string): string {
    return `daemon-selected:${pluginId}`;
}

export function projectReleaseLessPluginDeclarations(input: Readonly<{
    activationTargets: readonly Readonly<{
        pluginId: string;
        manifest: CanonicalPluginManifest;
        sourceSpec?: PluginSourceSpecV1;
        generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
    }>[];
    sourceCustodiesByPluginId: ReadonlyMap<string, PluginSourceCustody>;
    registryMaterializationIdsByPluginId: Readonly<Record<string, string>>;
    observedAt: number;
}>): ReadonlyMap<string, ReleaseLessPluginDeclaration> {
    const declarations = new Map<string, ReleaseLessPluginDeclaration>();
    for (const target of input.activationTargets) {
        const custody = input.sourceCustodiesByPluginId.get(target.pluginId);
        if (custody?.kind === 'managed') continue;
        const sourceClass = custody?.kind === 'bundled_first_party' || target.sourceSpec?.kind === 'bundled'
            ? 'bundledFirstParty' as const
            : custody?.kind === 'development' || target.sourceSpec?.kind === 'path'
                ? 'localPath' as const : null;
        if (!sourceClass) continue;
        const registryMaterializationId = input.registryMaterializationIdsByPluginId[target.pluginId];
        const materializationId = registryMaterializationId ?? runtimeMaterializationId(target.pluginId);
        declarations.set(target.pluginId, Object.freeze({
            manifest: target.manifest,
            materializationId,
            claimsAccountIntent: custody !== undefined && declaresAccountScopedContributions(target.manifest),
            runtimeMaterialization: registryMaterializationId !== undefined
                ? null
                : Object.freeze({
                    materializationId,
                    pluginId: target.pluginId,
                    version: target.manifest.version,
                    sourceClass,
                    declaredManifest: target.manifest,
                    portableRelease: false,
                    uiArtifacts: Object.freeze(target.generatedUiArtifactsManifest
                        ? projectVerifiedPluginUiReleaseSlotsV2({ manifest: target.manifest, generatedUiArtifacts: target.generatedUiArtifactsManifest })
                        : []),
                    enabled: true,
                    // Reading an installed manifest is not source admission.
                    // Persisted installed rows carry their actual trust above;
                    // an unrecorded metadata-only source has no admitted custody.
                    trustState: custody ? 'trusted' as const : 'untrusted' as const,
                    observedAt: input.observedAt,
                }),
        }));
    }
    return declarations;
}
