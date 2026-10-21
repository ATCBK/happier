import type {
    DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginProjectedWorkItemsEntryV1Schema, type PluginProjectedWorkItemsEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { PluginDeclaredUiEntriesV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { PluginUiWidgetAreaDeclarationsV1Schema, type PluginUiWidgetAreaDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/ui/widgetAreas';
import { PluginLocalizedStringV2Schema, PluginPolicyExpressionV2Schema, type PluginPolicyExpressionV2, type PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { PluginContributionLocalIdSchema, PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey, createPluginContributionIdentity, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginUiIconTokenV1Schema, type PluginUiIconTokenV1 } from '@happier-dev/protocol/plugins/contributions/ui/tokens';
import { OpenableContentViewerSelectorV1Schema, type OpenableContentViewerSelectorV1 } from '@happier-dev/protocol/plugins/openableContentViewerV1';
import { RecipientContractV1Schema } from '@happier-dev/protocol/plugins/recipientContractV1';
import { VoiceProviderContributionSchema, type VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import { PluginProjectedDragSourceEntryV1Schema, PluginProjectedDropTargetEntryV1Schema, type PluginProjectedDragSourceEntryV1, type PluginProjectedDropTargetEntryV1, type PluginProjectionInstalledPackageV2, type PluginProjectedActionV2, type PluginProjectedResourceV2, type PluginProjectedComposerAttachmentEntryV1, type PluginProjectedComposerControlEntryV1, type PluginProjectedComposerRegionEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginJsonSchemaValidator } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    createPluginSessionInfoSectionRendererIdV1,
    isPluginUiSurfaceBindingPotentiallySupportedOnPlatformV1,
    PluginUiResolvedSemanticCommandV1Schema,
    PluginUiDestinationBindingV1Schema,
    PluginUiInlineSurfaceBindingV1Schema,
    PluginUiQualifiedActionReferenceV1Schema,
    PluginUiSurfaceBindingV1Schema,
    PluginUiDestinationReferenceV1Schema,
    type PluginUiDestinationBindingV1,
    type PluginUiInlineSurfaceBindingV1,
    type PluginUiPlatformV1,
    type PluginUiSurfaceBindingV1,
    type PluginUiDestinationReferenceV1,
    type PluginUiResolvedSemanticCommandV1,
} from '@happier-dev/protocol/plugins/ui';

type UnknownRecord = Readonly<Record<string, unknown>>;

/** Observation time remains an Availability fact, not an input to UI declarations. */
export function samePluginUiMaterializationFacts(left: PluginMachineMaterializationV1 | undefined, right: PluginMachineMaterializationV1 | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const { observedAt: _leftObservedAt, ...leftFacts } = left;
    const { observedAt: _rightObservedAt, ...rightFacts } = right;
    return sameStrictJsonValue(leftFacts, rightFacts);
}

export function arePluginUiMaterializationsEquivalent(
    left: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
    right: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
): boolean {
    if (left === right) return true;
    const keys = Object.keys(left ?? {});
    return keys.length === Object.keys(right ?? {}).length
        && keys.every(key => Object.hasOwn(right ?? {}, key) && samePluginUiMaterializationFacts(left?.[key], right?.[key]));
}

/** Declaration facts for cold presentation; never an occurrence or execution grant. */
export type PluginUiDeclaredExecution = Readonly<{
    daemonActions: boolean;
    contributionPoints: boolean;
}>;
export type PluginUiInstalledPackageProjection = PluginProjectionInstalledPackageV2 & Readonly<{
    declaredExecution?: PluginUiDeclaredExecution;
}>;
export type PluginUiDragSourceProjection = PluginProjectedDragSourceEntryV1 & UnknownRecord;
export type PluginUiDropTargetProjection = PluginProjectedDropTargetEntryV1 & UnknownRecord;
export type PluginUiWorkItemsProjection = PluginProjectedWorkItemsEntryV1 & UnknownRecord;
export type PluginUiInputTypeProjection = NonNullable<DaemonContributionRegistryProjection['familiesById']['inputTypes']>['entriesById'][string];
export type PluginUiAtmospherePictureProjection = NonNullable<DaemonContributionRegistryProjection['familiesById']['atmospherePictures']>['entriesById'][string];
export type PluginUiRegistrySourceProjection = NonNullable<DaemonContributionRegistryProjection['familiesById']['registrySources']>['entriesById'][string];
export type PluginUiSkillProjection = NonNullable<DaemonContributionRegistryProjection['familiesById']['skills']>['entriesById'][string];

/**
 * The OS-level platform every plugin UI projection is normalized for.
 *
 * It lives with the projection because admission is a projection decision, and
 * because a second `Platform.OS` mapping beside the canonical local-service
 * resolver would be exactly the split brain the constitution forbids. The
 * currentness owner re-exports this so its consumers keep one spelling.
 */
export function resolvePluginUiProjectionPlatform(): LocalServicePreviewPlatform {
    return resolveLocalServicePreviewPlatform();
}

/** Desktop uses the same executable artifacts as React Native Web. */
export function resolvePluginUiClientExecutablePlatform(): PluginContributionClientPlatform {
    const platform = resolvePluginUiProjectionPlatform();
    return platform === 'desktop' ? 'web' : platform;
}

export type PluginUiTranslationsProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'translations';
    locales: readonly string[];
}>;

export type PluginUiSessionHeaderActionProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'sessionHeaderAction';
    descriptorId: string;
    title: PluginLocalizedStringV2;
    /** Closed semantic icon token admitted by the Registry projection. */
    icon?: PluginUiIconTokenV1;
    /**
     * The registry resolves authored local identifiers before this projection
     * reaches UI. Consumers retain that qualified semantic command verbatim,
     * rather than recreating action or destination qualification locally.
     */
    command: PluginUiResolvedSemanticCommandV1;
}>;

/**
 * One admitted Universal Search provider.
 *
 * It carries identity and the daemon-resolved qualified query Action, and
 * nothing more: the section's title, icon, availability, execution target and
 * currentness are the referenced Action's projected facts, read from
 * `actionsById` by the one host adapter that renders the section.
 */
export type PluginUiSearchProviderProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    occurrenceId: string;
    contributionKind: 'searchProvider';
    descriptorId: string;
    identity: PluginContributionIdentityV1;
    action: PluginContributionIdentityV1;
}>;

export type PluginUiHostedWebProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    occurrenceId?: string;
    contributionKind: 'hostedWeb';
    contributionId: string;
}>;

export type PluginUiReactNativeBundleProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'reactNativeBundle';
    contributionId: string;
}>;

export type PluginUiSurfaceAvailabilityProjection = Readonly<{
    /** `resolving` is host-derived execution selection, never a daemon wire state. */
    state: 'available' | 'fallback' | 'blocked' | 'disabled' | 'resolving';
    reason: string;
    diagnostics: readonly string[];
    when?: PluginPolicyExpressionV2;
    disabledWhen?: PluginPolicyExpressionV2;
}>;

/**
 * Static app-page header metadata from the daemon-normalized V2 placement.
 *
 * The command is already qualified by the Registry producer. UI validates the
 * strict projected shape here so chrome consumers cannot reinterpret local
 * action or destination ids while rendering a fragile host header.
 */
export type PluginUiPageHeaderActionProjection = Readonly<{
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    order?: number;
    command: PluginUiResolvedSemanticCommandV1;
}>;

type PluginUiSurfacePlacementProjectionFields = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    /** Exact process-local occurrence projected with this contribution row. */
    occurrenceId?: string;
    contributionKind: 'surfacePlacement';
    descriptorId: string;
    /**
     * The V2 producer publishes this binding verbatim. It is deliberately not
     * re-normalized or reconstructed by UI consumers: the registry/CLI
     * projection owns admission and target/container pairing, while collision
     * admission remains at the registry before projection.
     */
    binding: PluginUiSurfaceBindingV1;
    target: UnknownRecord;
    renderer: UnknownRecord;
    display: UnknownRecord;
    /**
     * Admitted runtime facts projected by the daemon (including Resource
     * capability). UI retains this record verbatim; it is not a second runtime
     * capability normalizer.
     */
    runtime?: UnknownRecord;
    availability: PluginUiSurfaceAvailabilityProjection;
    headerActions: readonly PluginUiPageHeaderActionProjection[];
    rightSidebar?: UnknownRecord;
    /** An app page's own shell column: its admitted binding, renderer and availability. */
    column?: PluginUiAppPageColumnProjection;
    widgetAreas?: readonly PluginUiWidgetAreaDeclarationV1[];
}>;

export type PluginUiAppPageColumnProjection = Readonly<{
    binding: PluginUiDestinationBindingV1;
    renderer: UnknownRecord;
    availability: PluginUiSurfaceAvailabilityProjection;
}>;

/** A navigable placement. Destination consumers must name this arm explicitly. */
export type PluginUiSurfacePlacementProjection = PluginUiSurfacePlacementProjectionFields & Readonly<{
    binding: PluginUiDestinationBindingV1;
}>;

/** A physical inline mount; it has no navigation or restoration identity. */
export type PluginUiInlineSurfacePlacementProjection = PluginUiSurfacePlacementProjectionFields & Readonly<{
    binding: PluginUiInlineSurfaceBindingV1;
}>;

/** The one daemon-projected physical host carrier. */
export type PluginUiPhysicalSurfacePlacementProjection =
    | PluginUiSurfacePlacementProjection
    | PluginUiInlineSurfacePlacementProjection;

export function isPluginUiDestinationSurfacePlacementProjection(
    placement: PluginUiPhysicalSurfacePlacementProjection,
): placement is PluginUiSurfacePlacementProjection {
    return placement.binding.kind === 'destination';
}

/**
 * One daemon-admitted openable-content viewer declaration. This preserves the
 * projected selector and qualified destination; the file-details owner joins
 * that destination to the current surface placement before it can mount.
 */
export type PluginUiOpenableContentViewerProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'openableContentViewer';
    descriptorId: string;
    identity: PluginContributionIdentityV1;
    viewer: OpenableContentViewerSelectorV1;
    destination: PluginUiDestinationReferenceV1;
}>;

/**
 * A V2 Settings group as admitted by the daemon Registry. The UI keeps the
 * authored metadata as projected data and lets the Settings catalog own group
 * placement and display resolution; it does not reconstruct a Settings group
 * from a legacy placement or a local route.
 */
export type PluginUiSettingsGroupProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'settingsGroup';
    group: UnknownRecord;
}>;

/**
 * A real V2 Settings destination. Its `binding` is the Registry-produced
 * `settingsPage × app` binding, carried verbatim so both the Settings catalog
 * and generic route consume the same canonical destination identity.
 */
export type PluginUiSettingsPageProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'settingsPage';
    descriptorId: string;
    page: UnknownRecord;
    binding: PluginUiDestinationBindingV1;
    renderer: UnknownRecord;
    availability: PluginUiSurfaceAvailabilityProjection;
}>;

/**
 * One Registry-normalized destination projection that the qualified host
 * navigation resolver may admit. Settings pages are not surface placements,
 * but retain the same binding, availability, and stamped-origin contract.
 */
export type PluginUiDestinationProjection =
    | PluginUiSurfacePlacementProjection
    | PluginUiSettingsPageProjection;

/** One daemon-admitted, same-plugin dynamic Resource profile for the synthetic transcript tail. */
export type PluginUiTranscriptActivityProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    occurrenceId: string;
    contributionKind: 'transcriptActivity';
    descriptorId: string;
    resource: Readonly<{ pluginId: string; localId: string }>;
    actions: readonly Readonly<{ pluginId: string; localId: string }>[];
}>;

/** One daemon-admitted, Resource-backed declarative section for Session info. */
export type PluginUiSessionInfoSectionProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    pluginVersion: string;
    contributionKind: 'sessionInfoSection';
    descriptorId: string;
    order?: number;
    resource: Readonly<{ pluginId: string; localId: string }>;
    actions: readonly Readonly<{ pluginId: string; localId: string }>[];
    renderer: UnknownRecord;
    runtime?: UnknownRecord;
    placement: PluginUiInlineSurfacePlacementProjection;
}>;

export type PluginVoiceProviderProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    occurrenceId: string;
    contributionKey: string;
    definition: VoiceProviderContribution;
    recipientContract?: import('@happier-dev/protocol').RecipientContractV1;
    recipientContractDigest?: string;
}>;

/**
 * Daemon-admitted Action facts retained for the one client executable
 * composition owner. This is a projection carrier, not a UI-local Action
 * catalog or target normalizer.
 */
export type PluginUiActionProjection = UnknownRecord & PluginProjectedActionV2;

/** One daemon-admitted Resource declaration carried without reinterpretation. */
export type PluginUiResourceProjection = UnknownRecord & PluginProjectedResourceV2;

/**
 * One exact lookup over the daemon-admitted raw Action projection. Consumers
 * receive no reconstructed target or availability decision: identity, key, and
 * descriptor must agree or the lookup fails closed.
 */
export type PluginUiProjectedActionResolver = (
    identity: PluginContributionIdentityV1,
) => PluginProjectedActionV2 | null;

/** One fail-closed executability decision for every projected Action consumer. */
export function isPluginProjectedActionExecutable<
    TAction extends Readonly<{ available?: boolean | null }>,
>(
    action: TAction | null | undefined,
): action is TAction {
    return action?.available === true;
}

export function createPluginUiProjectedActionResolver(
    actionsById: Readonly<Record<string, PluginProjectedActionV2>> | null | undefined,
): PluginUiProjectedActionResolver {
    return (identity) => {
        const action = actionsById?.[buildQualifiedPluginContributionKey(identity)] ?? null;
        return action
            && action.pluginId === identity.pluginId
            && action.id === identity.localId
            ? action
            : null;
    };
}

/**
 * One daemon-admitted Composer attachment declaration plus the exact
 * validator compiled for this UI projection's schema/generation lifetime.
 * The executable validator is host-private projection state, not a new wire
 * shape or Composer-local catalog.
 */
export type PluginUiComposerAttachmentProjection = Readonly<
    PluginProjectedComposerAttachmentEntryV1 & {
        valueValidator: PluginJsonSchemaValidator | null;
    }
>;

export type PluginUiProjectionModel = Readonly<{
    /** Host-private initial describe facts; these never admit an execution origin. */
    establishingExecutionTargetsByPluginId?: Readonly<Record<string, readonly MachineAdministrationTargetV1[]>>;
    /** Current daemon diagnostics remain scoped to their reporting Machine. */
    diagnostics?: Readonly<DaemonContributionRegistryProjection['diagnostics']>;
    generation: number | null;
    /**
     * Daemon-admitted package facts needed by the presentation host. The UI
     * carries this record verbatim enough to preserve the package/Artifact
     * owner's brand identity; it never derives a mark from plugin metadata.
     */
    installedPackagesById: Readonly<Record<string, PluginUiInstalledPackageProjection>>;
    translationsByPluginId: Readonly<Record<string, PluginUiTranslationsProjection>>;
    sessionHeaderActionsById: Readonly<Record<string, PluginUiSessionHeaderActionProjection>>;
    searchProvidersById: Readonly<Record<string, PluginUiSearchProviderProjection>>;
    hostedWebById: Readonly<Record<string, PluginUiHostedWebProjection>>;
    reactNativeBundlesById: Readonly<Record<string, PluginUiReactNativeBundleProjection>>;
    surfacePlacementsById: Readonly<Record<string, PluginUiPhysicalSurfacePlacementProjection>>;
    openableContentViewersById: Readonly<Record<string, PluginUiOpenableContentViewerProjection>>;
    settingsGroupsById: Readonly<Record<string, PluginUiSettingsGroupProjection>>;
    settingsPagesById: Readonly<Record<string, PluginUiSettingsPageProjection>>;
    transcriptActivitiesById: Readonly<Record<string, PluginUiTranscriptActivityProjection>>;
    sessionInfoSectionsById: Readonly<Record<string, PluginUiSessionInfoSectionProjection>>;
    /**
     * The three Composer maps retain only daemon-admitted static declarations.
     * Document state, picker state, effect dispatch, and surface lifecycle stay
     * with their existing owners; this model is the one UI catalog projection.
     */
    composerAttachmentsById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>;
    composerControlsById: Readonly<Record<string, PluginProjectedComposerControlEntryV1>>;
    composerRegionsById: Readonly<Record<string, PluginProjectedComposerRegionEntryV1>>;
    actionsById: Readonly<Record<string, PluginUiActionProjection>>;
    /** Exact current Resource declarations for host-owned qualified consumers. */
    resourcesById: Readonly<Record<string, PluginUiResourceProjection>>;
    machineProvisionersById: NonNullable<DaemonContributionRegistryProjection['familiesById']['machineProvisioners']>['entriesById'];
    inputTypesById: Readonly<Record<string, PluginUiInputTypeProjection>>;
    atmospherePicturesById: Readonly<Record<string, PluginUiAtmospherePictureProjection>>;
    registrySourcesById: Readonly<Record<string, PluginUiRegistrySourceProjection>>;
    skillsById: Readonly<Record<string, PluginUiSkillProjection>>;
    voiceProvidersById: Readonly<Record<string, PluginVoiceProviderProjection>>;
    dragSourcesById: Readonly<Record<string, PluginUiDragSourceProjection>>;
    workItemsById: Readonly<Record<string, PluginUiWorkItemsProjection>>;
    dropTargetsById: Readonly<Record<string, PluginUiDropTargetProjection>>;
    unknownEntriesById: Readonly<Record<string, UnknownRecord>>;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION: PluginUiProjectionModel = Object.freeze({
    generation: null,
    installedPackagesById: Object.freeze({}),
    translationsByPluginId: Object.freeze({}),
    sessionHeaderActionsById: Object.freeze({}),
    searchProvidersById: Object.freeze({}),
    hostedWebById: Object.freeze({}),
    reactNativeBundlesById: Object.freeze({}),
    surfacePlacementsById: Object.freeze({}),
    openableContentViewersById: Object.freeze({}),
    settingsGroupsById: Object.freeze({}),
    settingsPagesById: Object.freeze({}),
    transcriptActivitiesById: Object.freeze({}),
    sessionInfoSectionsById: Object.freeze({}),
    composerAttachmentsById: Object.freeze({}),
    composerControlsById: Object.freeze({}),
    composerRegionsById: Object.freeze({}),
    actionsById: Object.freeze({}),
    resourcesById: Object.freeze({}),
    machineProvisionersById: Object.freeze({}),
    inputTypesById: Object.freeze({}),
    atmospherePicturesById: Object.freeze({}),
    registrySourcesById: Object.freeze({}),
    skillsById: Object.freeze({}),
    voiceProvidersById: Object.freeze({}),
    dragSourcesById: Object.freeze({}),
    workItemsById: Object.freeze({}),
    dropTargetsById: Object.freeze({}),
    unknownEntriesById: Object.freeze({}),
});

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
}

function normalizeInstalledPackagesById(
    installedPackagesById: Readonly<Record<string, PluginUiInstalledPackageProjection>>,
): Readonly<Record<string, PluginUiInstalledPackageProjection>> {
    return Object.freeze(Object.fromEntries(Object.entries(installedPackagesById).map(([pluginId, installedPackage]) => [
        pluginId,
        Object.freeze({
            ...installedPackage,
            source: Object.freeze({ ...installedPackage.source }),
            ...(installedPackage.declaredExecution ? { declaredExecution: Object.freeze({ ...installedPackage.declaredExecution }) } : {}),
            ...(installedPackage.brand === undefined
                ? {}
                : {
                    brand: Object.freeze({
                        ...installedPackage.brand,
                        ...(installedPackage.brand.state === 'available'
                            ? { resource: Object.freeze({ ...installedPackage.brand.resource }) }
                            : {}),
                    }),
                }),
        }),
    ])));
}

function isTranslations(entry: UnknownRecord): entry is PluginUiTranslationsProjection {
    return entry.contributionKind === 'translations'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null;
}

type PluginUiSessionHeaderActionProjectionCandidate = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'sessionHeaderAction';
    descriptorId: string;
}>;

function isSessionHeaderAction(entry: UnknownRecord): entry is PluginUiSessionHeaderActionProjectionCandidate {
    return entry.contributionKind === 'sessionHeaderAction'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null;
}

function resolveSessionHeaderAction(
    entry: UnknownRecord,
): PluginUiSessionHeaderActionProjection | null {
    if (!isSessionHeaderAction(entry)) {
        return null;
    }
    const title = PluginLocalizedStringV2Schema.safeParse(entry.title);
    const icon = entry.icon === undefined
        ? null
        : PluginUiIconTokenV1Schema.safeParse(entry.icon);
    const command = PluginUiResolvedSemanticCommandV1Schema.safeParse(entry.command);
    if (!title.success || (icon !== null && !icon.success) || !command.success) {
        return null;
    }
    return Object.freeze({
        ...entry,
        title: title.data,
        ...(icon?.success ? { icon: icon.data } : {}),
        command: command.data,
    });
}

/**
 * A malformed or unqualified descriptor is dropped rather than repaired. A
 * provider whose Action reference cannot be read has no reachable executor, and
 * inventing one would be the second decision-maker this family exists to avoid.
 */
function resolveSearchProvider(entry: UnknownRecord): PluginUiSearchProviderProjection | null {
    if (entry.contributionKind !== 'searchProvider') return null;
    const id = readString(entry.id);
    const pluginId = readString(entry.pluginId);
    const occurrenceId = readString(entry.occurrenceId);
    const descriptorId = readString(entry.descriptorId);
    const identity = PluginContributionIdentityV1Schema.safeParse(entry.identity);
    const action = PluginUiQualifiedActionReferenceV1Schema.safeParse(entry.action);
    if (id === null || pluginId === null || occurrenceId === null || descriptorId === null || !identity.success || !action.success) return null;
    if (
        id !== `searchProvider:${pluginId}:${descriptorId}`
        || identity.data.pluginId !== pluginId
        || identity.data.localId !== descriptorId
        || action.data.pluginId !== pluginId
    ) return null;
    return Object.freeze({
        // Preserve the producer-owned execution origin. The app projection
        // union uses these exact stamps to admit the Administration-selected
        // materialization; reconstructing the descriptor without them makes a
        // valid selected Search provider look originless and drops it.
        ...entry,
        occurrenceId,
        id,
        pluginId,
        contributionKind: 'searchProvider' as const,
        descriptorId,
        identity: identity.data,
        action: action.data,
    });
}

function resolvePluginUiPageHeaderAction(
    value: unknown,
): PluginUiPageHeaderActionProjection | null {
    const entry = asRecord(value);
    if (!entry) return null;
    // The daemon projection is strict at ingress. This consumer validates its
    // public field leaves again but leaves the resolved semantic action itself
    // to the Protocol schema; it never recreates local-id qualification here.
    const id = PluginContributionLocalIdSchema.safeParse(entry.id);
    const title = PluginLocalizedStringV2Schema.safeParse(entry.title);
    const description = entry.description === undefined
        ? null
        : PluginLocalizedStringV2Schema.safeParse(entry.description);
    const icon = entry.icon === undefined
        ? null
        : PluginUiIconTokenV1Schema.safeParse(entry.icon);
    const order = entry.order === undefined
        ? null
        : typeof entry.order === 'number' && Number.isInteger(entry.order)
            ? entry.order
            : false;
    const command = PluginUiResolvedSemanticCommandV1Schema.safeParse(entry.command);
    if (
        !id.success
        || !title.success
        || (description !== null && !description.success)
        || (icon !== null && !icon.success)
        || order === false
        || !command.success
    ) {
        return null;
    }
    return Object.freeze({
        id: id.data,
        title: title.data,
        ...(description?.success ? { description: description.data } : {}),
        ...(icon?.success ? { icon: icon.data } : {}),
        ...(order === null ? {} : { order }),
        command: command.data,
    });
}

function resolvePluginUiPageHeaderActions(value: unknown): readonly PluginUiPageHeaderActionProjection[] {
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(value.flatMap((entry) => {
        const headerAction = resolvePluginUiPageHeaderAction(entry);
        return headerAction ? [headerAction] : [];
    }));
}

function isHostedWeb(entry: UnknownRecord): entry is PluginUiHostedWebProjection {
    return entry.contributionKind === 'hostedWeb'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.occurrenceId) !== null
        && readString(entry.contributionId) !== null;
}

function isReactNativeBundle(entry: UnknownRecord): entry is PluginUiReactNativeBundleProjection {
    return entry.contributionKind === 'reactNativeBundle'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.contributionId) !== null;
}

function readSurfaceAvailability(value: unknown): PluginUiSurfaceAvailabilityProjection | null {
    const availability = asRecord(value);
    const state = readString(availability?.state);
    const reason = readString(availability?.reason);
    if (
        (state !== 'available' && state !== 'fallback' && state !== 'blocked' && state !== 'disabled')
        || reason === null
    ) {
        return null;
    }
    const when = availability?.when === undefined ? null : PluginPolicyExpressionV2Schema.safeParse(availability.when);
    const disabledWhen = availability?.disabledWhen === undefined ? null : PluginPolicyExpressionV2Schema.safeParse(availability.disabledWhen);
    if (when?.success === false || disabledWhen?.success === false) return null;
    return Object.freeze({
        state,
        reason,
        diagnostics: Object.freeze(readStringArray(availability?.diagnostics)),
        ...(when?.success ? { when: when.data } : {}),
        ...(disabledWhen?.success ? { disabledWhen: disabledWhen.data } : {}),
    });
}

function readAppPageColumn(value: unknown): PluginUiAppPageColumnProjection | undefined {
    const column = asRecord(value);
    const binding = column?.binding;
    const renderer = asRecord(column?.renderer);
    const availability = readSurfaceAvailability(column?.availability);
    return isNormalizedPluginUiDestinationBinding(binding) && renderer && availability
        ? Object.freeze({ binding, renderer: Object.freeze({ ...renderer }), availability })
        : undefined;
}

function isNormalizedPluginUiDestinationBinding(
    value: unknown,
): value is PluginUiDestinationBindingV1 {
    return PluginUiDestinationBindingV1Schema.safeParse(value).success;
}

function isNormalizedPluginUiSurfaceBinding(
    value: unknown,
): value is PluginUiSurfaceBindingV1 {
    return PluginUiSurfaceBindingV1Schema.safeParse(value).success;
}

function isSurfacePlacement(entry: UnknownRecord): entry is PluginUiPhysicalSurfacePlacementProjection {
    return entry.contributionKind === 'surfacePlacement'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null
        // The CLI projection has one already-admitted binding. Do not call a
        // client-side normalizer here: the daemon projection owns that
        // normalization and consumers retain its exact object identity.
        && isNormalizedPluginUiSurfaceBinding(entry.binding)
        && asRecord(entry.target) !== null
        && asRecord(entry.renderer) !== null
        && asRecord(entry.display) !== null
        && readSurfaceAvailability(entry.availability) !== null;
}

function resolveOpenableContentViewer(
    entry: UnknownRecord,
): PluginUiOpenableContentViewerProjection | null {
    const pluginId = readString(entry.pluginId);
    const descriptorId = readString(entry.descriptorId);
    if (
        entry.contributionKind !== 'openableContentViewer'
        || pluginId === null
        || descriptorId === null
        || readString(entry.id) !== `openableContentViewer:${pluginId}:${descriptorId}`
    ) {
        return null;
    }
    const identity = PluginContributionIdentityV1Schema.safeParse(entry.identity);
    const viewer = OpenableContentViewerSelectorV1Schema.safeParse(entry.viewer);
    const destination = PluginUiDestinationReferenceV1Schema.safeParse(entry.destination);
    if (
        !identity.success
        || identity.data.pluginId !== pluginId
        || identity.data.localId !== descriptorId
        || !viewer.success
        || !destination.success
        || destination.data.pluginId !== pluginId
    ) {
        return null;
    }
    return Object.freeze({
        ...entry,
        identity: Object.freeze({ ...identity.data }),
        viewer: Object.freeze({
            contentClasses: Object.freeze([...viewer.data.contentClasses]),
            ...(viewer.data.mimeTypes === undefined ? {} : { mimeTypes: Object.freeze([...viewer.data.mimeTypes]) }),
            ...(viewer.data.extensions === undefined ? {} : { extensions: Object.freeze([...viewer.data.extensions]) }),
        }),
        destination: Object.freeze({ ...destination.data }),
    }) as PluginUiOpenableContentViewerProjection;
}

function isProjectedIdentityForPlugin(
    value: unknown,
    pluginId: string,
    localId?: string,
): boolean {
    const identity = asRecord(value);
    const projectedPluginId = readString(identity?.pluginId);
    const projectedLocalId = readString(identity?.localId);
    return projectedPluginId === pluginId
        && projectedLocalId !== null
        && (localId === undefined || projectedLocalId === localId);
}

function isSettingsGroup(entry: UnknownRecord): entry is PluginUiSettingsGroupProjection {
    const pluginId = readString(entry.pluginId);
    const group = asRecord(entry.group);
    return entry.contributionKind === 'settingsGroup'
        && readString(entry.id) !== null
        && pluginId !== null
        && group !== null
        && isProjectedIdentityForPlugin(group.id, pluginId);
}

function isSettingsPage(entry: UnknownRecord): entry is PluginUiSettingsPageProjection {
    const pluginId = readString(entry.pluginId);
    const descriptorId = readString(entry.descriptorId);
    const page = asRecord(entry.page);
    const group = asRecord(page?.group);
    const groupKind = readString(group?.kind);
    const pluginGroupMatches = groupKind === 'plugin'
        && isProjectedIdentityForPlugin(group?.id, pluginId ?? '');
    const hostGroupMatches = groupKind === 'host' && readString(group?.id) !== null;
    return entry.contributionKind === 'settingsPage'
        && readString(entry.id) !== null
        && pluginId !== null
        && descriptorId !== null
        && page !== null
        && isProjectedIdentityForPlugin(page.id, pluginId, descriptorId)
        && (pluginGroupMatches || hostGroupMatches)
        // As with surface placements, the UI verifies the daemon's already
        // admitted binding but never creates its own replacement.
        && isNormalizedPluginUiDestinationBinding(entry.binding)
        && asRecord(entry.renderer) !== null
        && readSurfaceAvailability(entry.availability) !== null;
}

function isTranscriptActivity(entry: UnknownRecord): entry is PluginUiTranscriptActivityProjection {
    const pluginId = readString(entry.pluginId);
    const descriptorId = readString(entry.descriptorId);
    if (
        entry.contributionKind !== 'transcriptActivity'
        || readString(entry.id) !== `transcriptActivity:${pluginId}:${descriptorId}`
        || pluginId === null
        || descriptorId === null
    ) {
        return false;
    }
    const resource = PluginContributionIdentityV1Schema.safeParse(entry.resource);
    if (!resource.success || resource.data.pluginId !== pluginId) return false;
    if (!Array.isArray(entry.actions)) return false;
    return entry.actions.every((action) => {
        const parsed = PluginContributionIdentityV1Schema.safeParse(action);
        return parsed.success && parsed.data.pluginId === pluginId;
    });
}

function isSessionInfoSection(entry: UnknownRecord): entry is PluginUiSessionInfoSectionProjection {
    const pluginId = readString(entry.pluginId);
    const descriptorId = readString(entry.descriptorId);
    if (
        entry.contributionKind !== 'sessionInfoSection'
        || readString(entry.id) !== `sessionInfoSection:${pluginId}:${descriptorId}`
        || pluginId === null
        || descriptorId === null
        || readString(entry.pluginVersion) === null
        || asRecord(entry.renderer) === null
    ) return false;
    const placement = asRecord(entry.placement);
    if (!placement || !isSurfacePlacement(placement)) return false;
    const binding = placement.binding;
    const renderer = asRecord(entry.renderer);
    const expectedRendererId = createPluginSessionInfoSectionRendererIdV1(descriptorId);
    if (
        placement.pluginId !== pluginId
        || placement.descriptorId !== descriptorId
        || binding.kind !== 'inline'
        || binding.role !== 'sessionInfoSection'
        || binding.targetKind !== 'session'
        || binding.target.kind !== 'session'
        || binding.surface.pluginId !== pluginId
        || binding.surface.localId !== descriptorId
        || binding.renderer.pluginId !== pluginId
        || binding.renderer.localId !== expectedRendererId
        || readString(renderer?.contributionId) !== expectedRendererId
    ) return false;
    const resource = PluginContributionIdentityV1Schema.safeParse(entry.resource);
    if (!resource.success || resource.data.pluginId !== pluginId || !Array.isArray(entry.actions)) return false;
    return entry.actions.every((action) => {
        const parsed = PluginContributionIdentityV1Schema.safeParse(action);
        return parsed.success && parsed.data.pluginId === pluginId;
    });
}

function normalizeComposerAttachmentEntriesById(
    entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>> | undefined,
    previous?: PluginUiProjectionModel['composerAttachmentsById'],
): Readonly<Record<string, PluginUiComposerAttachmentProjection>> {
    const normalized: Record<string, PluginUiComposerAttachmentProjection> = {};
    for (const [entryId, entry] of Object.entries(entriesById ?? {})) {
        const previousEntry = previous?.[entryId];
        if (previousEntry) {
            const { valueValidator: _validator, ...declaration } = previousEntry;
            if (sameStrictJsonValue(declaration, entry)) {
                normalized[entryId] = previousEntry;
                continue;
            }
        }
        let valueValidator: PluginJsonSchemaValidator | null = null;
        try {
            valueValidator = compilePluginJsonSchema(entry.definition.valueSchema);
        } catch {
            // The daemon-admitted declaration remains available as a visible
            // fallback, but a malformed static schema cannot make a persisted
            // attachment sendable.
        }
        normalized[entryId] = Object.freeze({ ...entry, valueValidator });
    }
    return Object.freeze(normalized);
}

/**
 * Normalize one daemon projection for exactly one client platform.
 *
 * The platform is a parameter rather than a caller-side filter so every
 * projection consumer — live describe, warm-cache rehydration, app union,
 * catalogs and pickers — sees the same admitted set. It defaults to this
 * client's own platform so a caller cannot opt out of the gate by omission.
 */
type PluginUiProjectionNormalizationInput = Omit<DaemonContributionRegistryProjection, 'generation' | 'familiesById'> & Readonly<{
    generation: number | null;
    familiesById: Omit<DaemonContributionRegistryProjection['familiesById'], 'pluginUi'> & Readonly<{
        pluginUi?: Readonly<{ family: 'pluginUi'; entriesById: PluginDeclaredUiEntriesV1 | NonNullable<DaemonContributionRegistryProjection['familiesById']['pluginUi']>['entriesById'] }>;
    }>;
}>;

/** Reuses Registry-normalized presentation; installed declarations carry no live occurrence. */
export function normalizePluginInstalledUiDeclarations(
    entriesById: PluginDeclaredUiEntriesV1,
    platform?: PluginUiPlatformV1,
    installedPackage?: PluginUiInstalledPackageProjection,
    registrySources?: readonly PluginUiRegistrySourceProjection[],
    skills?: readonly PluginUiSkillProjection[],
): PluginUiProjectionModel {
    return normalizePluginUiProjection({
        v: 2, generation: null,
        installedPackagesById: installedPackage ? { [installedPackage.id]: installedPackage } : {}, agentsById: {}, actionsById: {}, toolsById: {},
        commandsById: {}, resourcesById: {}, settingsById: {},
        familiesById: { pluginUi: { family: 'pluginUi', entriesById }, ...(registrySources ? { registrySources: {
            family: 'registrySources' as const, entriesById: Object.fromEntries(registrySources.map(entry => [entry.id, entry])),
        } } : {}), ...(skills ? { skills: {
            family: 'skills' as const, entriesById: Object.fromEntries(skills.map(entry => [entry.id, entry])),
        } } : {}) }, diagnostics: [],
    }, platform);
}

/** Share unchanged presentation rows at publication, before any consumer reads them. */
function reconcileProjectionValue<T>(previous: T | undefined, next: T): T {
    if (previous === next) return next;
    if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object'
        || Array.isArray(previous) !== Array.isArray(next)) return next;
    const previousRecord = previous as Readonly<Record<string, unknown>>;
    const nextRecord = next as Readonly<Record<string, unknown>>;
    const keys = Object.keys(nextRecord);
    let unchanged = keys.length === Object.keys(previousRecord).length;
    const values: Record<string, unknown> = {};
    for (const key of keys) {
        const value = reconcileProjectionValue(previousRecord[key], nextRecord[key]);
        values[key] = value;
        if (!Object.prototype.hasOwnProperty.call(previousRecord, key) || value !== previousRecord[key]) unchanged = false;
    }
    if (unchanged) return previous;
    return Object.freeze(Array.isArray(next) ? keys.map(key => values[key]) : values) as T;
}

export function normalizePluginUiProjection(
    projection: PluginUiProjectionNormalizationInput | null,
    platform: PluginUiPlatformV1 = resolvePluginUiProjectionPlatform(),
    previous?: PluginUiProjectionModel,
): PluginUiProjectionModel {
    if (!projection) {
        return EMPTY_PLUGIN_UI_PROJECTION;
    }

    const installedPackagesById = normalizeInstalledPackagesById(projection.installedPackagesById);
    const diagnostics = Object.freeze([...(projection.diagnostics ?? [])]);
    // The daemon Registry has already admitted, qualified, and generation-bound
    // these static families. Preserve those exact maps through the one UI
    // projection normalizer instead of reconstructing descriptors or creating
    // a Composer-local catalog.
    const composerAttachmentsById = normalizeComposerAttachmentEntriesById(
        projection.familiesById.composerAttachments?.entriesById,
        previous?.composerAttachmentsById,
    );
    const composerControlsById = Object.freeze({
        ...(projection.familiesById.composerControls?.entriesById ?? {}),
    });
    const composerRegionsById = Object.freeze({
        ...(projection.familiesById.composerRegions?.entriesById ?? {}),
    });
    // The daemon Registry has already resolved availability, identity, and
    // execution target. Keep these entries verbatim so the client executable
    // owner consumes one canonical projection rather than rebuilding Actions
    // from a feature-local declaration family.
    const actionsById = Object.freeze({ ...projection.actionsById });
    const resourcesById = Object.freeze({ ...projection.resourcesById });
    const machineProvisionersById = Object.freeze({ ...(projection.familiesById.machineProvisioners?.entriesById ?? {}) });
    const inputTypesById = Object.freeze({ ...(projection.familiesById.inputTypes?.entriesById ?? {}) });
    const atmospherePicturesById = Object.freeze({ ...(projection.familiesById.atmospherePictures?.entriesById ?? {}) });
    const registrySourcesById = Object.freeze({ ...(projection.familiesById.registrySources?.entriesById ?? {}) });
    const skillsById = Object.freeze({ ...(projection.familiesById.skills?.entriesById ?? {}) });
    const dragSourcesById: Record<string, PluginUiDragSourceProjection> = {};
    const workItemsById: Record<string, PluginUiWorkItemsProjection> = {};
    for (const [id, entry] of Object.entries(projection.familiesById.workItems?.entriesById ?? {})) {
        const parsed = PluginProjectedWorkItemsEntryV1Schema.safeParse(entry);
        if (parsed.success && parsed.data.id === id) workItemsById[id] = Object.freeze({ ...parsed.data });
    }
    for (const [id, entry] of Object.entries(projection.familiesById.dragSources?.entriesById ?? {})) {
        const parsed = PluginProjectedDragSourceEntryV1Schema.safeParse(entry);
        if (parsed.success && parsed.data.id === id) dragSourcesById[id] = Object.freeze({ ...parsed.data });
    }
    const dropTargetsById: Record<string, PluginUiDropTargetProjection> = {};
    for (const [id, entry] of Object.entries(projection.familiesById.dropTargets?.entriesById ?? {})) {
        const parsed = PluginProjectedDropTargetEntryV1Schema.safeParse(entry);
        if (parsed.success && parsed.data.id === id) dropTargetsById[id] = Object.freeze({ ...parsed.data });
    }

    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const voiceProviderFamily = projection.familiesById.voiceProviders;
    if (voiceProviderFamily) {
        for (const rawEntry of Object.values(voiceProviderFamily.entriesById)) {
            const entry = asRecord(rawEntry);
            const pluginId = readString(entry?.pluginId);
            const id = readString(entry?.id);
            const contributionKey = readString(entry?.contributionKey);
            const occurrenceId = readString(entry?.occurrenceId);
            const definition = VoiceProviderContributionSchema.safeParse(entry?.definition);
            const recipientContract = entry?.recipientContract === undefined
                ? null
                : RecipientContractV1Schema.safeParse(entry.recipientContract);
            const recipientContractDigest = readString(entry?.recipientContractDigest);
            if (!pluginId || !id || !occurrenceId || !contributionKey || !definition.success) continue;
            const expectedKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId,
                localId: definition.data.id,
            }));
            if (
                id !== expectedKey
                || contributionKey !== expectedKey
                // The daemon stamped `recipientContractDigest` from this same
                // contract with this same function, so recomputing it here can
                // only agree — and a disagreement would silently drop a Voice
                // provider the user already configured. What still has to hold
                // is that the contract parses and names this contribution.
                || (entry?.recipientContract !== undefined && (
                    !recipientContract?.success
                    || recipientContract.data.contribution.pluginId !== pluginId
                    || recipientContract.data.contribution.localId !== definition.data.id
                ))
            ) continue;
            voiceProvidersById[id] = Object.freeze({
                ...entry,
                id,
                pluginId,
                occurrenceId,
                contributionKey,
                definition: definition.data,
                ...(recipientContract?.success && recipientContractDigest
                    ? {
                        recipientContract: recipientContract.data,
                        recipientContractDigest,
                    }
                    : {}),
            });
        }
    }

    const family = projection.familiesById.pluginUi;
    if (!family) {
        return reconcileProjectionValue(previous, Object.freeze({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: projection.generation,
            diagnostics,
            installedPackagesById,
            composerAttachmentsById,
            composerControlsById,
            composerRegionsById,
            actionsById,
            resourcesById,
            machineProvisionersById,
            inputTypesById,
            atmospherePicturesById,
            registrySourcesById,
            skillsById,
            voiceProvidersById: Object.freeze(voiceProvidersById),
            dragSourcesById: Object.freeze(dragSourcesById),
            workItemsById: Object.freeze(workItemsById),
            dropTargetsById: Object.freeze(dropTargetsById),
        }));
    }

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const searchProvidersById: Record<string, PluginUiSearchProviderProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiPhysicalSurfacePlacementProjection> = {};
    const openableContentViewersById: Record<string, PluginUiOpenableContentViewerProjection> = {};
    const settingsGroupsById: Record<string, PluginUiSettingsGroupProjection> = {};
    const settingsPagesById: Record<string, PluginUiSettingsPageProjection> = {};
    const transcriptActivitiesById: Record<string, PluginUiTranscriptActivityProjection> = {};
    const sessionInfoSectionsById: Record<string, PluginUiSessionInfoSectionProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};

    for (const rawEntry of Object.values(family.entriesById)) {
        const entry = asRecord(rawEntry);
        if (!entry) {
            continue;
        }
        if (isTranslations(entry)) {
            translationsByPluginId[entry.pluginId] = Object.freeze({
                ...entry,
                locales: Object.freeze(readStringArray(entry.locales)),
            });
        } else if (isSessionHeaderAction(entry)) {
            const action = resolveSessionHeaderAction(entry);
            if (action) {
                sessionHeaderActionsById[action.id] = action;
            }
        } else if (entry.contributionKind === 'searchProvider') {
            const provider = resolveSearchProvider(entry);
            if (provider) {
                searchProvidersById[provider.id] = provider;
            }
        } else if (isHostedWeb(entry)) {
            hostedWebById[entry.id] = Object.freeze(entry);
        } else if (isReactNativeBundle(entry)) {
            reactNativeBundlesById[entry.id] = Object.freeze(entry);
        } else if (isSurfacePlacement(entry)) {
            const availability = readSurfaceAvailability(entry.availability);
            const placementBinding = entry.binding as PluginUiSurfaceBindingV1;
            // Projection knows only the OS-level platform, so this is the
            // canonical Protocol predicate and not a second policy: a
            // desktop/tablet destination row survives on native and the mounted
            // host still applies the phone/tablet form factor it alone observes.
            // A row this client can never mount must not reach any catalog,
            // picker, deep link or app union.
            if (availability && isPluginUiSurfaceBindingPotentiallySupportedOnPlatformV1(
                placementBinding,
                platform,
            )) {
                const binding = placementBinding;
                const target = asRecord(entry.target) ?? {};
                const renderer = asRecord(entry.renderer) ?? {};
                const display = asRecord(entry.display) ?? {};
                const runtime = asRecord(entry.runtime);
                const rightSidebar = asRecord(entry.rightSidebar);
                const headerActions = resolvePluginUiPageHeaderActions(entry.headerActions);
                const { column: projectedColumn, widgetAreas: projectedWidgetAreas, ...entryFields } = entry;
                const column = readAppPageColumn(projectedColumn);
                const widgetAreas = binding.kind === 'destination' && binding.container === 'appPage'
                    ? PluginUiWidgetAreaDeclarationsV1Schema.safeParse(projectedWidgetAreas) : null;
                const normalized = Object.freeze({
                    ...entryFields,
                    // Preserve the CLI-normalized object verbatim. No UI
                    // parser, clone, or legacy placement reconstruction may
                    // become a competing binding owner.
                    binding,
                    target: Object.freeze({ ...target }),
                    renderer: Object.freeze({ ...renderer }),
                    display: Object.freeze({ ...display }),
                    headerActions,
                    ...(runtime ? { runtime } : {}),
                    ...(rightSidebar ? { rightSidebar: Object.freeze({ ...rightSidebar }) } : {}),
                    // A malformed column is dropped, never passed through as an unknown record.
                    ...(column ? { column } : {}),
                    ...(widgetAreas?.success ? { widgetAreas: Object.freeze(widgetAreas.data) } : {}),
                    availability,
                }) as PluginUiPhysicalSurfacePlacementProjection;
                surfacePlacementsById[entry.id] = normalized;
            }
        } else if (entry.contributionKind === 'openableContentViewer') {
            const viewer = resolveOpenableContentViewer(entry);
            if (viewer) {
                openableContentViewersById[viewer.id] = viewer;
            }
        } else if (isSettingsGroup(entry)) {
            settingsGroupsById[entry.id] = Object.freeze({
                ...entry,
                group: Object.freeze({ ...(asRecord(entry.group) ?? {}) }),
            }) as PluginUiSettingsGroupProjection;
        } else if (isSettingsPage(entry)) {
            const availability = readSurfaceAvailability(entry.availability);
            if (availability) {
                settingsPagesById[entry.id] = Object.freeze({
                    ...entry,
                    // The binding is Registry-normalized and must retain its
                    // exact identity across catalog and route consumers.
                    binding: entry.binding as PluginUiDestinationBindingV1,
                    page: Object.freeze({ ...(asRecord(entry.page) ?? {}) }),
                    renderer: Object.freeze({ ...(asRecord(entry.renderer) ?? {}) }),
                    availability,
                }) as PluginUiSettingsPageProjection;
            }
        } else if (isTranscriptActivity(entry)) {
            transcriptActivitiesById[entry.id] = Object.freeze({
                ...entry,
                resource: Object.freeze({ ...entry.resource }),
                actions: Object.freeze(entry.actions.map((action) => Object.freeze({ ...action }))),
            });
        } else if (isSessionInfoSection(entry)) {
            const runtime = asRecord(entry.runtime);
            sessionInfoSectionsById[entry.id] = Object.freeze({
                ...entry,
                resource: Object.freeze({ ...entry.resource }),
                actions: Object.freeze(entry.actions.map((action) => Object.freeze({ ...action }))),
                renderer: Object.freeze({ ...(asRecord(entry.renderer) ?? {}) }),
                placement: Object.freeze({ ...entry.placement }),
                ...(runtime ? { runtime: Object.freeze({ ...runtime }) } : {}),
            });
        } else {
            const id = readString(entry.id);
            if (id !== null) {
                unknownEntriesById[id] = Object.freeze(entry);
            }
        }
    }

    const reconciled = reconcileProjectionValue(previous, Object.freeze({
        generation: projection.generation,
        diagnostics,
        installedPackagesById,
        translationsByPluginId: Object.freeze(translationsByPluginId),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        searchProvidersById: Object.freeze(searchProvidersById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        openableContentViewersById: Object.freeze(openableContentViewersById),
        settingsGroupsById: Object.freeze(settingsGroupsById),
        settingsPagesById: Object.freeze(settingsPagesById),
        transcriptActivitiesById: Object.freeze(transcriptActivitiesById),
        sessionInfoSectionsById: Object.freeze(sessionInfoSectionsById),
        composerAttachmentsById,
        composerControlsById,
        composerRegionsById,
        actionsById,
        resourcesById,
        machineProvisionersById,
        inputTypesById,
        atmospherePicturesById,
        registrySourcesById,
        skillsById,
        voiceProvidersById: Object.freeze(voiceProvidersById),
        dragSourcesById: Object.freeze(dragSourcesById),
        workItemsById: Object.freeze(workItemsById),
        dropTargetsById: Object.freeze(dropTargetsById),
        unknownEntriesById: Object.freeze(unknownEntriesById),
    }));
    // Reconciliation can combine old and new locale subtrees. Publish the
    // resulting bundle through Protocol's immutable JSON owner once, rather
    // than making each mounted selector copy the same shallow-frozen graph.
    let ownedTranslations: Record<string, PluginUiTranslationsProjection> | undefined;
    for (const [pluginId, entry] of Object.entries(reconciled.translationsByPluginId)) {
        if (entry.bundles === undefined) continue;
        const bundles = projectNativeJsonValueForTransport(entry.bundles);
        if (bundles === entry.bundles) continue;
        ownedTranslations ??= { ...reconciled.translationsByPluginId };
        ownedTranslations[pluginId] = Object.freeze({ ...entry, bundles });
    }
    return ownedTranslations ? Object.freeze({ ...reconciled, translationsByPluginId: Object.freeze(ownedTranslations) }) : reconciled;
}

