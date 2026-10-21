import {
    EMPTY_PLUGIN_UI_PROJECTION,
    resolvePluginUiClientExecutablePlatform,
    type PluginUiActionProjection,
    type PluginUiHostedWebProjection,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
    type PluginUiSessionHeaderActionProjection,
    type PluginUiSearchProviderProjection,
    type PluginUiPhysicalSurfacePlacementProjection,
    type PluginUiTranslationsProjection,
    type PluginVoiceProviderProjection,
    type PluginUiDragSourceProjection,
    type PluginUiWorkItemsProjection,
    type PluginUiDropTargetProjection,
    type PluginUiResourceProjection,
    type PluginUiInputTypeProjection,
    type PluginUiAtmospherePictureProjection,
    type PluginUiRegistrySourceProjection,
    type PluginUiSkillProjection,
} from './projection';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginDeclarativeProjectedModelV1Schema, projectPluginDeclarativeModelComparisonV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import type { PluginUiProjectionPhase } from './usePluginUiProjectionCurrentness';
import { composePluginMachineExecutionOriginV1, type PluginMachineSourceExecutionOriginCandidateV1, type PluginMachineExecutionOriginRejectionV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolveFleetSupplyAgreement } from '@/sync/domains/machines/administration/fleetUnion';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readPluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    publishPluginUiContributionSupplies,
    readPluginUiContributionSupplies,
    readPluginUiProjectionEntryExecutionOrigin,
    retainPluginUiProjectionValue,
    type PluginUiContributionOriginV1,
    type PluginUiContributionSupplyV1,
} from './projectionOrigins';

export {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    preparePluginUiProjectionOrigins,
    readPluginUiContributionOrigin,
    readPluginUiContributionSupplies,
    readPluginUiProjectionEntryExecutionOrigin,
    type PluginUiContributionOriginV1,
    type PluginUiContributionSupplyV1,
} from './projectionOrigins';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginUiProjectionUnionMember = Readonly<{
    machineId: string;
    serverId: string | null;
    serverIdentityId?: string;
    projection: PluginUiProjectionModel | null;
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    interactionEnabled: boolean;
    /** Exact reported content correspondence, separate from runtime authority. */
    materializationsByPluginId?: Readonly<Record<string, PluginMachineMaterializationV1>>;
    /** Exact choices admitted by Administration; omitted means not reported yet. */
    selectableExecutionOrigins?: readonly PluginMachineExecutionOriginV1[];
}>;

/** Installed release slots bind the graph omitted by portable manifest-only declarations. */
function matchesInstalledArtifactSlot(
    entry: unknown,
    materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
): boolean {
    const record = asRecord(entry);
    const pluginId = readString(record?.pluginId);
    const materialization = pluginId ? materializations?.[pluginId] : null;
    if (!record || !materialization?.portableRelease || record.pluginVersion !== materialization.version
        || !readString(record.occurrenceId)) return false;
    const origin = readPluginUiProjectionEntryExecutionOrigin(record);
    if (!origin || !arePluginMachineExecutionOriginsEqual(origin, composePluginMachineExecutionOriginV1(materialization))) return false;
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(record.artifactGraph);
    const tier = record.contributionKind === 'reactNativeBundle' ? 'reactNative'
        : record.contributionKind === 'hostedWeb' ? 'hostedWeb' : null;
    if (!graph.success || graph.data.tier !== tier) return false;
    const platform = resolvePluginUiClientExecutablePlatform();
    return materialization.uiArtifacts.some(slot => slot.contributionId === record.contributionId
        && slot.artifactId === graph.data.artifactId && slot.tier === tier && slot.platform === platform
        && slot.artifactDigest === graph.data.digest && slot.hostUiApiRange === graph.data.hostUiApiRange);
}

export function mergeInstalledPluginUiProjections(
    installed: readonly PluginUiProjectionModel[],
    runtime: PluginUiProjectionModel | null,
    materializations?: Readonly<Record<string, PluginMachineMaterializationV1>>,
    explicitOrigins?: PluginUiProjectionUnionOriginSelections,
): PluginUiProjectionModel | null {
    return deriveInstalledPluginUiProjection(installed, runtime, materializations, explicitOrigins, createDeclarationComparisons());
}

function deriveInstalledPluginUiProjection(
    installed: readonly PluginUiProjectionModel[],
    runtime: PluginUiProjectionModel | null,
    materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
    explicitOrigins: PluginUiProjectionUnionOriginSelections | undefined,
    comparisons: DeclarationComparisons,
): PluginUiProjectionModel | null {
    if (installed.length === 0) return runtime;
    const installedPluginIds = new Set(installed.flatMap(model => declarationMaps(model).flatMap(map =>
        Object.values(map).flatMap(entry => { const id = readString(asRecord(entry)?.pluginId); return id ? [id] : []; }))));
    const hostBundledPluginIds = new Set(installed.flatMap(model => Object.values(model.installedPackagesById)
        .filter(plugin => plugin.source.kind === 'bundled' && !plugin.occurrenceId).map(plugin => plugin.id)));
    const merge = <T>(read: (model: PluginUiProjectionModel) => Readonly<Record<string, T>>, artifactFacts = false) => {
        const declared: Record<string, T> = Object.assign({}, ...installed.map(read));
        for (const [key, entry] of Object.entries(runtime ? read(runtime) : {})) {
            const declaration = asRecord(declared[key]);
            // Account Actions and their per-Action executable graphs share
            // Availability custody, independently of an optional Machine supplier.
            if (artifactFacts && declaration?.generatedOwnerKind === 'clientContribution'
                && readPluginUiAccountExecutableOrigin(declaration)) continue;
            const pluginId = readString(asRecord(entry)?.pluginId);
            const selectedOrigin = pluginId ? explicitOrigins?.get(pluginId) : undefined;
            if (pluginId && hostBundledPluginIds.has(pluginId) && selectedOrigin && 'sourceRef' in selectedOrigin
                && selectedOrigin.sourceRef.sourceCustody.kind === 'development'
                && readPluginUiContributionSupplies(entry).some(supply => supply.phase === 'current' && supply.interactionEnabled
                    && supply.executionOrigin && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, selectedOrigin))) {
                // Only the explicitly selected live source overrides host bytes.
                // Other suppliers remain byte routes and cannot select the UI.
                declared[key] = entry;
                continue;
            }
            const executableOwner = asRecord(entry)?.generatedOwnerKind;
            if (artifactFacts && (executableOwner === 'clientContribution' || executableOwner === 'voiceProvider')
                && declaration?.generatedOwnerKind !== 'renderer') {
                // Installed declarations retain renderer bytes. Executable graphs
                // instead accompany the runtime Actions/Voice declarations whose
                // exact occurrence and origin the executable resolver admits.
                declared[key] = entry;
                continue;
            }
            if (declaration && Array.isArray(declaration.hostSupplies)
                && (!declaration.occurrenceId || declaration.hostAccountOrigin)) {
                declared[key] = Object.freeze(Object.assign({}, declared[key], {
                    hostSupplies: readPluginUiContributionSupplies(entry),
                    // Account surfaces retain their own custody; these supplies
                    // are only optional scoped Machine transport. Other bundled
                    // surfaces retain the selected producer's launch identity.
                    ...(!declaration.hostAccountOrigin && (declaration.contributionKind === 'surfacePlacement' || declaration.contributionKind === 'settingsPage')
                        ? {
                            runtime: asRecord(entry)?.runtime ?? declaration.runtime,
                            occurrenceId: asRecord(entry)?.occurrenceId,
                            executionOrigin: asRecord(entry)?.executionOrigin,
                            hostOrigin: asRecord(entry)?.hostOrigin,
                        } : {}),
                }));
                continue;
            }
            if (!pluginId || !installedPluginIds.has(pluginId)
                || (artifactFacts && matchesInstalledArtifactSlot(entry, materializations))
                || (declared[key] && sameDeclarationContent(declared[key], entry, comparisons))) {
                declared[key] = entry;
            }
        }
        return Object.freeze(declared);
    };
    const projection = Object.freeze({
        ...(runtime ?? EMPTY_PLUGIN_UI_PROJECTION),
        generation: runtime?.generation ?? null,
        installedPackagesById: Object.freeze(Object.assign({}, ...installed.map(model => model.installedPackagesById), runtime?.installedPackagesById)),
        // Availability owns portable Account execution; Machine projections
        // continue to own every other executable Action family.
        actionsById: Object.freeze(Object.assign({}, runtime?.actionsById,
            ...installed.map(model => Object.fromEntries(Object.entries(model.actionsById)
                .filter(([, action]) => action.execution.target === 'account'))))),
        translationsByPluginId: merge(model => model.translationsByPluginId),
        sessionHeaderActionsById: merge(model => model.sessionHeaderActionsById),
        // Search binds the runtime Action's occurrence and origin, like
        // Machine Actions above. Portable renderer declarations omit this family
        // and cannot withdraw an admitted runtime provider from Home.
        searchProvidersById: runtime?.searchProvidersById ?? EMPTY_PLUGIN_UI_PROJECTION.searchProvidersById,
        hostedWebById: merge(model => model.hostedWebById, true),
        reactNativeBundlesById: merge(model => model.reactNativeBundlesById, true),
        surfacePlacementsById: merge(model => model.surfacePlacementsById),
        settingsGroupsById: merge(model => model.settingsGroupsById),
        settingsPagesById: merge(model => model.settingsPagesById),
        composerControlsById: merge(model => model.composerControlsById),
        composerRegionsById: merge(model => model.composerRegionsById),
        voiceProvidersById: merge(model => model.voiceProvidersById),
        atmospherePicturesById: merge(model => model.atmospherePicturesById),
        registrySourcesById: merge(model => model.registrySourcesById),
        skillsById: merge(model => model.skillsById),
        unknownEntriesById: merge(model => model.unknownEntriesById),
    });
    return projection;
}

/**
 * The canonical Administration decision for each plugin that may contribute to
 * the app scope. Selection binds effects only; its absence cannot remove
 * an installed declaration from the Account catalog.
 */
export type PluginUiProjectionUnionOriginSelections = ReadonlyMap<
    string,
    PluginMachineExecutionOriginV1
>;

/** Selection meaning, not a reporter's map wrapper, invalidates composition. */
export function arePluginExecutionOriginSelectionsEquivalent(
    left: PluginUiProjectionUnionOriginSelections | undefined,
    right: PluginUiProjectionUnionOriginSelections | undefined,
): boolean {
    if (left === right) return true;
    if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
    for (const [pluginId, origin] of left ?? []) {
        const other = right?.get(pluginId);
        if (!other || !arePluginMachineExecutionOriginsEqual(origin, other)) return false;
    }
    return true;
}

export type PluginUiProjectionUnion = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    /** Canonical state for app consumers without a contribution-specific origin. */
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    /** Missing destinations remain unresolved while an eligible origin is pending. */
    hasEstablishingMembers: boolean;
    /**
     * Coarse roll-up across current contributors. The per-contribution
     * origin is still the authority for an actual mount; this value reaches
     * only consumers that have no contribution in hand.
     */
    interactionEnabled: boolean;
    /**
     * The union's machine, and only when the union HAS one: a single eligible
     * member. With zero or several members there is no single app machine and
     * this is `null` — the honest answer. It is never inferred from `activeAt`.
     */
    machineId: string | null;
    serverId: string | null;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION_UNION: PluginUiProjectionUnion = Object.freeze({
    pluginUiProjection: null,
    phase: 'unavailable',
    hasEstablishingMembers: false,
    interactionEnabled: false,
    machineId: null,
    serverId: null,
});

/** One Account/target publisher owns only its current immutable source inputs. */
export function createPluginUiProjectionUnionPublication() {
    let members: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedMembers: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedSelections: PluginUiProjectionUnionOriginSelections | undefined;
    let selections: PluginUiProjectionUnionOriginSelections | undefined;
    let comparisons = createDeclarationComparisons();
    let snapshot = EMPTY_PLUGIN_UI_PROJECTION_UNION;
    return {
        getSnapshot: (): PluginUiProjectionUnion => snapshot,
        publish(nextMembers: readonly PluginUiProjectionUnionMember[], nextSelections?: PluginUiProjectionUnionOriginSelections): PluginUiProjectionUnion {
            if (publishedMembers === nextMembers && publishedSelections === nextSelections) return snapshot;
            if (members && arePluginUiProjectionUnionMembersEquivalent(members, nextMembers)
                && arePluginExecutionOriginSelectionsEquivalent(selections, nextSelections)) {
                publishedMembers = nextMembers;
                publishedSelections = nextSelections;
                return snapshot;
            }
            comparisons = retainDeclarationComparisons(nextMembers.flatMap(member => member.projection ? [member.projection] : []), comparisons);
            snapshot = retainPluginUiProjectionValue(snapshot, derivePluginUiProjectionUnion(nextMembers, nextSelections ?? new Map(), comparisons)) as PluginUiProjectionUnion;
            members = [...nextMembers];
            selections = nextSelections ? new Map(nextSelections) : undefined;
            publishedMembers = nextMembers;
            publishedSelections = nextSelections;
            return snapshot;
        },
    };
}

/** Mounted and AppShell compositions have separate, explicitly scoped lifetimes. */
export function createInstalledPluginUiProjectionPublication() {
    let inputs: Readonly<{
        installed: readonly PluginUiProjectionModel[];
        runtime: PluginUiProjectionModel | null;
        materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined;
        selections: PluginUiProjectionUnionOriginSelections | undefined;
    }> | null = null;
    let comparisons = createDeclarationComparisons();
    let snapshot: PluginUiProjectionModel | null = null;
    return {
        getSnapshot: (): PluginUiProjectionModel | null => snapshot,
        publish(installed: readonly PluginUiProjectionModel[], runtime: PluginUiProjectionModel | null,
            materializations?: Readonly<Record<string, PluginMachineMaterializationV1>>,
            selections?: PluginUiProjectionUnionOriginSelections): PluginUiProjectionModel | null {
            if (inputs && inputs.runtime === runtime && inputs.materializations === materializations
                && installed.length === inputs.installed.length && installed.every((model, index) => model === inputs!.installed[index])
                && arePluginExecutionOriginSelectionsEquivalent(inputs.selections, selections)) return snapshot;
            comparisons = retainDeclarationComparisons(runtime ? [...installed, runtime] : installed, comparisons);
            snapshot = retainPluginUiProjectionValue(snapshot,
                deriveInstalledPluginUiProjection(installed, runtime, materializations, selections, comparisons)) as PluginUiProjectionModel | null;
            inputs = { installed: [...installed], runtime, materializations, selections: selections ? new Map(selections) : undefined };
            return snapshot;
        },
    };
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function resolveUnionProjectionPhase(
    members: readonly PluginUiProjectionUnionMember[],
): PluginUiProjectionPhase {
    // Current presentation is not withheld by an unrelated pending origin.
    // Catalog completeness is published separately for missing destinations;
    // executable authority remains stamped on each exact contribution below.
    if (members.some((member) => member.phase === 'current')) return 'current';
    if (members.some((member) => member.phase === 'establishing')) return 'establishing';
    if (members.some((member) => member.phase === 'retainedOffline')) return 'retainedOffline';
    return 'unavailable';
}

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function stamp<T extends UnknownRecord>(entry: T, origin: PluginUiContributionOriginV1): T {
    return Object.freeze({
        ...entry,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: origin,
    }) as T;
}

/**
 * A 32-bit FNV-1a over the members' `machineId=generation` pairs. Used only when
 * several machines contribute, where no member's generation can stand for the
 * whole union: it is a non-negative integer that changes whenever any member's
 * generation changes and is stable otherwise, which is what every consumer of
 * the model-level generation actually needs.
 */
function deriveUnionGeneration(members: readonly PluginUiProjectionUnionMember[]): number {
    let hash = 0x811c9dc5;
    const source = members
        .map((member) => `${member.machineId}=${String(member.projection?.generation ?? 'null')}`)
        .join('\n');
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function selectedOriginOwnsEntry(input: Readonly<{
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    entry: unknown;
    machineId: string;
}>): boolean {
    const pluginId = readString(asRecord(input.entry)?.pluginId);
    if (!pluginId) return false;
    const selectedOrigin = input.selectedOriginsByPluginId.get(pluginId);
    const producerOrigin = readPluginUiProjectionEntryExecutionOrigin(input.entry);
    return selectedOrigin !== undefined
        && producerOrigin !== null
        && getPluginMachineExecutionOriginRef(selectedOrigin).pluginId === pluginId
        && getPluginMachineExecutionOriginRef(selectedOrigin).machineId === input.machineId
        && getPluginMachineExecutionOriginRef(producerOrigin).machineId === input.machineId
        && arePluginMachineExecutionOriginsEqual(selectedOrigin, producerOrigin);
}

function memberHasAdmittedContribution(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
): boolean {
    return declarationMaps(member.projection).some(map => Object.values(map).some(entry => readString(asRecord(entry)?.pluginId) !== null))
        || Object.values(member.projection.resourcesById).some(entry => resourceHasCurrentProducerOrigin(member.projection, entry)
            && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }));
}

function declarationMaps(model: PluginUiProjectionModel): readonly Readonly<Record<string, unknown>>[] {
    return [model.translationsByPluginId, model.sessionHeaderActionsById, model.searchProvidersById,
        model.hostedWebById, model.reactNativeBundlesById, model.surfacePlacementsById,
        model.settingsGroupsById, model.settingsPagesById, model.actionsById, model.voiceProvidersById,
        model.dragSourcesById, model.workItemsById, model.dropTargetsById, model.atmospherePicturesById, model.registrySourcesById, model.skillsById, model.unknownEntriesById,
        model.inputTypesById, model.composerControlsById, model.composerRegionsById];
}

/** Runtime identity and health are not portable declaration content. */
function declarationContent(entry: unknown): unknown {
    const record = asRecord(entry);
    if (!record) return entry;
    const { occurrenceId, executionOrigin, sourceCustody, immutableGenerationId, generation,
        enabled, availability, available, runtimeMode, runtimeDiagnostics, diagnostics, ...content } = record;
    const renderer = asRecord(content.renderer);
    if (renderer?.kind !== 'declarative' || renderer.model === undefined) return content;
    const model = PluginDeclarativeProjectedModelV1Schema.safeParse(renderer.model);
    return model.success ? { ...content, renderer: { ...renderer, model: projectPluginDeclarativeModelComparisonV1(model.data) } } : content;
}

type DeclarationComparisons = {
    entries: Map<UnknownRecord, { value: JsonValue; content?: string }>;
    projections: Map<PluginUiProjectionModel, ProjectionDeclarationComparison>;
    recordsByProjection: Map<PluginUiProjectionModel, ReadonlySet<UnknownRecord>>;
};

function createDeclarationComparisons(): DeclarationComparisons {
    return { entries: new Map(), projections: new Map(), recordsByProjection: new Map() };
}

/** Current inputs bound retention; unchanged source rows keep their prepared facts. */
function retainDeclarationComparisons(models: readonly PluginUiProjectionModel[], previous: DeclarationComparisons): DeclarationComparisons {
    const next = createDeclarationComparisons();
    for (const model of models) {
        if (next.recordsByProjection.has(model)) continue;
        let records = previous.recordsByProjection.get(model);
        if (!records) {
            const entries = [...declarationMaps(model), model.resourcesById].flatMap(map => Object.values(map));
            records = new Set(entries.flatMap(entry => {
                const record = asRecord(entry);
                const definition = asRecord(record?.definition);
                return record ? definition ? [record, definition] : [record] : [];
            }));
        }
        next.recordsByProjection.set(model, records);
        const comparison = previous.projections.get(model);
        if (comparison) next.projections.set(model, comparison);
        for (const record of records) {
            const snapshot = previous.entries.get(record);
            if (snapshot) next.entries.set(record, snapshot);
        }
    }
    return next;
}

function readDeclarationComparisonSnapshot(entry: unknown, comparisons: DeclarationComparisons): JsonValue {
    const record = asRecord(entry);
    if (!record) return projectNativeJsonValueForTransport(entry);
    const previous = comparisons.entries.get(record);
    if (previous !== undefined) return previous.value;
    const snapshot = projectNativeJsonValueForTransport(declarationContent(record));
    comparisons.entries.set(record, { value: snapshot });
    return snapshot;
}

function sameDeclarationContent(left: unknown, right: unknown, comparisons: DeclarationComparisons): boolean {
    return left === right || sameStrictJsonValue(readDeclarationComparisonSnapshot(left, comparisons), readDeclarationComparisonSnapshot(right, comparisons));
}

function stableContent(value: unknown): string {
    return JSON.stringify(value, (_key, child: unknown) => {
        const record = asRecord(child);
        return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])) : child;
    });
}

/** Fleet authority changes do not change these immutable declaration bytes. */
function readDeclarationComparisonContent(entry: unknown, comparisons: DeclarationComparisons): string {
    const value = readDeclarationComparisonSnapshot(entry, comparisons);
    const record = asRecord(entry);
    const snapshot = record ? comparisons.entries.get(record) : undefined;
    if (!snapshot) return stableContent(value);
    return snapshot.content ??= stableContent(snapshot.value);
}

type DeclarationComparisonEntry = readonly [string, string];
type ProjectionDeclarationComparison = Readonly<{
    familiesByPluginId: ReadonlyMap<string, readonly (readonly DeclarationComparisonEntry[])[]>;
    stampedPluginIds: ReadonlySet<string>;
}>;

/** Index one comparison pass, not one full-family scan for every plugin. */
function readProjectionDeclarationComparison(model: PluginUiProjectionModel, comparisons: DeclarationComparisons): ProjectionDeclarationComparison {
    const previous = comparisons.projections.get(model);
    if (previous) return previous;
    const declarationFamilies = declarationMaps(model);
    const families = [...declarationFamilies, model.resourcesById];
    const familiesByPluginId = new Map<string, DeclarationComparisonEntry[][]>();
    const stampedPluginIds = new Set<string>();
    for (const [index, family] of families.entries()) {
        for (const [key, entry] of Object.entries(family)) {
            const pluginId = asRecord(entry)?.pluginId;
            if (typeof pluginId !== 'string') continue;
            let grouped = familiesByPluginId.get(pluginId);
            if (!grouped) {
                grouped = Array.from({ length: families.length }, (): DeclarationComparisonEntry[] => []);
                familiesByPluginId.set(pluginId, grouped);
            }
            grouped[index]!.push([key, readDeclarationComparisonContent(entry, comparisons)]);
            if (index < declarationFamilies.length && !stampedPluginIds.has(pluginId)
                && readPluginUiProjectionEntryExecutionOrigin(entry) !== null) stampedPluginIds.add(pluginId);
        }
    }
    for (const grouped of familiesByPluginId.values()) for (const family of grouped) {
        family.sort(([left], [right]) => left.localeCompare(right));
    }
    const comparison = { familiesByPluginId, stampedPluginIds };
    comparisons.projections.set(model, comparison);
    return comparison;
}

function pluginDeclarationContent(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    pluginId: string,
    comparison: ProjectionDeclarationComparison,
): string {
    const model = member.projection;
    const installed = model.installedPackagesById[pluginId];
    const materialization = member.materializationsByPluginId?.[pluginId];
    const stamped = comparison.stampedPluginIds.has(pluginId);
    const contentCorrespondence = materialization?.portableRelease && materialization.archiveDigestSha256
        ? [materialization.archiveDigestSha256, [...materialization.uiArtifacts].sort((left, right) => stableContent(left).localeCompare(stableContent(right)))]
        : materialization && !materialization.portableRelease ? [materialization.declaredManifest,
            [...materialization.uiArtifacts].sort((left, right) => stableContent(left).localeCompare(stableContent(right)))]
        : stamped ? ['unprovenPortableContent', member.serverId, member.machineId] : null;
    return stableContent([
        contentCorrespondence,
        installed ? [installed.id, installed.displayName, installed.version, installed.executionTarget] : null,
        ...(comparison.familiesByPluginId.get(pluginId)
            ?? Array.from({ length: declarationMaps(model).length + 1 }, () => [])),
    ]);
}

export type PluginUiExecutionOriginCandidateFacts = Readonly<{
    establishingTargets: readonly MachineAdministrationTargetV1[];
    sourceCandidates: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins: readonly PluginMachineExecutionOriginV1[];
    machineRejections: readonly PluginMachineExecutionOriginRejectionV1[];
    autoPick: boolean;
    renderedVersion?: string;
}>;

/** Project exact reported supplies into Administration; never elect an origin here. */
export function readPluginUiExecutionOriginCandidates(params: Readonly<{
    projection: PluginUiProjectionModel | null;
    pluginId: string;
    entry?: unknown;
    /** Package occurrences also supply native-only contributions, with no UI declaration. */
    members?: readonly PluginUiProjectionUnionMember[];
    /** This consumer's last projection, retained only when every selection fact is unchanged. */
    previous?: PluginUiExecutionOriginCandidateFacts;
}>): PluginUiExecutionOriginCandidateFacts {
    const entries = params.entry ? [params.entry] : params.projection
        ? declarationMaps(params.projection).flatMap(map => Object.values(map).filter(entry => asRecord(entry)?.pluginId === params.pluginId)) : [];
    return derivePluginUiExecutionOriginCandidates(params, entries);
}

function derivePluginUiExecutionOriginCandidates(
    params: Parameters<typeof readPluginUiExecutionOriginCandidates>[0],
    entries: readonly unknown[],
): PluginUiExecutionOriginCandidateFacts {
    const sourceCandidates: PluginMachineSourceExecutionOriginCandidateV1[] = [];
    const declaredDefaultOrigins: PluginMachineExecutionOriginV1[] = [];
    const machineRejections: PluginMachineExecutionOriginRejectionV1[] = [];
    const establishingTargets: MachineAdministrationTargetV1[] = [...(params.projection?.establishingExecutionTargetsByPluginId?.[params.pluginId] ?? [])];
    const packageSupplies: PluginUiContributionSupplyV1[] = [];
    for (const member of params.members ?? []) {
        if (!member.projection) continue;
        const installed = member.projection.installedPackagesById[params.pluginId];
        if (!installed) continue;
        // Availability already supplies portable installations and owns their immutable-content
        // admission. A package occurrence must never introduce an alternate source for one.
        if (member.materializationsByPluginId?.[params.pluginId]?.portableRelease) continue;
        const origin = resolveMemberContributionOrigin({ ...member, projection: member.projection }, {
            pluginId: params.pluginId, occurrenceId: installed.occurrenceId, executionOrigin: installed.executionOrigin,
        });
        if (!origin || (!origin.executionOrigin && !origin.unavailableReasonCode)) continue;
        packageSupplies.push({ ...origin, occurrenceId: installed.occurrenceId ?? null, pluginVersion: installed.version ?? null,
            sourceCustody: installed.sourceCustody ?? null,
            executionTargetDefault: installed.executionTarget?.default === 'installation',
            executionTargetAutoPick: installed.executionTarget?.autoPick });
    }
    const supplyGroups = [
        ...entries.map(entry => ({ conflict: asRecord(entry)?.hostCompatibility === 'conflict', supplies: readPluginUiContributionSupplies(entry) })),
        { conflict: entries.some(entry => asRecord(entry)?.hostCompatibility === 'conflict'), supplies: packageSupplies },
    ];
    for (const { conflict, supplies } of supplyGroups) {
        for (const supply of supplies) {
            if (supply.phase === 'establishing' && supply.serverIdentityId
                && !establishingTargets.some(target => target.serverIdentityId === supply.serverIdentityId && target.machineId === supply.machineId)) {
                establishingTargets.push({ serverIdentityId: supply.serverIdentityId, machineId: supply.machineId });
            }
            const origin = supply.executionOrigin;
            const reason = readPluginUiSupplyRejection(supply);
            const serverIdentityId = origin?.serverIdentityId ?? supply.serverIdentityId;
            if (reason && serverIdentityId && !machineRejections.some(entry => entry.serverIdentityId === serverIdentityId
                && entry.machineId === supply.machineId)) {
                machineRejections.push({ serverIdentityId, machineId: supply.machineId, reason });
            }
            if (!origin || getPluginMachineExecutionOriginRef(origin).pluginId !== params.pluginId) continue;
            if (supply.executionTargetDefault && !conflict
                && !declaredDefaultOrigins.some(candidate => arePluginMachineExecutionOriginsEqual(candidate, origin))) declaredDefaultOrigins.push(origin);
            if (!('sourceRef' in origin) || !supply.occurrenceId || !supply.pluginVersion
                || !supply.serverId || supply.generation === null
                || sourceCandidates.some(candidate => arePluginMachineExecutionOriginsEqual(candidate.source.origin, origin))) continue;
            sourceCandidates.push(Object.freeze({
                source: Object.freeze({ origin, version: supply.pluginVersion, occurrenceId: supply.occurrenceId,
                    serverId: supply.serverId, generation: supply.generation }),
                // A machine-local source is selected by exact custody, not by
                // correspondence with another Machine's portable release.
                releaseContent: 'matched',
                validation: reason ? { kind: 'rejected' as const, reason }
                    : supply.phase === 'current' && supply.interactionEnabled ? { kind: 'admitted' as const }
                        : { kind: 'rejected' as const, reason: 'stale' as const },
            }));
        }
    }
    const installed = params.projection?.installedPackagesById[params.pluginId];
    const autoPick = installed ? installed.executionTarget?.autoPick !== false
        : !supplyGroups.some(({ supplies }) => supplies.some(supply => supply.executionTargetAutoPick === false));
    const renderedVersion = installed?.version;
    const previous = params.previous;
    if (previous && previous.autoPick === autoPick && previous.renderedVersion === renderedVersion
        && previous.establishingTargets.length === establishingTargets.length
        && establishingTargets.every((target, index) => target.serverIdentityId === previous.establishingTargets[index]!.serverIdentityId
            && target.machineId === previous.establishingTargets[index]!.machineId)
        && previous.sourceCandidates.length === sourceCandidates.length
        && sourceCandidates.every((candidate, index) => {
            const other = previous.sourceCandidates[index]!;
            return candidate.source.generation === other.source.generation
                && candidate.source.serverId === other.source.serverId
                && candidate.source.version === other.source.version
                && candidate.source.occurrenceId === other.source.occurrenceId
                && arePluginMachineExecutionOriginsEqual(candidate.source.origin, other.source.origin)
                && candidate.releaseContent === other.releaseContent
                && candidate.validation.kind === other.validation.kind
                && (candidate.validation.kind !== 'rejected'
                    || (other.validation.kind === 'rejected' && candidate.validation.reason === other.validation.reason));
        })
        && previous.declaredDefaultOrigins.length === declaredDefaultOrigins.length
        && declaredDefaultOrigins.every((origin, index) => arePluginMachineExecutionOriginsEqual(origin, previous.declaredDefaultOrigins[index]!))
        && previous.machineRejections.length === machineRejections.length
        && machineRejections.every((rejection, index) => {
            const other = previous.machineRejections[index]!;
            return rejection.serverIdentityId === other.serverIdentityId && rejection.machineId === other.machineId
                && rejection.reason === other.reason;
        })) return previous;
    return Object.freeze({ establishingTargets: Object.freeze(establishingTargets), sourceCandidates: Object.freeze(sourceCandidates), declaredDefaultOrigins: Object.freeze(declaredDefaultOrigins),
        // The rendered declaration owns policy. An older replica's opt-out
        // cannot change the current rendered release's automatic placement.
        autoPick,
        ...(renderedVersion ? { renderedVersion } : {}),
        machineRejections: Object.freeze(machineRejections) });
}

type CandidatePublicationInput = Readonly<{
    entries: readonly unknown[];
    installed: PluginUiProjectionModel['installedPackagesById'][string] | undefined;
    establishing: readonly MachineAdministrationTargetV1[] | undefined;
    members: readonly PluginUiProjectionUnionMember[];
}>;

function sameCandidateMembers(left: readonly PluginUiProjectionUnionMember[], right: readonly PluginUiProjectionUnionMember[], pluginId: string): boolean {
    return left.length === right.length && left.every((member, index) => {
        const other = right[index]!;
        if (member === other) return true;
        return member.machineId === other.machineId && member.serverId === other.serverId
            && member.serverIdentityId === other.serverIdentityId && member.phase === other.phase
            && member.unavailableReasonCode === other.unavailableReasonCode && member.interactionEnabled === other.interactionEnabled
            && member.projection?.generation === other.projection?.generation
            && member.projection?.installedPackagesById[pluginId] === other.projection?.installedPackagesById[pluginId]
            && member.materializationsByPluginId?.[pluginId] === other.materializationsByPluginId?.[pluginId]
            && memberHasActivationRefusal(member, pluginId) === memberHasActivationRefusal(other, pluginId);
    });
}

/** Group declaration families once for all demanded plugins at source publication. */
export function createPluginUiExecutionOriginCandidatePublication() {
    let projection: PluginUiProjectionModel | null = null;
    let members: readonly PluginUiProjectionUnionMember[] = [];
    let pluginIds: readonly string[] = [];
    let publishedMembers: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedPluginIds: readonly string[] | null = null;
    let entriesByPluginId = new Map<string, readonly unknown[]>();
    let inputs = new Map<string, CandidatePublicationInput>();
    let snapshot: ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> = new Map();
    const noEntries: readonly unknown[] = Object.freeze([]);
    return {
        getSnapshot: (): ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> => snapshot,
        publish(nextProjection: PluginUiProjectionModel | null, nextMembers: readonly PluginUiProjectionUnionMember[],
            nextPluginIds: readonly string[]): ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> {
            if (projection === nextProjection && publishedMembers === nextMembers && publishedPluginIds === nextPluginIds) return snapshot;
            const requested = [...new Set(nextPluginIds)];
            if (projection === nextProjection && arePluginUiProjectionUnionMembersEquivalent(members, nextMembers)
                && pluginIds.length === requested.length && pluginIds.every((id, index) => id === requested[index])) {
                publishedMembers = nextMembers;
                publishedPluginIds = nextPluginIds;
                return snapshot;
            }
            if (projection !== nextProjection) {
                const grouped = new Map<string, unknown[]>();
                for (const family of nextProjection ? declarationMaps(nextProjection) : []) for (const entry of Object.values(family)) {
                    const id = readString(asRecord(entry)?.pluginId);
                    if (!id) continue;
                    const entries = grouped.get(id) ?? [];
                    entries.push(entry);
                    grouped.set(id, entries);
                }
                const nextEntries = new Map<string, readonly unknown[]>();
                for (const [id, entries] of grouped) {
                    const old = entriesByPluginId.get(id);
                    nextEntries.set(id, old && old.length === entries.length && entries.every((entry, index) => entry === old[index]) ? old : entries);
                }
                entriesByPluginId = nextEntries;
            }
            const membersByPluginId = new Map<string, PluginUiProjectionUnionMember[]>();
            for (const member of nextMembers) for (const id of Object.keys(member.projection?.installedPackagesById ?? {})) {
                const supplying = membersByPluginId.get(id) ?? [];
                supplying.push(member);
                membersByPluginId.set(id, supplying);
            }
            const nextInputs = new Map<string, CandidatePublicationInput>();
            const nextSnapshot = new Map<string, PluginUiExecutionOriginCandidateFacts>();
            for (const id of requested) {
                const input: CandidatePublicationInput = {
                    entries: entriesByPluginId.get(id) ?? noEntries,
                    installed: nextProjection?.installedPackagesById[id],
                    establishing: nextProjection?.establishingExecutionTargetsByPluginId?.[id],
                    members: membersByPluginId.get(id) ?? [],
                };
                const previous = inputs.get(id);
                const facts = previous && previous.entries === input.entries && previous.installed === input.installed
                    && previous.establishing === input.establishing && sameCandidateMembers(previous.members, input.members, id)
                    ? snapshot.get(id)!
                    : derivePluginUiExecutionOriginCandidates({ projection: nextProjection, pluginId: id, members: input.members,
                        previous: snapshot.get(id) }, input.entries);
                nextInputs.set(id, input);
                nextSnapshot.set(id, facts);
            }
            if (pluginIds.length !== requested.length || requested.some((id, index) => id !== pluginIds[index] || snapshot.get(id) !== nextSnapshot.get(id))) {
                snapshot = nextSnapshot;
            }
            projection = nextProjection;
            members = [...nextMembers];
            pluginIds = requested;
            inputs = nextInputs;
            publishedMembers = nextMembers;
            publishedPluginIds = nextPluginIds;
            return snapshot;
        },
    };
}

function readPluginUiSupplyRejection(supply: PluginUiContributionOriginV1): PluginMachineExecutionOriginRejectionV1['reason'] | null {
    switch (supply.unavailableReasonCode) {
        case 'plugin_machine_unreachable': return 'home_unreachable';
        case 'plugin_daemon_unsupported': return 'daemon_unsupported';
        case 'plugin_daemon_invalid_response': return 'daemon_invalid_response';
        case 'plugin_daemon_unavailable': return 'daemon_unavailable';
        case 'plugin_activation_failed': return 'activation_refused';
        case 'plugin_source_not_ready': return 'source_not_ready';
        default: return null;
    }
}

/** A Resource without a View still has its own producer and current runtime slot. */
function resourceHasCurrentProducerOrigin(projection: PluginUiProjectionModel, entry: PluginUiResourceProjection): boolean {
    return readPluginUiProjectionEntryExecutionOrigin(entry) !== null && entryHasCurrentOccurrence(projection, entry);
}

function entryHasCurrentOccurrence(projection: PluginUiProjectionModel, entry: Readonly<{ pluginId: string; occurrenceId?: string }>): boolean {
    const occurrenceId = readString(entry.occurrenceId);
    const installedPackage = projection.installedPackagesById[entry.pluginId];
    return occurrenceId !== null
        && installedPackage?.enabled === true && installedPackage.occurrenceId === occurrenceId;
}

function resolveMemberEntryExecutionOrigin(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    entry: UnknownRecord,
    packageOriginsByPluginId?: Map<string, PluginMachineExecutionOriginV1 | null>,
): PluginMachineExecutionOriginV1 | null {
    const producerOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
    if (producerOrigin) return producerOrigin;
    if (entry.executionOrigin !== undefined) return null;
    const pluginId = readString(entry.pluginId);
    if (!pluginId) return null;
    const installation = member.materializationsByPluginId?.[pluginId];
    if (readString(entry.occurrenceId) === null && installation?.portableRelease) {
        return composePluginMachineExecutionOriginV1(installation);
    }
    const installed = member.projection.installedPackagesById[pluginId];
    if (!installed || !entryHasCurrentOccurrence(member.projection, {
        pluginId, occurrenceId: readString(entry.occurrenceId) ?? undefined,
    })) return null;
    if (packageOriginsByPluginId?.has(pluginId)) return packageOriginsByPluginId.get(pluginId) ?? null;
    const origin = readPluginUiProjectionEntryExecutionOrigin({ pluginId, executionOrigin: installed.executionOrigin });
    packageOriginsByPluginId?.set(pluginId, origin);
    return origin;
}

function memberHasActivationRefusal(member: PluginUiProjectionUnionMember, pluginId: string): boolean {
    return member.phase === 'current' && member.projection?.diagnostics?.some(diagnostic =>
        diagnostic.plugin.id === pluginId && diagnostic.host === 'daemon' && diagnostic.resolution.state === 'current'
        && diagnostic.data.code === 'plugin_activation_failed' && diagnostic.data.severity === 'error') === true;
}

function resolveMemberContributionOrigin(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    entry: UnknownRecord,
    packageOriginsByPluginId?: Map<string, PluginMachineExecutionOriginV1 | null>,
): PluginUiContributionOriginV1 | null {
    const pluginId = readString(entry.pluginId);
    if (!pluginId) return null;
    const observedInstallation = member.materializationsByPluginId?.[pluginId];
    const activationRefused = memberHasActivationRefusal(member, pluginId);
    const unavailableReasonCode = member.unavailableReasonCode ?? (activationRefused ? 'plugin_activation_failed'
        : member.phase === 'establishing' ? 'plugin_source_not_ready' : undefined);
    return Object.freeze({ machineId: member.machineId, serverId: member.serverId,
        ...(member.serverIdentityId ? { serverIdentityId: member.serverIdentityId } : {}),
        ...(unavailableReasonCode ? { unavailableReasonCode } : {}),
        generation: member.projection.generation, phase: member.phase,
        executionOrigin: resolveMemberEntryExecutionOrigin(member, entry, packageOriginsByPluginId),
        interactionEnabled: member.interactionEnabled && member.projection.generation !== null
            && member.projection.installedPackagesById[pluginId]?.enabled !== false
            && (!observedInstallation || (observedInstallation.enabled && observedInstallation.trustState === 'trusted'))
            && (readString(entry.occurrenceId) !== null || readPluginUiProjectionEntryExecutionOrigin(entry) !== null) });
}

/**
 * Whether two member lists describe the same union, so the caller can keep the
 * previously built model instead of publishing a new object identity. Member
 * projections are compared by IDENTITY, which is exactly the stability the
 * per-machine currentness owner already guarantees for an unchanged generation.
 */
export function arePluginUiProjectionUnionMembersEquivalent(
    left: readonly PluginUiProjectionUnionMember[],
    right: readonly PluginUiProjectionUnionMember[],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) {
        return false;
    }
    return left.every((member, index) => {
        const other = right[index];
        if (member === other) return true;
        return other !== undefined
            && member.machineId === other.machineId
            && member.serverId === other.serverId
            && member.serverIdentityId === other.serverIdentityId
            && member.projection === other.projection
            && member.materializationsByPluginId === other.materializationsByPluginId
            && (member.selectableExecutionOrigins?.length ?? 0) === (other.selectableExecutionOrigins?.length ?? 0)
            && (member.selectableExecutionOrigins ?? []).every((origin, originIndex) => (
                arePluginMachineExecutionOriginsEqual(origin, other.selectableExecutionOrigins![originIndex]!)
            ))
            && member.phase === other.phase
            && member.unavailableReasonCode === other.unavailableReasonCode
            && member.interactionEnabled === other.interactionEnabled;
    });
}

/** Derive one descriptive Account catalog; exact effects remain origin-bound. */
export function unionPluginUiProjections(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections = new Map(),
): PluginUiProjectionUnion {
    return derivePluginUiProjectionUnion(members, selectedOriginsByPluginId, createDeclarationComparisons());
}

function derivePluginUiProjectionUnion(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
    comparisons: DeclarationComparisons,
): PluginUiProjectionUnion {
    const eligible = members.filter((member) => readString(member.machineId) !== null);
    const phase = resolveUnionProjectionPhase(eligible);
    const hasEstablishingMembers = eligible.some((member) => member.phase === 'establishing');
    // A known Account installation can precede its first runtime projection,
    // including all contribution supplies. Preserve that producer's pending
    // fact without inventing custody, an occurrence, or executable authority.
    const establishingExecutionTargetsByPluginId: Record<string, readonly MachineAdministrationTargetV1[]> = {};
    for (const member of eligible) {
        if (member.phase !== 'establishing') continue;
        for (const [pluginId, installation] of Object.entries(member.materializationsByPluginId ?? {})) {
            if (!installation.enabled || installation.trustState !== 'trusted' || installation.machineId !== member.machineId
                || installation.serverIdentityId !== member.serverIdentityId) continue;
            establishingExecutionTargetsByPluginId[pluginId] = Object.freeze([
                ...(establishingExecutionTargetsByPluginId[pluginId] ?? []),
                Object.freeze({ serverIdentityId: installation.serverIdentityId, machineId: installation.machineId }),
            ]);
        }
    }
    const establishingFacts = Object.keys(establishingExecutionTargetsByPluginId).length > 0
        ? { establishingExecutionTargetsByPluginId: Object.freeze(establishingExecutionTargetsByPluginId) } : {};
    const emptyProjection = 'establishingExecutionTargetsByPluginId' in establishingFacts
        ? Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, ...establishingFacts }) : null;
    const soleMember = eligible.length === 1 ? eligible[0] : undefined;
    const contributing = [...eligible]
        .filter((member): member is PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }> => (
            member.projection !== null
        ))
        // Deterministic and presence-free: machine id, never `activeAt`.
        .sort((left, right) => left.machineId.localeCompare(right.machineId)
            || (left.serverIdentityId ?? left.serverId ?? '').localeCompare(right.serverIdentityId ?? right.serverId ?? ''));

    if (contributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: emptyProjection,
            phase,
            unavailableReasonCode: soleMember?.unavailableReasonCode,
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const admittedContributing = contributing.filter(member => memberHasAdmittedContribution(member, selectedOriginsByPluginId));
    const suppliesByPluginId = new Map<string, (typeof contributing)[number][]>();
    for (const member of admittedContributing) {
        const pluginIds = new Set(declarationMaps(member.projection).flatMap(map => Object.values(map)
            .flatMap(entry => { const id = readString(asRecord(entry)?.pluginId); return id ? [id] : []; })));
        for (const pluginId of pluginIds) {
            const supplies = suppliesByPluginId.get(pluginId) ?? [];
            supplies.push(member);
            suppliesByPluginId.set(pluginId, supplies);
        }
    }
    const conflictedPluginIds = new Set([...suppliesByPluginId].flatMap(([pluginId, supplies]) => {
        // Retained declarations describe the Account catalog. Administration
        // owns exact selectability (reachability, trust and release admission);
        // a current projection alone cannot grant those facts.
        const agreement = resolveFleetSupplyAgreement({
            identity: () => pluginId,
            content: (member) => {
                const comparison = readProjectionDeclarationComparison(member.projection, comparisons);
                return pluginDeclarationContent(member, pluginId, comparison);
            },
            supplies: supplies.map(member => ({ value: member, selectable:
                member.phase === 'current' && member.interactionEnabled && Boolean(member.selectableExecutionOrigins?.length)
                && declarationMaps(member.projection).some(map => Object.values(map).some(entry => {
                const record = asRecord(entry);
                if (record?.pluginId !== pluginId) return false;
                const origin = resolveMemberEntryExecutionOrigin(member, record);
                return origin !== null && member.selectableExecutionOrigins?.some(selectable => (
                    arePluginMachineExecutionOriginsEqual(selectable, origin)
                ));
                })),
            })),
        });
        return agreement.conflictingIdentities;
    }));
    const selectedMembersByPluginId = new Map<string, (typeof contributing)[number]>();
    for (const [pluginId, supplies] of suppliesByPluginId) {
        const selected = selectedOriginsByPluginId.get(pluginId);
        if (!selected) continue;
        const selectedMember = supplies.find(member => declarationMaps(member.projection).some(map => Object.values(map).some(entry => {
            const record = asRecord(entry);
            if (record?.pluginId !== pluginId) return false;
            const origin = resolveMemberEntryExecutionOrigin(member, record);
            return origin !== null && getPluginMachineExecutionOriginRef(origin).machineId === member.machineId
                && arePluginMachineExecutionOriginsEqual(selected, origin);
        })));
        if (selectedMember) selectedMembersByPluginId.set(pluginId, selectedMember);
    }

    if (admittedContributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: emptyProjection,
            phase,
            unavailableReasonCode: soleMember?.unavailableReasonCode,
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    // The aggregate has no exact contribution in hand. It is executable only
    // when its own catalog phase is current and at least one supplying source is
    // itself current. Concrete mounts use their per-entry origin below, so this
    // coarse fail-closed flag cannot revoke an unrelated current origin.
    const interactionEnabled = phase === 'current'
        && admittedContributing.some((member) => (
            member.phase === 'current' && member.interactionEnabled
        ));

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const installedPackagesById: Record<string, PluginProjectionInstalledPackageV2> = {};
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const searchProvidersById: Record<string, PluginUiSearchProviderProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiPhysicalSurfacePlacementProjection> = {};
    const settingsGroupsById: Record<string, PluginUiSettingsGroupProjection> = {};
    const settingsPagesById: Record<string, PluginUiSettingsPageProjection> = {};
    const actionsById: Record<string, PluginUiActionProjection> = {};
    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const dragSourcesById: Record<string, PluginUiDragSourceProjection> = {};
    const workItemsById: Record<string, PluginUiWorkItemsProjection> = {};
    const dropTargetsById: Record<string, PluginUiDropTargetProjection> = {};
    const resourcesById: Record<string, PluginUiResourceProjection> = {};
    const inputTypesById: Record<string, PluginUiInputTypeProjection> = {};
    const atmospherePicturesById: Record<string, PluginUiAtmospherePictureProjection> = {};
    const registrySourcesById: Record<string, PluginUiRegistrySourceProjection> = {};
    const skillsById: Record<string, PluginUiSkillProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};
    const composerControlsById: Record<string, PluginUiProjectionModel['composerControlsById'][string]> = {};
    const composerRegionsById: Record<string, PluginUiProjectionModel['composerRegionsById'][string]> = {};

    // Aggregate equivalent declarations without appointing a producer. Exact
    // source facts are retained separately, including offline supplying copies.
    const normalizedSupplies = new Map<PluginUiContributionOriginV1, Readonly<{
        occurrenceId: string | null;
        supply: PluginUiContributionSupplyV1;
    }>>();
    const publishFirstAdmitted = <T>(model: PluginUiProjectionModel, map: Record<string, T>, key: string, value: T, origin: PluginUiContributionOriginV1,
        retainDeclarationOccurrence = false): void => {
        const entry = asRecord(value);
        const pluginId = readString(entry?.pluginId);
        if (!entry || !pluginId) return;
        const previous = asRecord(map[key]);
        const installed = model.installedPackagesById[pluginId];
        const sourceCustody = installed?.sourceCustody ?? null;
        const occurrenceId = readString(entry.occurrenceId);
        const normalized = normalizedSupplies.get(origin);
        let supply = normalized?.occurrenceId === occurrenceId ? normalized.supply : undefined;
        if (!supply) {
            const rawSupply: PluginUiContributionSupplyV1 = { ...origin, occurrenceId,
                pluginVersion: installed?.version ?? null, sourceCustody,
                executionTargetDefault: installed?.executionTarget?.default === 'installation',
                executionTargetAutoPick: installed?.executionTarget?.autoPick };
            const parsedSupply = readPluginUiContributionSupplies({ hostSupplies: [rawSupply] })[0];
            if (!parsedSupply) return;
            supply = parsedSupply;
            normalizedSupplies.set(origin, { occurrenceId, supply });
        }
        const supplies = publishPluginUiContributionSupplies([...readPluginUiContributionSupplies(previous), supply]);
        const conflict = conflictedPluginIds.has(pluginId) && !selectedMembersByPluginId.has(pluginId);
        const selected = selectedOriginsByPluginId.get(pluginId);
        const binding = conflict ? null : selected
            ? supplies.find(supply => supply.executionOrigin && arePluginMachineExecutionOriginsEqual(selected, supply.executionOrigin)) ?? null
            : null;
        const representative = binding === supply || !previous ? entry : previous;
        const availability = asRecord(representative.availability);
        map[key] = Object.freeze({
            ...representative,
            // Complete the selected producer stamp so artifact adoption cannot
            // borrow a release version (and byte route) from another supply.
            ...(binding?.pluginVersion ? { pluginVersion: binding.pluginVersion } : {}),
            // The selected supply already owns the validated immutable origin.
            // Do not republish its raw representative and reparse it on reads.
            ...(binding && Object.hasOwn(representative, 'executionOrigin')
                ? { executionOrigin: binding.executionOrigin } : {}),
            // Executable rows may not borrow an unselected replica's runtime
            // identity. Schema declarations retain their separate type identity.
            ...(!binding ? { occurrenceId: retainDeclarationOccurrence && !conflict ? representative.occurrenceId : undefined,
                executionOrigin: undefined } : {}),
            hostOrigin: binding,
            hostSupplies: supplies,
            hostCompatibility: conflict ? 'conflict' : 'compatible',
            // A declaration conflict awaits Administration's exact selection;
            // it is not a terminal denial of this page. Keep the choice visible
            // and let the shared loading UI wait for the selected declaration.
            ...(conflict && availability?.state === 'available'
                ? { availability: Object.freeze({ ...availability, state: 'resolving' }) } : {}),
        }) as T;
    };

    for (const member of admittedContributing) {
        const model = member.projection;
        const admittedPluginIds = new Set<string>();
        const admittedOriginsByPluginId = new Map<string, PluginUiContributionOriginV1>();
        const packageOriginsByPluginId = new Map<string, PluginMachineExecutionOriginV1 | null>();
        const originFor = (entry: UnknownRecord): PluginUiContributionOriginV1 | null => {
            const origin = resolveMemberContributionOrigin(member, entry, packageOriginsByPluginId);
            if (!origin) return null;
            const pluginId = readString(entry.pluginId);
            if (pluginId) admittedPluginIds.add(pluginId);
            const executionOrigin = origin.executionOrigin;
            // These declarations share one member/plugin producer. Reuse its
            // origin within this synchronous union only; changed occurrence,
            // currentness or selection still goes through the real admission.
            const previous = pluginId ? admittedOriginsByPluginId.get(pluginId) : undefined;
            if (previous && previous.interactionEnabled === origin.interactionEnabled
                && (previous.executionOrigin === executionOrigin || (previous.executionOrigin !== null && executionOrigin !== null
                    && arePluginMachineExecutionOriginsEqual(previous.executionOrigin, executionOrigin)))) return previous;
            if (pluginId) admittedOriginsByPluginId.set(pluginId, origin);
            return origin;
        };

        for (const [pluginId, entry] of Object.entries(model.translationsByPluginId)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, translationsByPluginId, pluginId, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.sessionHeaderActionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, sessionHeaderActionsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.searchProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, searchProvidersById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.composerControlsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, composerControlsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.composerRegionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, composerRegionsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.hostedWebById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, hostedWebById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.reactNativeBundlesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, reactNativeBundlesById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.surfacePlacementsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, surfacePlacementsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.settingsGroupsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, settingsGroupsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.settingsPagesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, settingsPagesById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.actionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, actionsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.voiceProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, voiceProvidersById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.dragSourcesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, dragSourcesById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.workItemsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, workItemsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.dropTargetsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(model, dropTargetsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.unknownEntriesById)) {
            const origin = originFor(entry);
            if (origin) {
                publishFirstAdmitted(model, unknownEntriesById, id, stamp(entry, origin), origin);
            }
        }
        for (const [id, entry] of Object.entries(model.resourcesById)) {
            const hasProducerStamp = entry.executionOrigin !== undefined;
            const origin = hasProducerStamp
                ? resourceHasCurrentProducerOrigin(model, entry)
                    && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }) ? originFor(entry) : null
                // Earlier rows are only contextual facts of an admitted UI
                // contribution, never independent app-scope read authority.
                : admittedOriginsByPluginId.get(entry.pluginId);
            if (origin) publishFirstAdmitted(model, resourcesById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.inputTypesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                    || !selectedOriginsByPluginId.has(entry.pluginId)
                    || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
                ? originFor(entry)
                : null;
            // A registered type's schema remains a declaration when its source
            // cannot execute. Keep that occurrence for schema/options identity;
            // only the selected hostOrigin may authorize Resource or picker effects.
            if (origin) publishFirstAdmitted(model, inputTypesById, id, stamp(entry, origin), origin, true);
        }
        for (const [id, entry] of Object.entries(model.registrySourcesById)) {
            // Source visibility and suppliers are installation declarations;
            // Administration's executable selection does not remove an equivalent supplier.
            const representative = selectedMembersByPluginId.get(entry.pluginId)?.projection.registrySourcesById[id]
                ?? registrySourcesById[id];
            // A supplier must declare this row's content, not a conflicting URL.
            if (representative && !sameDeclarationContent(entry.definition, representative.definition, comparisons)) continue;
            const origin = model.installedPackagesById[entry.pluginId]?.enabled === true ? originFor(entry) : null;
            if (origin) publishFirstAdmitted(model, registrySourcesById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.skillsById)) {
            const origin = model.installedPackagesById[entry.pluginId]?.enabled === true ? originFor(entry) : null;
            if (origin) publishFirstAdmitted(model, skillsById, id, stamp(entry, origin), origin);
        }
        for (const [id, entry] of Object.entries(model.atmospherePicturesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                    || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
                ? originFor(entry)
                : null;
            if (origin) publishFirstAdmitted(model, atmospherePicturesById, id, stamp(entry, origin), origin);
        }
        // A package catalog fact has no contribution-level origin stamp of its
        // own. It is therefore visible in an app union only after one of that
        // same plugin's actual declarations were observed for this member —
        // by an exact installation or as an unmaterialized
        // contribution. This prevents a newer replica's brand from shadowing
        // the selected artifact's brand.
        for (const pluginId of admittedPluginIds) {
            const installedPackage = model.installedPackagesById[pluginId];
            if (installedPackage) {
                if (selectedMembersByPluginId.get(pluginId) === member) installedPackagesById[pluginId] = installedPackage;
                else if (!installedPackagesById[pluginId]) installedPackagesById[pluginId] = conflictedPluginIds.has(pluginId)
                    ? Object.freeze({ ...installedPackage, enabled: false, occurrenceId: undefined, sourceCustody: undefined, brand: undefined })
                    : installedPackage;
            }
        }
    }

    // Selection chooses one whole declaration, so entries exclusive to another
    // replica cannot leak into the selected artifact's catalog. Shared entries
    // keep their reported supplies for Administration's origin picker.
    const publishedMaps: readonly Record<string, unknown>[] = [translationsByPluginId, sessionHeaderActionsById, searchProvidersById,
        hostedWebById, reactNativeBundlesById, surfacePlacementsById, settingsGroupsById, settingsPagesById, actionsById,
        voiceProvidersById, dragSourcesById, workItemsById, dropTargetsById, atmospherePicturesById, registrySourcesById, skillsById, unknownEntriesById, inputTypesById,
        composerControlsById, composerRegionsById, resourcesById];
    for (const [index, map] of publishedMaps.entries()) {
        for (const [key, entry] of Object.entries(map)) {
            const pluginId = readString(asRecord(entry)?.pluginId);
            const selectedMember = pluginId ? selectedMembersByPluginId.get(pluginId) : undefined;
            if (!selectedMember) continue;
            const selectedMaps = [...declarationMaps(selectedMember.projection), selectedMember.projection.resourcesById];
            if (!Object.hasOwn(selectedMaps[index]!, key)) delete map[key];
        }
    }

    const generations = admittedContributing.map((member) => member.projection.generation);
    const generation = generations.every((memberGeneration) => memberGeneration === null)
        ? null
        : admittedContributing.length === 1
            ? generations[0]!
            : deriveUnionGeneration(admittedContributing);
    const entryCount = Object.keys(translationsByPluginId).length
        + Object.keys(sessionHeaderActionsById).length
        + Object.keys(searchProvidersById).length
        + Object.keys(hostedWebById).length
        + Object.keys(reactNativeBundlesById).length
        + Object.keys(surfacePlacementsById).length
        + Object.keys(settingsGroupsById).length
        + Object.keys(settingsPagesById).length
        + Object.keys(actionsById).length
        + Object.keys(voiceProvidersById).length
        + Object.keys(dragSourcesById).length
        + Object.keys(workItemsById).length
        + Object.keys(dropTargetsById).length
        + Object.keys(resourcesById).length
        + Object.keys(inputTypesById).length
        + Object.keys(atmospherePicturesById).length
        + Object.keys(registrySourcesById).length
        + Object.keys(skillsById).length
        + Object.keys(composerControlsById).length
        + Object.keys(composerRegionsById).length
        + Object.keys(unknownEntriesById).length;

    if (generation === null && entryCount === 0) {
        // Every member is still an ungeneration-ed empty snapshot, which is what
        // the canonical empty model already IS. Returning the shared instance
        // keeps a loading union from reading as a projection REPLACEMENT and
        // needlessly invalidating the React Native runtime.
        return Object.freeze({
            pluginUiProjection: emptyProjection ?? EMPTY_PLUGIN_UI_PROJECTION,
            phase,
            hasEstablishingMembers,
            interactionEnabled,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const pluginUiProjection: PluginUiProjectionModel = Object.freeze({
        ...establishingFacts,
        generation,
        installedPackagesById: Object.freeze(installedPackagesById),
        // Account-owned composers consume the same admitted declarations and
        // per-plugin supplies; Administration still selects execution origins.
        // Attachment state remains with its existing Session host consumers.
        composerAttachmentsById: Object.freeze({}),
        composerControlsById: Object.freeze(composerControlsById),
        composerRegionsById: Object.freeze(composerRegionsById),
        // Provisioner catalogs remain owned by their machine projection; no
        // App-union consumer selects or executes these contributions.
        machineProvisionersById: EMPTY_PLUGIN_UI_PROJECTION.machineProvisionersById,
        translationsByPluginId: Object.freeze(translationsByPluginId),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        searchProvidersById: Object.freeze(searchProvidersById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        settingsGroupsById: Object.freeze(settingsGroupsById),
        settingsPagesById: Object.freeze(settingsPagesById),
        actionsById: Object.freeze(actionsById),
        voiceProvidersById: Object.freeze(voiceProvidersById),
        dragSourcesById: Object.freeze(dragSourcesById),
        workItemsById: Object.freeze(workItemsById),
        dropTargetsById: Object.freeze(dropTargetsById),
        resourcesById: Object.freeze(resourcesById),
        inputTypesById: Object.freeze(inputTypesById),
        atmospherePicturesById: Object.freeze(atmospherePicturesById),
        registrySourcesById: Object.freeze(registrySourcesById),
        skillsById: Object.freeze(skillsById),
        // Openable viewers are scoped to a session/project details host. There is
        // no app-union consumer, so do not make app scope a second projection
        // owner for them.
        openableContentViewersById: Object.freeze({}),
        unknownEntriesById: Object.freeze(unknownEntriesById),
        transcriptActivitiesById: Object.freeze({}),
        sessionInfoSectionsById: Object.freeze({}),
    });

    return Object.freeze({
        pluginUiProjection,
        phase,
        unavailableReasonCode: soleMember?.unavailableReasonCode,
        hasEstablishingMembers,
        interactionEnabled,
        machineId: soleMember?.machineId ?? null,
        serverId: soleMember?.serverId ?? null,
    });
}
