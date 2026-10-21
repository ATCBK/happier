import type {
    PackageAssetArchiveDescriptorV1,
    PluginAccountAvailabilityIntentReadResponseV1,
    PluginMachineMaterializationSnapshotV1,
    PluginMachineMaterializationV1,
    PluginMachineMaterializationRefV1,
    PluginPortableReleaseManifestV1,
    PluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    normalizePluginReleaseFactsV1,
    PluginPortableReleaseManifestV1Schema,
    resolvePluginAccountExecutionSelectionV1,
    computePluginAccountBundledDeclarationDigestV1,
    computePluginAccountBundledCustodyIdV1,
    type PluginAccountExecutionSelectionV1,
} from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema, isPluginUiHostApiVersionCompatibleWithVersionV1, PLUGIN_UI_HOST_API_VERSION_V1,
    type PluginUiArtifactsManifestEntryV2, type PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectPluginReactNativeArtifactEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import type { PluginActionContributionV2, PluginCollectionContractRefV1 } from '@happier-dev/protocol';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginDeclaredUiEntriesV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { normalizePluginInstalledUiDeclarations, type PluginUiActionProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';
export type { PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';

export type PluginAccountExecutionAdmission = PluginAccountExecutionSelectionV1 | Readonly<{
    kind: 'unavailable';
    code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch';
}>;

/** Reads the admitted schema declaration carried by the existing Action projection. */
export function readPluginUiAccountActionDeclaration(action: PluginUiActionProjection): PluginActionContributionV2 | null {
    const manifest = PluginPortableReleaseManifestV1Schema.safeParse(action.hostAccountDeclaration);
    const origin = action.hostAccountOrigin;
    if (!manifest.success || manifest.data.id !== action.pluginId || action.execution.target !== 'account'
        || !origin || typeof origin !== 'object' || Array.isArray(origin)
        || (origin as Readonly<Record<string, unknown>>).custodyId !== action.occurrenceId) return null;
    const matches = manifest.data.contributes.actions?.filter(candidate => candidate.id === action.id
        && candidate.execution.target === 'account' && sameStrictJsonValue(candidate.execution, action.execution)) ?? [];
    return matches.length === 1 ? matches[0]! : null;
}

export type PluginAccountAvailabilitySnapshot = Readonly<{
    /** The canonical AccountChange ordering fact for this complete projection. */
    availabilityCursor: number;
    /**
     * Exact responses from the canonical Availability intent-read operation,
     * bound to the requested plugin id. This UI projection does not invent an
     * Artifact state: current Artifact facts are derived from its intent,
     * selected release, and qualified Account-hosted link.
     */
    intentReads: readonly PluginAccountAvailabilityIntentReadProjection[];
    /**
     * Presentation/correspondence evidence for Administration. This inventory
     * does not itself grant execution authority or choose an execution source.
     */
    materializations: readonly PluginMachineMaterializationV1[];
    /** Complete per-machine inventory facts, including exact empty reports. */
    snapshots: readonly PluginMachineMaterializationSnapshotV1[];
    /** False means omitted machines are unknown, rather than uninstalled. */
    inventoryComplete?: boolean;
    /** Exact immutable installed release facts, not enabled selection intent. */
    releases?: readonly PluginReleaseFactsV1[];
}>;

/** The host's validated first-party declaration custody, never a machine occurrence. */
export function readHostBundledPluginUiDeclarations(inventory: BundledPluginUiAppArtifactInventory): readonly PluginHostBundledUiDeclaration[] {
    const byPluginId = new Map<string, PluginHostBundledUiDeclaration>();
    for (const row of inventory) {
        const declaration = row.uiDeclaration;
        if (byPluginId.has(row.pluginId)) continue;
        const parsed = PluginDeclaredUiEntriesV1Schema.safeParse(declaration?.entriesById);
        if (!parsed.success || declaration?.pluginId !== row.pluginId || declaration.pluginVersion !== row.releaseVersion
            || typeof declaration.packageName !== 'string' || declaration.packageName.trim().length === 0
            || !row.artifactGraph || row.artifactGraph.digest !== row.digest
            || row.artifactGraph.artifactId !== row.artifactId || row.artifactGraph.tier !== row.tier) continue;
        byPluginId.set(row.pluginId, Object.freeze({ ...declaration, entriesById: parsed.data }));
    }
    return Object.freeze([...byPluginId.values()]);
}

export type PluginAccountInstalledPluginInstallation = Readonly<{
    materialization: PluginMachineMaterializationV1;
    declaration: PluginPortableReleaseManifestV1 | null;
    declarationState: 'known' | 'preparing';
    /** Manifest knowledge alone does not prove projected renderer descriptors. */
    uiDeclarationState: 'known' | 'preparing';
    release: PluginReleaseFactsV1 | null;
    execution: PluginAccountAvailabilityReleaseClassificationV1;
    uiModel: PluginUiProjectionModel;
}>;

export type PluginAccountInstalledPluginsAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        completeness: 'complete' | 'incomplete';
        plugins: readonly Readonly<{ pluginId: string; installations: readonly PluginAccountInstalledPluginInstallation[] }>[];
    }>
    | Extract<PluginMachineMaterializationAdmission, { kind: 'unavailable' }>;

export type PluginAccountAvailabilityIntentReadProjection = Readonly<{
    pluginId: string;
    response: PluginAccountAvailabilityIntentReadResponseV1;
}>;

export type PluginAccountAvailabilityArtifactSlot = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
}>;

/** Immutable release-selected bytes facts, independent of any source link. */
export type PluginAccountAvailabilitySelectedArtifactFact = PluginAccountAvailabilityArtifactSlot & Readonly<{
    artifactId: string;
    digest: PluginUiArtifactDigestV1;
    hostUiApiRange: string;
    releaseVersion: string;
}>;

/** Source-local Account-hosted link provenance; never a selected-byte identity. */
export type PluginAccountAvailabilityArtifactSourceFact =
    | Readonly<{
        accountArtifactId?: never;
    }>
    | Readonly<{
        accountArtifactId: string;
    }>;

export type PluginAccountAvailabilityArtifactFact = PluginAccountAvailabilitySelectedArtifactFact
    & PluginAccountAvailabilityArtifactSourceFact;

/**
 * Exact non-portable Artifact selected by an admitted daemon projection.
 * Account disable and portable release intent retain precedence; the source
 * supplies its own occurrence currentness, never Account authority.
 */
export type PluginDaemonProjectionArtifactSelection = Readonly<{
    occurrenceId: string;
    artifact: PluginAccountAvailabilityArtifactFact;
    isCurrent: () => boolean;
}>;

/**
 * Availability's Account-release correspondence for one machine report. The
 * immutable Account release is the only content owner; the report carries its
 * exact producer-bound facts, while Administration remains the only owner of
 * exact-machine selection and local reachability.
 */
export type PluginAccountAvailabilityReleaseClassificationV1 = Readonly<{
    /**
     * Exact producer identity retained beside release validation. Consumers
     * must carry this through selection; they must not reconstruct it from a
     * machine id or a plugin id after the fact.
     */
    serverIdentityId: string;
    materializationRef: PluginMachineMaterializationRefV1;
    releaseContent: 'matched' | 'conflict' | 'unknown';
    validation:
        | Readonly<{ kind: 'admitted' }>
        | Readonly<{
            kind: 'rejected';
            reason: 'disabled' | 'plugin_mismatch' | 'release_unavailable' | 'non_portable';
        }>;
}>;

export function projectPluginAccountAvailabilityMaterializationIdentity(
    materialization: PluginMachineMaterializationV1,
): Pick<
    PluginAccountAvailabilityReleaseClassificationV1,
    'serverIdentityId' | 'materializationRef'
> {
    return Object.freeze({
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        }),
    });
}

export type PluginMachineMaterializationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        /** Existing Account projection truth consumed by Administration. */
        intentReads: readonly PluginAccountAvailabilityIntentReadProjection[];
        materializations: readonly PluginMachineMaterializationV1[];
        snapshots: readonly PluginMachineMaterializationSnapshotV1[];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch';
    }>;

export type PluginAccountAvailabilityArtifactAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        artifact: PluginAccountAvailabilityArtifactFact;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/** The Protocol-owned declared release slot, snapshotted by this projection. */
export type PluginAccountAvailabilityReleaseUiSlot =
    NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['uiSlots'][number];

/**
 * The exact immutable coordinates one present client may publish for. The
 * declared slot carries its portable compatibility so the publisher compares
 * the host's own adoption facts against it instead of restating them.
 */
export type PluginAccountAvailabilityHostedPublicationTarget = Readonly<{
    release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
    slot: PluginAccountAvailabilityReleaseUiSlot;
}>;

export type PluginAccountAvailabilityHostedPublicationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        target: PluginAccountAvailabilityHostedPublicationTarget;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'artifact_hosting_not_admitted'
            | 'artifact_already_hosted';
    }>;

export type PluginAccountAvailabilityHostedPackageAssetPublicationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        target: Readonly<{
            release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            normalizedManifest: PluginPortableReleaseManifestV1;
            descriptor: PackageAssetArchiveDescriptorV1;
        }>;
    }>
    | Extract<PluginAccountAvailabilityHostedPublicationAdmission, { kind: 'unavailable' }>;

/**
 * Immutable package-asset facts selected by the current Account release. This
 * carries no Artifact id, transport, cache location, or daemon authority.
 */
export type PluginAccountAvailabilityPackageAssetFact = Readonly<{
    pluginId: string;
    releaseVersion: string;
    descriptor: PluginAccountAvailabilityPackageAssetDescriptor;
}>;

/**
 * The projection retains a deep immutable snapshot of Protocol-owned release
 * facts. It is not another descriptor grammar or byte/cache owner.
 */
export type PluginAccountAvailabilityPackageAssetDescriptor = Readonly<{
    archiveDigestSha256: PackageAssetArchiveDescriptorV1['archiveDigestSha256'];
    resources: readonly Readonly<PackageAssetArchiveDescriptorV1['resources'][number]>[];
}>;

export type PluginAccountAvailabilityPackageAssetAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        packageAsset: PluginAccountAvailabilityPackageAssetFact;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/**
 * Availability admits an immutable contract reference only. The persisted
 * normalized contract remains Data-owned and is read through the authenticated
 * Data route after this projection has selected the ref.
 */
export type PluginAccountAvailabilityCollectionContractAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        ref: PluginCollectionContractRefV1;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'collection_not_current'
            | 'collection_slot_ambiguous';
    }>;

/**
 * An opaque current-release fact for renderer admission. It answers only
 * whether the enabled release admits direct Account Data through an exact
 * Collection contract or required Account-KV access; callers receive neither
 * declarations nor mutation authority. Exact contract selection and CAS
 * remain with the Data owner.
 */
export type PluginAccountAvailabilityDataCapabilityAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'account_data_not_current';
    }>;

/**
 * Current admission for the Account KV operation surface. A selected release
 * admits KV only through its explicit required `storage.account` declaration
 * (its Collection contracts do not satisfy it); a release-less daemon claim
 * admits the claiming plugin's own KV.
 */
export type PluginAccountAvailabilityAccountKvAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'account_kv_not_current';
    }>;

/**
 * The normalized release declaration can admit Account Settings recovery even
 * while activation is disabled. It neither re-enables a plugin nor conveys a
 * daemon projection, machine selection, or execution capability.
 */
export type PluginAccountAvailabilitySettingsDeclarationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        declaration: PluginPortableReleaseManifestV1;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/**
 * The exact present-user Account intent/release pairing consumed by a release
 * selection CAS. It deliberately remains available while `intent.enabled` is
 * false: selection needs its optimistic revision and current source contract,
 * whereas ordinary renderer/Data admission remains enabled-only.
 */
export type PluginAccountAvailabilityReleaseSelectionAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: Readonly<{
            ref: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            normalizedManifest: PluginPortableReleaseManifestV1;
        }>;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

export type PluginAccountAvailabilityHostedArtifactAdministrationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        hostingCapability: PluginAccountAvailabilityIntentReadResponseV1['hostingCapability'];
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: Readonly<{
            ref: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            uiSlots: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['uiSlots'];
            packageAssetArchive: PackageAssetArchiveDescriptorV1;
        }>;
        uiArtifacts: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'];
        packageAssets: PluginAccountAvailabilityIntentReadResponseV1['packageAssets'];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch' | 'artifact_not_current' | 'artifact_slot_ambiguous';
    }>;

export type PluginAccountAvailabilityReader = Readonly<{
    /** Account custody projects into the existing executable registration owner. */
    readAccountUiProjection: () => PluginUiProjectionModel | null;
    readCurrentAccountExecution: (pluginId: string) => PluginAccountExecutionAdmission;
    /** Current enabled declarations, including descriptive Machine-placed sources. */
    readCurrentAccountExecutionDeclarations: () => readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[];
    /**
     * Current expected Artifact identity only. This is intentionally not a
     * byte-source selector: URLs, cache state, source priority, and transport
     * remain private to the Artifact adoption/cache owner.
     * An exact installed origin can admit its census release when the Account
     * explicitly has no selection; it never selects a global release.
     */
    readCurrentArtifact: (
        slot: PluginAccountAvailabilityArtifactSlot,
        executionOrigin?: PluginMachineExecutionOriginV1 | null,
        daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection,
    ) => PluginAccountAvailabilityArtifactAdmission;
    /**
     * Admits one exact declared slot for present-client Account-hosted
     * publication. It is available only while the operator capability, the
     * Account opt-in, and the current release admit hosting and no exact
     * qualified link exists yet. It grants no byte source and no transport.
     */
    readCurrentHostedPublicationTarget: (
        slot: PluginAccountAvailabilityArtifactSlot,
    ) => PluginAccountAvailabilityHostedPublicationAdmission;
    /** Same hosting intent, for the selected release's declared packaged assets. */
    readCurrentHostedPackageAssetPublicationTarget: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityHostedPackageAssetPublicationAdmission;
    /**
     * Current immutable package-asset declaration for one enabled release.
     * Stored-envelope access remains with the protected Account source.
     */
    readCurrentPackageAsset: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityPackageAssetAdmission;
    /**
     * Current release admission for one collection's immutable Data ref. This
     * reader never carries the reconstructed normalized contract or chooses a
     * Data transport.
     */
    readCurrentCollectionContract: (input: Readonly<{
        pluginId: string;
        collectionId: string;
        /** Exact retained ref requested by an already-mounted release. */
        ref?: PluginCollectionContractRefV1;
    }>) => PluginAccountAvailabilityCollectionContractAdmission;
    /**
     * Current enabled-release capability for direct Account Data UI. This is
     * intentionally an opaque presence fact, not a reconstructed declaration,
     * contract inventory, or mutation authorization.
     */
    readCurrentAccountDataCapability: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityDataCapabilityAdmission;
    /**
     * Current enabled-release admission for Account KV operations. This is
     * re-read for every operation and conveys no Collection authority.
     */
    readCurrentAccountKvCapability: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityAccountKvAdmission;
    /**
     * Reads the current normalized release declaration for Account-only
     * Settings recovery. Activation remains a separate daemon concern.
     */
    readCurrentSettingsDeclaration: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilitySettingsDeclarationAdmission;
    /**
     * Admits the exact current source intent/release for a present-user
     * Account release-selection CAS. It is not Artifact admission and grants
     * neither a byte source nor a Data read/write capability.
     */
    readCurrentReleaseSelection: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityReleaseSelectionAdmission;
    /** Current exact facts for the existing plugin-detail hosted Artifact controller. */
    readCurrentHostedArtifactAdministration: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityHostedArtifactAdministrationAdmission;
    /**
     * Validates immutable Account release facts against a materialization's
     * explicit correspondence/status. It cannot select a machine or infer
     * transport/source authority.
     */
    classifyRelease: (
        materialization: PluginMachineMaterializationV1,
    ) => PluginAccountAvailabilityReleaseClassificationV1;
    readMaterializations: () => PluginMachineMaterializationAdmission;
    /** Descriptive installation census, independent of enabled Account intent. */
    readInstalledPlugins: () => PluginAccountInstalledPluginsAdmission;
    /**
     * A lifecycle signal only. Consumers re-read through this owner; they
     * never receive a raw snapshot or a second currentness owner.
     */
    subscribe: (listener: () => void) => () => void;
}>;

export type PluginAccountAvailabilityReaderStore = Readonly<{
    replace: (input: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
        failedPluginIds?: readonly string[];
        intentCensusIncomplete?: boolean;
    }>) => PluginAccountAvailabilityStoredProjection | null;
    clear: () => PluginAccountAvailabilityStoredProjection | null;
    /**
     * Explicit withdrawal (local disable/uninstall/revoke): removes the named
     * plugins' release facts so their mounted authority retires immediately.
     * A failed refresh is not withdrawal; it only flags the plugin stale.
     */
    retire: (pluginIds: readonly string[]) => void;
    /** Stable immutable snapshot for the projection owner's React subscription. */
    getSnapshot: () => PluginAccountAvailabilityStoredProjection | null;
    subscribe: (listener: () => void) => () => void;
    /**
     * Binds a caller to one Account/realm without disclosing that scope to a
     * renderer. If this store moves to another Account, the retained reader is
     * typed unavailable instead of reading the new Account's projection.
     */
    bind: (scope: ServerAccountScope) => PluginAccountAvailabilityReader;
}>;

/**
 * The immutable projection exposed only to its lifecycle/React owner. Readers
 * still expose facts, not raw Availability snapshots, to their consumers.
 */
export type PluginAccountAvailabilityStoredProjection = Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    /**
     * Plugins whose last refresh failed. Their last-confirmed facts remain
     * readable and current (AVD-07); this is refresh status only.
     */
    stalePluginIds: readonly string[];
    retiredPluginIds?: readonly string[];
}>;

type AvailabilityProjectionState = PluginAccountAvailabilityStoredProjection;

/** React observation only; bound reader methods always inspect the current owner state. */
export function arePluginAvailabilityObservationsEqual(
    previous: PluginAccountAvailabilityStoredProjection | null,
    next: PluginAccountAvailabilityStoredProjection | null,
    pluginId: string,
): boolean {
    if (previous === next) return true;
    if (!previous || !next || !areServerAccountScopesEqual(previous.scope, next.scope)) return false;
    return previous.snapshot.inventoryComplete === next.snapshot.inventoryComplete
        && previous.stalePluginIds.includes(pluginId) === next.stalePluginIds.includes(pluginId)
        && (previous.retiredPluginIds?.includes(pluginId) ?? false) === (next.retiredPluginIds?.includes(pluginId) ?? false)
        && sameStrictJsonValue(previous.snapshot.intentReads.filter(row => row.pluginId === pluginId),
            next.snapshot.intentReads.filter(row => row.pluginId === pluginId))
        && sameStrictJsonValue(previous.snapshot.materializations.filter(row => row.pluginId === pluginId),
            next.snapshot.materializations.filter(row => row.pluginId === pluginId))
        && sameStrictJsonValue(previous.snapshot.releases?.filter(row => row.ref.pluginId === pluginId) ?? [],
            next.snapshot.releases?.filter(row => row.ref.pluginId === pluginId) ?? [])
        // Empty/replaced Machine reports still affect discovery and admission.
        && sameStrictJsonValue(previous.snapshot.snapshots, next.snapshot.snapshots);
}

// The owner snapshots these rows immutably. Index their exact identities once
// per snapshot: origin selection classifies every installation and must not
// rescan the complete fleet for each one. Keep duplicate rows so ambiguity
// still refuses admission; replacement/retirement owns a different snapshot.
const materializationsBySnapshot = new WeakMap<PluginAccountAvailabilitySnapshot,
    ReadonlyMap<string, readonly PluginMachineMaterializationV1[]>>();

function materializationLookupKey(input: Pick<PluginMachineMaterializationV1,
    'pluginId' | 'serverIdentityId' | 'machineId' | 'materializationId'>): string {
    return JSON.stringify([input.pluginId, input.serverIdentityId, input.machineId, input.materializationId]);
}

function readMaterializationsByIdentity(snapshot: PluginAccountAvailabilitySnapshot) {
    const existing = materializationsBySnapshot.get(snapshot);
    if (existing) return existing;
    const indexed = new Map<string, PluginMachineMaterializationV1[]>();
    for (const row of snapshot.materializations) {
        const key = materializationLookupKey(row);
        const rows = indexed.get(key);
        if (rows) rows.push(row);
        else indexed.set(key, [row]);
    }
    materializationsBySnapshot.set(snapshot, indexed);
    return indexed;
}

/**
 * Protocol response types retain mutable-array annotations even though this
 * reader owns an immutable in-memory snapshot. Freeze in place and preserve
 * that external structural type instead of leaking a second readonly model.
 */
function freezeAvailabilitySnapshotValue<T extends object>(value: T): T {
    Object.freeze(value);
    return value;
}

function cloneMaterialization(
    materialization: PluginMachineMaterializationV1,
): PluginMachineMaterializationV1 {
    return freezeAvailabilitySnapshotValue({
        ...materialization,
        ...(materialization.declaredManifest ? {
            declaredManifest: freezeDeepDeclaration(PluginPortableReleaseManifestV1Schema.parse(materialization.declaredManifest)),
        } : {}),
        ...(materialization.declaredUiEntries ? {
            declaredUiEntries: freezeDeepDeclaration(PluginDeclaredUiEntriesV1Schema.parse(materialization.declaredUiEntries)),
        } : {}),
        uiArtifacts: freezeAvailabilitySnapshotValue(materialization.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({ ...artifact })
        ))),
    });
}

function freezeDeepDeclaration<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeDeepDeclaration(child);
        Object.freeze(value);
    }
    return value;
}

function snapshotIntentReadResponse(
    response: PluginAccountAvailabilityIntentReadResponseV1,
): PluginAccountAvailabilityIntentReadResponseV1 {
    const intent = response.intent
        ? freezeAvailabilitySnapshotValue({
            ...response.intent,
            writableCollections: freezeAvailabilitySnapshotValue(response.intent.writableCollections.map((collection) => (
                freezeAvailabilitySnapshotValue({ ...collection })
            ))),
        })
        : null;
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: response.availabilityCursor,
        hostingCapability: freezeAvailabilitySnapshotValue({ ...response.hostingCapability }),
        intent,
        // Protocol owns the complete immutable release-fact representation.
        // The reader snapshots its remaining projection facts here instead of
        // recreating that normalizer in the UI layer.
        release: response.release ? normalizePluginReleaseFactsV1(response.release) : null,
        packageAssets: freezeAvailabilitySnapshotValue(response.packageAssets.map((artifact) => (
            freezeAvailabilitySnapshotValue({
                ...artifact,
                release: freezeAvailabilitySnapshotValue({ ...artifact.release }),
                descriptor: clonePackageAssetDescriptor(artifact.descriptor),
            })
        ))),
        uiArtifacts: freezeAvailabilitySnapshotValue(response.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({
                ...artifact,
                release: freezeAvailabilitySnapshotValue({ ...artifact.release }),
            })
        ))),
    });
}

function cloneSelectionIntent(
    intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>,
): NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']> {
    return freezeAvailabilitySnapshotValue({
        ...intent,
        writableCollections: freezeAvailabilitySnapshotValue(intent.writableCollections.map((collection) => (
            freezeAvailabilitySnapshotValue({ ...collection })
        ))),
    });
}

function snapshotPluginAccountAvailabilitySnapshot(
    snapshot: PluginAccountAvailabilitySnapshot,
): PluginAccountAvailabilitySnapshot {
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: snapshot.availabilityCursor,
        inventoryComplete: snapshot.inventoryComplete !== false,
        releases: Object.freeze((snapshot.releases ?? []).map(normalizePluginReleaseFactsV1)),
        intentReads: freezeAvailabilitySnapshotValue(snapshot.intentReads.map((projection) => (
            freezeAvailabilitySnapshotValue({
                pluginId: projection.pluginId,
                response: snapshotIntentReadResponse(projection.response),
            })
        ))),
        materializations: freezeAvailabilitySnapshotValue(snapshot.materializations.map(cloneMaterialization)),
        snapshots: freezeAvailabilitySnapshotValue(snapshot.snapshots.map((machineSnapshot) => (
            freezeAvailabilitySnapshotValue({
                ...machineSnapshot,
                materializations: freezeAvailabilitySnapshotValue(
                    machineSnapshot.materializations.map(cloneMaterialization),
                ),
            })
        ))),
    });
}

/** These owned Protocol facts are JSON values; equality retains data, never current admission. */
function retainUnchangedAvailabilityValue<T>(previous: T | undefined, next: T): T {
    return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/** Local edits to the ordered snapshot retain the unchanged rows beside them. */
function retainUnchangedAvailabilityRows<T>(previous: readonly T[] | undefined, next: readonly T[]): readonly T[] {
    if (!previous) return next;
    const rows = next.map((row, index) => retainUnchangedAvailabilityValue(previous[index], row));
    return previous.length === rows.length && rows.every((row, index) => row === previous[index])
        ? previous : Object.freeze(rows);
}

function cloneArtifact(artifact: PluginAccountAvailabilityArtifactFact): PluginAccountAvailabilityArtifactFact {
    const selected: PluginAccountAvailabilitySelectedArtifactFact = freezeAvailabilitySnapshotValue({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        artifactId: artifact.artifactId,
        tier: artifact.tier,
        platform: artifact.platform,
        digest: artifact.digest,
        hostUiApiRange: artifact.hostUiApiRange,
        releaseVersion: artifact.releaseVersion,
    });
    if (!artifact.accountArtifactId) {
        return selected;
    }
    return freezeAvailabilitySnapshotValue({
        ...selected,
        accountArtifactId: artifact.accountArtifactId,
    });
}

function readProjectionForScope(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
): PluginAccountAvailabilitySnapshot | null {
    return state && areServerAccountScopesEqual(state.scope, scope)
        ? state.snapshot
        : null;
}

function readMaterializationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
): PluginMachineMaterializationAdmission {
    if (!state) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_not_loaded' });
    }
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        // Administration consumes the same Account intent/release responses,
        // but receives only links qualified by Availability's canonical exact
        // slot matcher. Presentation must not reinterpret raw link counts as
        // exact hosted availability.
        intentReads: Object.freeze(snapshot.intentReads
            .map((projection) => {
                const hosted = readCurrentHostedArtifactAdministrationAdmission(
                    state,
                    scope,
                    { pluginId: projection.pluginId },
                );
                return Object.freeze({
                    pluginId: projection.pluginId,
                    response: Object.freeze({
                        ...projection.response,
                        uiArtifacts: hosted.kind === 'available'
                            ? hosted.uiArtifacts
                            : Object.freeze([]),
                        packageAssets: hosted.kind === 'available'
                            ? hosted.packageAssets
                            : Object.freeze([]),
                    }),
                });
            })),
        // Ingestion already validates, copies and freezes this inventory.
        // Reuse those owned facts until the Account projection replaces them.
        materializations: snapshot.materializations,
        snapshots: snapshot.snapshots,
    });
}

function readInstalledPluginsAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    previous?: PluginAccountInstalledPluginsAdmission,
): PluginAccountInstalledPluginsAdmission {
    const admitted = readMaterializationAdmission(state, scope);
    if (admitted.kind === 'unavailable') return admitted;
    const snapshot = readProjectionForScope(state, scope)!;
    const previousInstallations = new Map(previous?.kind === 'available' ? previous.plugins.flatMap(plugin =>
        plugin.installations.map(installation => [materializationLookupKey(installation.materialization), installation] as const)) : []);
    const byPluginId = new Map<string, PluginAccountInstalledPluginInstallation[]>();
    for (const materialization of admitted.materializations) {
        const releases = [...(snapshot.releases ?? []), ...snapshot.intentReads.flatMap((entry) => {
            const release = entry.pluginId === materialization.pluginId ? entry.response.release : null;
            return release ? [release] : [];
        })].filter(release => isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release));
        const uniqueReleases = new Map(releases.map(release => [release.archiveDigestSha256, release]));
        const release = uniqueReleases.size === 1 ? [...uniqueReleases.values()][0]! : null;
        const declaration = release?.normalizedManifest ?? materialization.declaredManifest ?? null;
        const declaredUiEntries = materialization.declaredUiEntries
            ?? (release ? projectPluginPortableUiDeclarationsV1(release.normalizedManifest) : undefined);
        const registrySources = declaration ? (declaration.contributes?.registrySources ?? []).map(definition =>
            projectPluginRegistrySourceDeclarationV1({ pluginId: materialization.pluginId,
                pluginVersion: declaration.version, definition })) : [];
        const skills = declaration ? (declaration.contributes?.skills ?? []).map(definition =>
            projectPluginSkillDeclarationV1({ pluginId: materialization.pluginId,
                pluginVersion: declaration.version, definition })) : [];
        const installations = byPluginId.get(materialization.pluginId) ?? [];
        const incumbent = previousInstallations.get(materializationLookupKey(materialization));
        const uiModel = incumbent?.materialization === materialization && incumbent.declaration === declaration
            && incumbent.release === release ? incumbent.uiModel : normalizePluginInstalledUiDeclarations(declaredUiEntries ?? {}, undefined, {
                id: materialization.pluginId,
                displayName: typeof declaration?.displayName === 'string'
                    ? declaration.displayName : declaration?.displayName.fallback ?? materialization.pluginId,
                version: materialization.version,
                enabled: materialization.enabled,
                source: { kind: materialization.sourceClass, locator: materialization.materializationId },
                ...(declaration?.executionTarget ? { executionTarget: declaration.executionTarget } : {}),
                ...(declaration ? { declaredExecution: {
                    daemonActions: declaration.contributes.actions?.some(action => action.execution?.target !== 'client') === true,
                    contributionPoints: (declaration.contributes.pluginContributionPoints?.length ?? 0) > 0,
                } } : {}),
            }, registrySources, skills);
        installations.push(Object.freeze({
            materialization,
            declaration,
            declarationState: declaration ? 'known' : 'preparing',
            uiDeclarationState: declaredUiEntries !== undefined ? 'known' : 'preparing',
            release,
            execution: classifyMaterializationRelease(state, scope, materialization),
            uiModel,
        }));
        byPluginId.set(materialization.pluginId, installations);
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        completeness: snapshot.inventoryComplete === false ? 'incomplete' : 'complete',
        plugins: Object.freeze([...byPluginId].sort(([a], [b]) => a.localeCompare(b)).map(([pluginId, installations]) => Object.freeze({
            pluginId,
            installations: Object.freeze(installations),
        }))),
    });
}

type CurrentReleaseAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        hostingCapability: PluginAccountAvailabilityIntentReadResponseV1['hostingCapability'];
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>;
        uiArtifacts: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'];
        packageAssets: PluginAccountAvailabilityIntentReadResponseV1['packageAssets'];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>['code'];
    }>;

function readCurrentReleaseAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): CurrentReleaseAdmission {
    if (!state) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_not_loaded' });
    }
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    }
    const projections = snapshot.intentReads.filter((projection) => projection.pluginId === pluginId);
    if (projections.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (projections.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    }
    const response = projections[0]!.response;
    const intent = response.intent;
    const release = response.release;
    if (
        !intent
        || !intent.desiredVersion
        || intent.pluginId !== pluginId
        || !release
        || release.ref.pluginId !== pluginId
        || release.ref.version !== intent.desiredVersion
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: response.availabilityCursor,
        hostingCapability: response.hostingCapability,
        intent,
        release,
        uiArtifacts: response.uiArtifacts,
        packageAssets: response.packageAssets,
    });
}

function readCurrentReleaseSelectionAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityReleaseSelectionAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        intent: cloneSelectionIntent(current.intent),
        release: Object.freeze({
            ref: Object.freeze({ ...current.release.ref }),
            normalizedManifest: current.release.normalizedManifest,
        }),
    });
}

function readCurrentHostedArtifactAdministrationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityHostedArtifactAdministrationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    const uiArtifacts = current.release.uiSlots.flatMap((slot) => {
        const exact = selectExactHostedLinks(current, slot);
        return exact.length === 1 ? [exact[0]!] : [];
    });
    const packageAssets = selectExactHostedPackageAssetLinks(current);
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        hostingCapability: current.hostingCapability,
        intent: cloneSelectionIntent(current.intent),
        release: Object.freeze({
            ref: Object.freeze({ ...current.release.ref }),
            uiSlots: current.release.uiSlots,
            packageAssetArchive: current.release.packageAssetArchive,
        }),
        uiArtifacts: Object.freeze(uiArtifacts),
        packageAssets: Object.freeze(packageAssets.length === 1 ? packageAssets : []),
    });
}

/** Exact installed custody may admit local UI bytes, never Account intent or hosted publication. */
function readInstalledReleaseAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null | undefined,
): Readonly<{ availabilityCursor: number; release: PluginReleaseFactsV1 }> | null {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot || !origin || !('materializationRef' in origin)
        || origin.materializationRef.pluginId !== pluginId || state?.retiredPluginIds?.includes(pluginId)) return null;
    const intents = snapshot.intentReads.filter(entry => entry.pluginId === pluginId);
    // An explicit null read proves absence; missing or competing reads do not.
    if (intents.length !== 1 || intents[0]!.response.intent !== null) return null;
    const rows = readMaterializationsByIdentity(snapshot).get(materializationLookupKey({
        ...origin.materializationRef, serverIdentityId: origin.serverIdentityId,
    })) ?? [];
    if (rows.length !== 1) return null;
    const materialization = rows[0]!;
    if (!materialization.enabled || materialization.trustState !== 'trusted' || !materialization.portableRelease) return null;
    const releases = (snapshot.releases ?? []).filter(release =>
        isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release));
    if (releases.length !== 1) return null;
    return Object.freeze({ availabilityCursor: snapshot.availabilityCursor, release: releases[0]! });
}

function classifyMaterializationRelease(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    materialization: PluginMachineMaterializationV1,
): PluginAccountAvailabilityReleaseClassificationV1 {
    const identity = projectPluginAccountAvailabilityMaterializationIdentity(materialization);
    if (!materialization.portableRelease) {
        return Object.freeze({ ...identity, releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'non_portable' }) });
    }
    const current = readCurrentReleaseAdmission(state, scope, materialization.pluginId);
    if (current.kind !== 'available') {
        const installed = readInstalledReleaseAdmission(state, scope, materialization.pluginId, identity);
        if (installed && isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, installed.release)) {
            return Object.freeze({ ...identity, releaseContent: 'matched', validation: Object.freeze({ kind: 'admitted' }) });
        }
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'release_unavailable' }),
        });
    }
    if (materialization.pluginId !== current.intent.pluginId) {
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'plugin_mismatch' }),
        });
    }
    const releaseContent = isExactPluginMachineMaterializationReleaseCorrespondenceV1(
        materialization,
        current.release,
    )
        ? 'matched'
        : 'conflict';
    return Object.freeze({
        ...identity,
        releaseContent,
        validation: current.intent.enabled
            ? Object.freeze({ kind: 'admitted' as const })
            : Object.freeze({ kind: 'rejected' as const, reason: 'disabled' as const }),
    });
}

type CurrentHostedSlotSelection =
    | Readonly<{
        kind: 'available';
        releaseSlot: PluginAccountAvailabilityReleaseUiSlot;
        /**
         * True only when the operator capability and the present Account
         * opt-in both admit Account hosting for this release.
         */
        accountHostedEnabled: boolean;
        exactHostedLink: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'][number] | null;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_not_current' | 'artifact_slot_ambiguous';
    }>;

/**
 * The single derivation of "which declared release slot does this coordinate
 * name, and does the Account already host its exact archive". Artifact
 * admission and hosted-publication admission are two readings of that one
 * fact; deriving it twice would let a reader and a publisher disagree about
 * whether a slot is already hosted.
 */
function selectCurrentHostedSlot(
    current: Extract<CurrentReleaseAdmission, { kind: 'available' }>,
    slot: PluginAccountAvailabilityArtifactSlot,
): CurrentHostedSlotSelection {
    const selected = selectReleaseSlot(current.release, slot);
    if (selected.kind !== 'available') return selected;
    const releaseSlot = selected.releaseSlot;
    const exactHostedLinks = selectExactHostedLinks(current, releaseSlot);
    // Hosting continues to require Account intent even for an installed renderer.
    const accountHostedEnabled = isAccountArtifactHostingAdmitted(current);
    return Object.freeze({
        kind: 'available', releaseSlot, accountHostedEnabled,
        exactHostedLink: accountHostedEnabled && exactHostedLinks.length === 1 ? exactHostedLinks[0]! : null,
    });
}

function selectReleaseSlot(
    release: PluginReleaseFactsV1,
    slot: PluginAccountAvailabilityArtifactSlot,
): Readonly<{ kind: 'available'; releaseSlot: PluginAccountAvailabilityReleaseUiSlot }>
    | Readonly<{ kind: 'unavailable'; code: 'artifact_not_current' | 'artifact_slot_ambiguous' }> {
    const releaseSlots = release.uiSlots.filter((candidate) => (
        candidate.contributionId === slot.contributionId
        && candidate.tier === slot.tier
        && candidate.platform === slot.platform
    ));
    if (releaseSlots.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (releaseSlots.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    }
    return Object.freeze({ kind: 'available', releaseSlot: releaseSlots[0]! });
}

function selectExactHostedLinks(
    current: Extract<CurrentReleaseAdmission, { kind: 'available' }>,
    releaseSlot: PluginAccountAvailabilityReleaseUiSlot,
) {
    return current.uiArtifacts.filter((link) => (
        link.release.pluginId === current.release.ref.pluginId
        && link.release.version === current.release.ref.version
        && link.contributionId === releaseSlot.contributionId
        && link.tier === releaseSlot.tier
        && link.platform === releaseSlot.platform
        && link.artifactDigest === releaseSlot.artifactDigest
        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
            releaseSlot,
            link,
        )
    ));
}

function readCurrentArtifactAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[] = [],
    executionOrigin?: PluginMachineExecutionOriginV1 | null,
    daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection,
): PluginAccountAvailabilityArtifactAdmission {
    const current = readCurrentReleaseAdmission(state, scope, slot.pluginId);
    if (current.kind !== 'available') {
        if (daemonProjectionSelection) {
            const snapshot = readCurrentNonPortableUiSnapshot(state, scope, slot.pluginId);
            if (!snapshot) return current;
            const selected = daemonProjectionSelection;
            if (!selected.occurrenceId.trim()
                || selected.artifact.pluginId !== slot.pluginId
                || selected.artifact.contributionId !== slot.contributionId
                || selected.artifact.tier !== slot.tier
                || selected.artifact.platform !== slot.platform) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            }
            try {
                if (!selected.isCurrent()) return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            } catch {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            }
            return Object.freeze({ kind: 'available', availabilityCursor: snapshot.availabilityCursor,
                artifact: cloneArtifact(selected.artifact) });
        }
        const installed = readInstalledReleaseAdmission(state, scope, slot.pluginId, executionOrigin);
        if (installed) {
            const selected = selectReleaseSlot(installed.release, slot);
            if (selected.kind !== 'available') return selected;
            const artifact = selected.releaseSlot;
            return Object.freeze({ kind: 'available', availabilityCursor: installed.availabilityCursor,
                artifact: Object.freeze({ ...slot, artifactId: artifact.artifactId, digest: artifact.artifactDigest,
                    hostUiApiRange: artifact.hostUiApiRange, releaseVersion: installed.release.ref.version }) });
        }
        const bundled = readCurrentHostBundle(state, scope, hostBundledUi, slot.pluginId);
        if (bundled) {
            const artifacts = Object.values(bundled.entriesById).flatMap(entry => {
                const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(entry.artifactGraph);
                return entry.contributionId === slot.contributionId && graph.success && graph.data.tier === slot.tier
                    ? [graph.data] : [];
            });
            const execution = readAccountExecutionSelection(state, scope, hostBundledUi, slot.pluginId);
            const accountAction = execution.kind === 'available' ? execution.manifest.contributes.actions?.find(action =>
                action.id === slot.contributionId && action.execution.target === 'account') : undefined;
            if (execution.kind === 'available' && accountAction?.execution.target === 'account') {
                const reference = accountAction.execution.account;
                artifacts.push(...accountActionArtifactGraphs(execution, hostBundledUi).filter(graph => graph.tier === 'reactNative' && graph.tier === slot.tier
                    && graph.artifactId === reference.artifactId && graph.executable.exports.includes(reference.exportName)));
            }
            if (artifacts.length > 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
            if (artifacts.length === 1) {
                const artifact = artifacts[0]!;
                return Object.freeze({ kind: 'available', availabilityCursor: state!.snapshot.availabilityCursor,
                    artifact: Object.freeze({ ...slot, artifactId: artifact.artifactId, digest: artifact.digest,
                        hostUiApiRange: artifact.hostUiApiRange, releaseVersion: bundled.pluginVersion }) });
            }
        }
        return current;
    }
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    const hosted = selectCurrentHostedSlot(current, slot);
    if (hosted.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: hosted.code });
    }
    const releaseSlot = hosted.releaseSlot;
    const selected: PluginAccountAvailabilitySelectedArtifactFact = Object.freeze({
        pluginId: slot.pluginId,
        contributionId: releaseSlot.contributionId,
        artifactId: releaseSlot.artifactId,
        tier: releaseSlot.tier,
        platform: releaseSlot.platform,
        digest: releaseSlot.artifactDigest,
        hostUiApiRange: releaseSlot.hostUiApiRange,
        releaseVersion: current.release.ref.version,
    });
    const exactHostedLink = hosted.exactHostedLink;
    const artifact: PluginAccountAvailabilityArtifactFact = exactHostedLink
        ? Object.freeze({
            ...selected,
            accountArtifactId: exactHostedLink.accountArtifactId,
        })
        : selected;
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        artifact: cloneArtifact(artifact),
    });
}

/** Shared Account eligibility for bundled and explicitly selected development UI. */
function readCurrentNonPortableUiSnapshot(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): PluginAccountAvailabilitySnapshot | null {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot || state?.retiredPluginIds?.includes(pluginId)) return null;
    const intents = snapshot.intentReads.filter(entry => entry.pluginId === pluginId);
    if (intents.length > 1 || intents.some(entry => entry.response.intent
        && (entry.response.intent.pluginId !== pluginId
            || !entry.response.intent.enabled || entry.response.intent.desiredVersion !== null))) return null;
    return snapshot;
}

function readCurrentHostBundle(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[],
    pluginId: string,
): PluginHostBundledUiDeclaration | null {
    if (!readCurrentNonPortableUiSnapshot(state, scope, pluginId)) return null;
    const bundles = hostBundledUi.filter(candidate => candidate.pluginId === pluginId);
    return bundles.length === 1 ? bundles[0]! : null;
}

function readAccountExecutionSelection(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[],
    pluginId: string,
): PluginAccountExecutionAdmission {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze({ kind: 'unavailable', code: state
        ? 'account_availability_scope_mismatch' : 'account_availability_not_loaded' });
    if (state?.retiredPluginIds?.includes(pluginId)) return Object.freeze({ kind: 'unavailable', code: 'plugin_account_execution_unavailable' });
    const reads = snapshot.intentReads.filter(row => row.pluginId === pluginId);
    if (reads.length > 1) return Object.freeze({ kind: 'unavailable', code: 'plugin_release_unavailable' });
    const bundles = hostBundledUi.filter(row => row.pluginId === pluginId);
    const bundle = bundles.length === 1 ? bundles[0] : undefined;
    const manifest = PluginPortableReleaseManifestV1Schema.safeParse(bundle?.normalizedManifest);
    const bundleId = bundle && manifest.success ? computePluginAccountBundledCustodyIdV1({
        packageName: bundle.packageName, manifest: manifest.data,
        artifacts: bundle.artifactGraphs ?? [],
    }) : null;
    return resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: reads[0]?.response ?? null,
        ...(bundle && manifest.success && manifest.data.id === pluginId && manifest.data.version === bundle.pluginVersion && bundleId ? {
            bundled: { manifest: manifest.data, custodyId: bundleId,
                sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId } } },
        } : {}),
    });
}

function readAccountExecutionSelections(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[],
): readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[] {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze([]);
    const pluginIds = new Set([...snapshot.intentReads.map(row => row.pluginId), ...hostBundledUi.map(row => row.pluginId)]);
    return Object.freeze([...pluginIds].sort().flatMap(pluginId => {
        const selected = readAccountExecutionSelection(state, scope, hostBundledUi, pluginId);
        return selected.kind === 'available' ? [selected] : [];
    }));
}

function accountActionArtifactGraphs(
    selection: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[],
): readonly PluginUiArtifactsManifestEntryV2[] {
    const graphs = selection.release ? selection.release.uiSlots.flatMap(slot => slot.artifactGraph ? [slot.artifactGraph] : [])
        : hostBundledUi.find(bundle => bundle.pluginId === selection.manifest.id)?.artifactGraphs ?? [];
    return Object.freeze([...new Map(graphs.map(graph => [createCanonicalJsonSigningInput(graph), graph])).values()]);
}

/**
 * Admits one exact declared slot for present-client Account-hosted
 * publication. It is deliberately not Artifact admission: it grants no byte
 * source and it is available only while the operator capability, the Account
 * opt-in, and the current release all admit hosting AND no exact qualified
 * link exists yet.
 */
function readCurrentHostedPublicationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
): PluginAccountAvailabilityHostedPublicationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, slot.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    const hosted = selectCurrentHostedSlot(current, slot);
    if (hosted.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: hosted.code });
    }
    if (!hosted.accountHostedEnabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_hosting_not_admitted' });
    }
    if (hosted.exactHostedLink) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_already_hosted' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        target: freezeAvailabilitySnapshotValue({
            release: freezeAvailabilitySnapshotValue({ ...current.release.ref }),
            slot: freezeAvailabilitySnapshotValue({ ...hosted.releaseSlot }),
        }),
    });
}

function clonePackageAssetDescriptor(
    descriptor: PackageAssetArchiveDescriptorV1,
): PackageAssetArchiveDescriptorV1 {
    return freezeAvailabilitySnapshotValue({
        archiveDigestSha256: descriptor.archiveDigestSha256,
        resources: freezeAvailabilitySnapshotValue(descriptor.resources.map((resource) => freezeAvailabilitySnapshotValue({ ...resource }))),
    });
}

function isAccountArtifactHostingAdmitted(current: Extract<CurrentReleaseAdmission, { kind: 'available' }>): boolean {
    return current.hostingCapability.enabled === true && current.intent.offlineUiHosting === 'enabled';
}

function selectExactHostedPackageAssetLinks(current: Extract<CurrentReleaseAdmission, { kind: 'available' }>) {
    return current.packageAssets.filter((link) => (
        link.release.pluginId === current.release.ref.pluginId
        && link.release.version === current.release.ref.version
        && link.descriptor.archiveDigestSha256 === current.release.packageAssetArchive.archiveDigestSha256
        && JSON.stringify(link.descriptor.resources) === JSON.stringify(current.release.packageAssetArchive.resources)
    ));
}

function readCurrentHostedPackageAssetPublicationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityHostedPackageAssetPublicationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    if (!current.intent.enabled || current.release.packageAssetArchive.resources.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (!isAccountArtifactHostingAdmitted(current)) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_hosting_not_admitted' });
    }
    const links = selectExactHostedPackageAssetLinks(current);
    if (links.length > 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    if (links.length === 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_already_hosted' });
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        target: Object.freeze({
            release: Object.freeze({ ...current.release.ref }),
            normalizedManifest: current.release.normalizedManifest,
            descriptor: current.release.packageAssetArchive,
        }),
    });
}

function readCurrentPackageAssetAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityPackageAssetAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        packageAsset: Object.freeze({
            pluginId: input.pluginId,
            releaseVersion: current.release.ref.version,
            descriptor: clonePackageAssetDescriptor(current.release.packageAssetArchive),
        }),
    });
}

/**
 * A release-less intent is a daemon-claimed Collection writer pointer for a
 * bundled, development, or drop-in plugin. It carries Data authority only
 * (Collections and the plugin's own Account KV) and never selects release UI,
 * artifacts, or package assets.
 */
function readCurrentReleaseLessIntent(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): Readonly<{
    availabilityCursor: number;
    intent: NonNullable<PluginAccountAvailabilityIntentReadProjection['response']['intent']>;
}> | null {
    const snapshot = state ? readProjectionForScope(state, scope) : null;
    const projections = snapshot?.intentReads.filter((projection) => projection.pluginId === pluginId) ?? [];
    if (projections.length !== 1) return null;
    const { response } = projections[0]!;
    return response.intent?.pluginId === pluginId && response.intent.desiredVersion === null
        ? { availabilityCursor: response.availabilityCursor, intent: response.intent }
        : null;
}

function readCurrentCollectionContractAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string; collectionId: string; ref?: PluginCollectionContractRefV1 }>,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[],
): PluginAccountAvailabilityCollectionContractAdmission {
    // A claim admits its current writer refs; a release admits its declared
    // refs (older retained reader refs stay with the server's resolver).
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    let current: Readonly<{
        availabilityCursor: number;
        enabled: boolean;
        contracts: readonly PluginCollectionContractRefV1[];
    }>;
    if (claimed) {
        current = {
            availabilityCursor: claimed.availabilityCursor,
            enabled: claimed.intent.enabled,
            contracts: claimed.intent.writableCollections,
        };
    } else {
        const release = readCurrentReleaseAdmission(state, scope, input.pluginId);
        if (release.kind !== 'available') {
            return Object.freeze({ kind: 'unavailable', code: release.code });
        }
        current = {
            availabilityCursor: release.availabilityCursor,
            enabled: release.intent.enabled,
            contracts: release.release.collectionContracts,
        };
    }
    if (!current.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    const contracts = current.contracts;
    const candidates = contracts.filter((candidate) => (
        candidate.pluginId === input.pluginId
        && candidate.collectionId === input.collectionId
    ));
    if (candidates.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    if (candidates.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_slot_ambiguous' });
    }
    // An app-bundled query uses the contract compiled with its reader. A newer
    // daemon writer is not evidence that this app understands those rows.
    // Data's exact-ref resolver owns compatibility, including retained readers.
    const bundle = readCurrentHostBundle(state, scope, hostBundledUi, input.pluginId);
    const compiled = bundle?.collectionContracts?.filter(ref => ref.collectionId === input.collectionId);
    const ref = input.ref ?? (bundle ? compiled?.length === 1 ? compiled[0] : undefined : candidates[0]);
    if (!ref) return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    if (ref.pluginId !== input.pluginId || ref.collectionId !== input.collectionId) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    // Data resolves compatibility and read/write access for this exact ref.
    // Availability never substitutes the current writer's digest for a caller.
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        ref: Object.freeze({ ...ref }),
    });
}

function releaseRequiresAccountKv(manifest: PluginPortableReleaseManifestV1): boolean {
    return manifest.hostAccess.required.some(
        (request) => request.capability === 'storage.account',
    );
}

function readCurrentAccountDataCapabilityAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityDataCapabilityAdmission {
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    if (claimed) {
        return claimed.intent.enabled && claimed.intent.writableCollections.length > 0
            ? Object.freeze({ kind: 'available', availabilityCursor: claimed.availabilityCursor })
            : Object.freeze({ kind: 'unavailable', code: 'account_data_not_current' });
    }
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    const accountKvDeclared = releaseRequiresAccountKv(current.release.normalizedManifest);
    if (
        !current.intent.enabled
        || (current.release.collectionContracts.length === 0 && !accountKvDeclared)
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'account_data_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
    });
}

function readCurrentAccountKvCapabilityAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
    hostBundledUi: readonly PluginHostBundledUiDeclaration[] = [],
): PluginAccountAvailabilityAccountKvAdmission {
    // A daemon claim comes from the plugin's own admitted manifest, so it
    // admits that plugin's Account KV exactly as it admits its Collections.
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    if (claimed) {
        return claimed.intent.enabled
            ? Object.freeze({ kind: 'available', availabilityCursor: claimed.availabilityCursor })
            : Object.freeze({ kind: 'unavailable', code: 'account_kv_not_current' });
    }
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        const selected = readAccountExecutionSelection(state, scope, hostBundledUi, input.pluginId);
        if (selected.kind === 'available' && releaseRequiresAccountKv(selected.manifest)) {
            return Object.freeze({ kind: 'available', availabilityCursor: state!.snapshot.availabilityCursor });
        }
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    const accountKvDeclared = releaseRequiresAccountKv(current.release.normalizedManifest);
    if (!current.intent.enabled || !accountKvDeclared) {
        return Object.freeze({ kind: 'unavailable', code: 'account_kv_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
    });
}

function readCurrentSettingsDeclarationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilitySettingsDeclarationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        declaration: current.release.normalizedManifest,
    });
}

type AvailabilityReaderProjectionCache = {
    state?: AvailabilityProjectionState | null;
    materializations?: PluginMachineMaterializationAdmission;
    installed?: PluginAccountInstalledPluginsAdmission;
    lastInstalled?: PluginAccountInstalledPluginsAdmission;
    accountUi?: PluginUiProjectionModel | null;
    lastAccountUi?: PluginUiProjectionModel | null;
    accountUiBundles?: readonly PluginHostBundledUiDeclaration[];
    accountExecutionSelections?: readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[];
};

function createBoundReader(input: Readonly<{
    scope: ServerAccountScope;
    readState: () => AvailabilityProjectionState | null;
    subscribe: (listener: () => void) => () => void;
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
    projectionCache?: AvailabilityReaderProjectionCache;
}>): PluginAccountAvailabilityReader {
    // Both projections are derived from the owner-snapshotted immutable state.
    // Fresh imperative admission still reads that state on every access; only
    // unchanged-state derivation is retained. Clear, retirement, partial refresh
    // and Account replacement all replace the state identity below.
    const cache: AvailabilityReaderProjectionCache = input.projectionCache ?? {};
    const readDerivedState = () => {
        const state = input.readState();
        if (state !== cache.state) {
            cache.state = state;
            cache.materializations = undefined;
            cache.installed = undefined;
            cache.accountUi = undefined;
        }
        return state;
    };
    return Object.freeze({
        readCurrentAccountExecution: (pluginId: string) => readAccountExecutionSelection(input.readState(), input.scope, input.hostBundledUi ?? [], pluginId),
        readCurrentAccountExecutionDeclarations: () => readAccountExecutionSelections(input.readState(), input.scope, input.hostBundledUi ?? []),
        readAccountUiProjection: () => {
            const state = readDerivedState();
            if (cache.accountUi !== undefined) return cache.accountUi;
            const bundles = (input.hostBundledUi ?? []).filter(bundle =>
                readCurrentHostBundle(state, input.scope, input.hostBundledUi ?? [], bundle.pluginId));
            const selections = readAccountExecutionSelections(state, input.scope, input.hostBundledUi ?? []);
            if (cache.accountUiBundles?.length === bundles.length
                && bundles.every((bundle, index) => bundle === cache.accountUiBundles![index])
                && sameStrictJsonValue(cache.accountExecutionSelections, selections)) {
                return cache.accountUi = cache.lastAccountUi ?? null;
            }
            const entries = Object.assign({}, ...bundles.map(bundle => bundle.entriesById),
                ...selections.map(selected => {
                    const declarations = projectPluginPortableUiDeclarationsV1(
                        selected.manifest, accountActionArtifactGraphs(selected, input.hostBundledUi ?? []),
                    );
                    return selected.release && selected.manifest.contributes.actions?.some(action => action.execution.target === 'account')
                        ? declarations
                        : Object.fromEntries(Object.entries(declarations).filter(([, entry]) => entry.contributionKind === 'uiRenderer'));
                }));
            const accountUiOrigins = new Map(selections.map(({ manifest, custodyId, sourceCustody }) => [manifest.id,
                Object.freeze({ ...input.scope, custodyId, sourceCustody,
                    ...(sourceCustody.kind === 'bundled_first_party'
                        ? { declarationDigest: computePluginAccountBundledDeclarationDigestV1(manifest) } : {}) }),
            ] as const));
            const actions: Record<string, PluginUiActionProjection> = {};
            for (const selected of selections) {
                const { manifest, custodyId } = selected;
                const hostAccountOrigin = accountUiOrigins.get(manifest.id)!;
                const graphs = accountActionArtifactGraphs(selected, input.hostBundledUi ?? []);
                for (const action of manifest.contributes.actions ?? []) {
                    if (action.execution.target !== 'account') continue;
                    const execution = action.execution;
                    const matchingGraphs = graphs.filter(graph => graph.tier === 'reactNative'
                        && graph.artifactId === execution.account.artifactId
                        && graph.executable.exports.includes(execution.account.exportName));
                    const graph = matchingGraphs.length === 1 ? matchingGraphs[0] : undefined;
                    const compatible = graph !== undefined && isPluginUiHostApiVersionCompatibleWithVersionV1(PLUGIN_UI_HOST_API_VERSION_V1, graph.hostUiApiRange);
                    const requestedAccess = action.hostAccess ?? [];
                    const optionalAccess = manifest.hostAccess.optional.filter(request => requestedAccess.includes(request.id));
                    const requiredAccess = manifest.hostAccess.required.filter(request => requestedAccess.includes(request.id));
                    const accountKvAdmission = readCurrentAccountKvCapabilityAdmission(state, input.scope, { pluginId: manifest.id }, input.hostBundledUi);
                    const key = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id });
                    actions[key] = Object.freeze({ id: action.id, pluginId: manifest.id,
                        pluginVersion: manifest.version, occurrenceId: custodyId, title: action.title,
                        ...(action.description ? { description: action.description } : {}),
                        ...(action.icon ? { icon: action.icon } : {}),
                        scopes: action.scopes, surfaces: action.surfaces, execution,
                        placementBindings: action.placementBindings, dangerLevel: action.dangerLevel,
                        ...(action.confirmation ? { confirmation: action.confirmation } : {}),
                        ...(action.confirmationWhen ? { confirmationWhen: action.confirmationWhen } : {}),
                        available: compatible, hostAccountOrigin, hostAccountDeclaration: manifest,
                        authorization: { generation: { targetGeneration: custodyId, desiredGeneration: custodyId, appliedGeneration: null },
                            resourceSelections: optionalAccess.map(request => ({ id: request.id, required: true })), scopedGrants: [],
                            serviceAvailability: [...requiredAccess, ...optionalAccess].map(request => ({ id: request.id, required: true,
                                status: requiredAccess.includes(request) && request.capability === 'storage.account'
                                    && accountKvAdmission.kind === 'available' ? 'available' as const : 'unavailable' as const })),
                            operatingSystemAuthorization: [] },
                    });
                    if (graph) {
                        const entry = projectPluginReactNativeArtifactEntryV1({ pluginId: manifest.id, pluginVersion: manifest.version,
                            contributionId: action.id, artifactId: graph.artifactId, artifact: graph, generatedOwnerKind: 'clientContribution',
                            artifactSelectionOwner: 'accountRelease', requiredHostMethods: [], exportName: execution.account.exportName,
                            runtime: Object.freeze({ decision: { state: compatible ? 'load' : 'blocked',
                                reason: compatible ? 'compatible' : 'generated_ui_host_api_mismatch',
                                diagnostics: compatible ? [] : ['generated_ui_host_api_mismatch'] },
                                ...(compatible ? { cacheIdentity: { artifactDigest: graph.digest }, loadPolicy: { source: 'installedArtifact' } } : {}) }),
                        });
                        entries[entry.id] = Object.freeze({ ...entry, occurrenceId: custodyId, hostAccountOrigin, hostAccountDeclaration: manifest });
                    }
                }
            }
            const projection = normalizePluginInstalledUiDeclarations(entries);
            const withAccountOccurrence = <T extends Readonly<{ pluginId: string }>>(entry: T): T => {
                const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
                return hostAccountOrigin ? Object.freeze({ ...entry, occurrenceId: hostAccountOrigin.custodyId }) : entry;
            };
            cache.accountUiBundles = bundles;
            cache.accountExecutionSelections = selections;
            return cache.accountUi = cache.lastAccountUi = Object.keys(entries).length > 0 || Object.keys(actions).length > 0 ? Object.freeze({ ...projection,
                actionsById: Object.freeze(actions),
                reactNativeBundlesById: Object.freeze(Object.fromEntries(Object.entries(projection.reactNativeBundlesById)
                    .map(([key, entry]) => [key, withAccountOccurrence(entry)]))),
                hostedWebById: Object.freeze(Object.fromEntries(Object.entries(projection.hostedWebById)
                    .map(([key, entry]) => [key, withAccountOccurrence(entry)]))),
                surfacePlacementsById: Object.freeze(Object.fromEntries(Object.entries(projection.surfacePlacementsById)
                    .map(([key, entry]) => {
                        const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
                        return [key, Object.freeze({ ...entry, hostSupplies: Object.freeze([]),
                            ...(hostAccountOrigin ? { occurrenceId: hostAccountOrigin.custodyId, hostAccountOrigin } : {}) })];
                    }))),
                settingsPagesById: Object.freeze(Object.fromEntries(Object.entries(projection.settingsPagesById)
                    .map(([key, entry]) => {
                        const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
                        return [key, Object.freeze({ ...entry, hostSupplies: Object.freeze([]),
                            ...(hostAccountOrigin ? { occurrenceId: hostAccountOrigin.custodyId, hostAccountOrigin } : {}) })];
                    }))),
                installedPackagesById: Object.freeze({ ...Object.fromEntries(bundles.map(bundle => [bundle.pluginId, {
                    id: bundle.pluginId, displayName: bundle.displayName,
                    version: bundle.pluginVersion, enabled: true, source: { kind: 'bundled' as const, locator: bundle.packageName },
                    ...(bundle.declaredExecution ? { declaredExecution: bundle.declaredExecution } : {}),
                }])), ...Object.fromEntries(selections.filter(selected => selected.manifest.contributes.actions?.some(action => action.execution.target === 'account'))
                    .map(selected => {
                        const bundle = bundles.find(candidate => candidate.pluginId === selected.manifest.id);
                        return [selected.manifest.id, { id: selected.manifest.id,
                        displayName: typeof selected.manifest.displayName === 'string' ? selected.manifest.displayName : selected.manifest.displayName.fallback,
                        version: selected.manifest.version, enabled: true,
                        source: selected.release ? { kind: 'archive', locator: selected.release.archiveDigestSha256 }
                            : { kind: 'bundled', locator: bundle!.packageName },
                        ...(bundle?.declaredExecution ? { declaredExecution: bundle.declaredExecution } : {}),
                    }]; })) }),
            }) : null;
        },
        readCurrentArtifact: (slot, executionOrigin, daemonProjectionSelection) => readCurrentArtifactAdmission(
            input.readState(),
            input.scope,
            slot,
            input.hostBundledUi,
            executionOrigin,
            daemonProjectionSelection,
        ),
        readCurrentHostedPublicationTarget: (slot) => readCurrentHostedPublicationAdmission(
            input.readState(),
            input.scope,
            slot,
        ),
        readCurrentHostedPackageAssetPublicationTarget: (packageAsset) => readCurrentHostedPackageAssetPublicationAdmission(
            input.readState(),
            input.scope,
            packageAsset,
        ),
        readCurrentPackageAsset: (packageAsset) => readCurrentPackageAssetAdmission(
            input.readState(),
            input.scope,
            packageAsset,
        ),
        readCurrentCollectionContract: (collection) => readCurrentCollectionContractAdmission(
            input.readState(),
            input.scope,
            collection,
            input.hostBundledUi ?? [],
        ),
        readCurrentAccountDataCapability: (plugin) => readCurrentAccountDataCapabilityAdmission(
            input.readState(),
            input.scope,
            plugin,
        ),
        readCurrentAccountKvCapability: (plugin) => readCurrentAccountKvCapabilityAdmission(
            input.readState(),
            input.scope,
            plugin,
            input.hostBundledUi,
        ),
        readCurrentSettingsDeclaration: (settings) => readCurrentSettingsDeclarationAdmission(
            input.readState(),
            input.scope,
            settings,
        ),
        readCurrentReleaseSelection: (selection) => readCurrentReleaseSelectionAdmission(
            input.readState(),
            input.scope,
            selection,
        ),
        readCurrentHostedArtifactAdministration: (selection) => readCurrentHostedArtifactAdministrationAdmission(
            input.readState(),
            input.scope,
            selection,
        ),
        classifyRelease: (materialization) => classifyMaterializationRelease(
            input.readState(),
            input.scope,
            materialization,
        ),
        readMaterializations: () => {
            const state = readDerivedState();
            return cache.materializations ??= readMaterializationAdmission(state, input.scope);
        },
        readInstalledPlugins: () => {
            const state = readDerivedState();
            return cache.installed ??= cache.lastInstalled = readInstalledPluginsAdmission(state, input.scope, cache.lastInstalled);
        },
        subscribe: input.subscribe,
    });
}

/**
 * A fixed Account/realm projection reader for currentness/materialization
 * facts. Byte materialization and renderer containment remain with their
 * concrete producers; this reader has no URL or cache-source selection path.
 */
export function createPluginAccountAvailabilityReader(input: Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
}>): PluginAccountAvailabilityReader {
    const state: AvailabilityProjectionState = Object.freeze({
        scope: Object.freeze({ ...input.scope }),
        snapshot: snapshotPluginAccountAvailabilitySnapshot(input.snapshot),
        stalePluginIds: Object.freeze([]),
    });
    return createBoundReader({
        scope: state.scope,
        readState: () => state,
        subscribe: () => () => {},
        hostBundledUi: input.hostBundledUi,
    });
}

/**
 * The live Account projection owner. Account-change consumers replace one
 * complete materialization snapshot; no renderer-specific selector is kept.
 */
export function createPluginAccountAvailabilityReaderStore(input: Readonly<{
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
}> = {}): PluginAccountAvailabilityReaderStore {
    let state: AvailabilityProjectionState | null = null;
    // Readers retain their own scope and fresh methods, while unchanged descriptive
    // models are shared at this producer across mounted and imperative readers.
    let projectionCache: Readonly<{ scope: ServerAccountScope; cache: AvailabilityReaderProjectionCache }> | undefined;
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) listener();
    };
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };
    return Object.freeze({
        replace: (input) => {
            const previous = state;
            const canMerge = previous !== null && areServerAccountScopesEqual(previous.scope, input.scope);
            const incoming = snapshotPluginAccountAvailabilitySnapshot(input.snapshot);
            const replacedMachineKeys = new Set(incoming.snapshots.map((entry) => `${entry.serverIdentityId}\0${entry.machineId}`));
            const retainedSnapshots = canMerge && incoming.inventoryComplete === false
                ? previous.snapshot.snapshots.filter((entry) => !replacedMachineKeys.has(`${entry.serverIdentityId}\0${entry.machineId}`))
                : [];
            const retainedMaterializations = canMerge && incoming.inventoryComplete === false
                ? previous.snapshot.materializations.filter((entry) => !replacedMachineKeys.has(`${entry.serverIdentityId}\0${entry.machineId}`))
                : [];
            const retainedReleases = canMerge && incoming.inventoryComplete === false
                ? (previous.snapshot.releases ?? []).filter(release => retainedMaterializations.some(
                    materialization => isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release),
                )) : [];
            const replacedPluginIds = new Set(incoming.intentReads.map((entry) => entry.pluginId));
            const retainedIntentReads = canMerge
                ? previous.snapshot.intentReads.filter((entry) => !replacedPluginIds.has(entry.pluginId))
                : [];
            const previousIntentReads = new Map(canMerge ? previous.snapshot.intentReads.map(entry => [entry.pluginId, entry]) : []);
            const intentReads = Object.freeze([...retainedIntentReads, ...incoming.intentReads]
                .map(entry => Object.freeze({ ...entry, response: Object.freeze({ ...entry.response,
                    release: retainUnchangedAvailabilityValue(previousIntentReads.get(entry.pluginId)?.response.release, entry.response.release),
                }) }))
                .sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
            const retainedPluginIds = new Set(intentReads.map((entry) => entry.pluginId));
            const stalePluginIds = new Set(canMerge ? previous.stalePluginIds : []);
            for (const pluginId of replacedPluginIds) stalePluginIds.delete(pluginId);
            if (input.intentCensusIncomplete) {
                for (const entry of retainedIntentReads) stalePluginIds.add(entry.pluginId);
            }
            for (const pluginId of input.failedPluginIds ?? []) {
                if (retainedPluginIds.has(pluginId)) stalePluginIds.add(pluginId);
            }
            state = Object.freeze({
                scope: Object.freeze({ ...input.scope }),
                retiredPluginIds: canMerge ? previous.retiredPluginIds?.filter(pluginId => !replacedPluginIds.has(pluginId)) : [],
                stalePluginIds: Object.freeze([...stalePluginIds].sort((left, right) => left.localeCompare(right))),
                snapshot: Object.freeze({
                    ...incoming,
                    availabilityCursor: Math.max(
                        incoming.availabilityCursor,
                        ...incoming.intentReads.map((entry) => entry.response.availabilityCursor),
                        ...(canMerge ? retainedIntentReads.map((entry) => entry.response.availabilityCursor) : []),
                    ),
                    intentReads,
                    snapshots: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.snapshots : undefined,
                        Object.freeze([...retainedSnapshots, ...incoming.snapshots])),
                    materializations: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.materializations : undefined,
                        Object.freeze([...retainedMaterializations, ...incoming.materializations])),
                    releases: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.releases : undefined,
                        Object.freeze([...retainedReleases, ...(incoming.releases ?? [])])),
                }),
            });
            notify();
            return previous;
        },
        clear: () => {
            const previous = state;
            state = null;
            projectionCache = undefined;
            notify();
            return previous;
        },
        retire: (pluginIds) => {
            if (!state || pluginIds.length === 0) return;
            const retired = new Set(pluginIds);
            const intentReads = state.snapshot.intentReads.filter((entry) => !retired.has(entry.pluginId));
            state = Object.freeze({
                scope: state.scope,
                snapshot: Object.freeze({ ...state.snapshot, intentReads: Object.freeze(intentReads) }),
                stalePluginIds: Object.freeze(state.stalePluginIds.filter((pluginId) => !retired.has(pluginId))),
                retiredPluginIds: Object.freeze([...new Set([...(state.retiredPluginIds ?? []), ...pluginIds])]),
            });
            notify();
        },
        getSnapshot: () => state,
        subscribe,
        bind: (scope) => {
            const scoped = projectionCache && areServerAccountScopesEqual(projectionCache.scope, scope)
                ? projectionCache : { scope: Object.freeze({ ...scope }), cache: {} };
            if (!state || areServerAccountScopesEqual(state.scope, scope)) projectionCache = scoped;
            return createBoundReader({
                scope: scoped.scope,
                readState: () => state,
                subscribe,
                hostBundledUi: input.hostBundledUi,
                projectionCache: scoped.cache,
            });
        },
    });
}
