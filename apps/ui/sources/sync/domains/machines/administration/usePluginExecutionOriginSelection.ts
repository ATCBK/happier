import * as React from 'react';
import { t } from '@/text';
import { useCurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { CurrentUiContextPluginExecutionOriginCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginExecutionOriginActionOutputSchemas, type PluginExecutionOriginActionId } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeListKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { getStorage, storage } from '@/sync/domains/state/storageStore';
import { useSetting, useSettingsVersion } from '@/sync/store/hooks';
import {
    type OneShotAccountSettingsMutationResult,
} from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

import {
    buildPluginMachineExecutionOriginCandidates,
    buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    serializePluginMachineExecutionOriginMachineFacts,
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineReleaseClassificationV1,
    type PluginMachineSourceExecutionOriginCandidateV1,
    type PluginExecutionOriginCandidateV1,
    type PluginExecutionOriginContextualTarget,
} from './pluginExecutionOrigin';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildMachineAdministrationCandidatesFromSnapshots } from './targetState';
import type { MachineAdministrationCandidateV1 } from './targetSelection';
import {
    resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1,
} from './useTargetSelection';

export type FreshPluginMachineExecutionOriginV1 = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    materialization?: PluginMachineMaterializationV1;
    source?: PluginMachineSourceExecutionOriginCandidateV1['source'];
    machineTarget: FreshMachineAdministrationExecutionTargetV1;
    /** UI-local fence for origin selection changes, including A -> B -> A. */
    selectionRevision?: number;
}>;

type PluginExecutionOriginSelectionRevisionState = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    revision: number;
}>;

const EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS: readonly PluginMachineMaterializationV1[] = Object.freeze([]);
const EMPTY_EXECUTION_ORIGIN_SOURCES: readonly PluginMachineSourceExecutionOriginCandidateV1[] = Object.freeze([]);
type ExecutionOriginMachineSnapshotSelection = Readonly<{
    key: string;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
}>;
const DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION = Object.freeze({
    key: '',
    snapshots: EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS,
});

type StorageState = ReturnType<typeof storage.getState>;

let cachedServerProfiles: Readonly<{
    generation: number;
    profiles: ReturnType<typeof listServerProfiles>;
}> | null = null;

let cachedExecutionOriginMachineSnapshots: Readonly<{
    profiles: ReturnType<typeof listServerProfiles>;
    activeServerId: string;
    accountScopeKey: string;
    machines: StorageState['machines'];
    machineListByServerId: StorageState['machineListByServerId'];
    machineListStatusByServerId: StorageState['machineListStatusByServerId'];
    observedAtMs: number;
    reachabilityRevision: number;
    nextRefreshAtMs: number | null;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
}> | null = null;

function readServerProfilesForGeneration(generation: number): ReturnType<typeof listServerProfiles> {
    if (cachedServerProfiles?.generation === generation) return cachedServerProfiles.profiles;
    const profiles = listServerProfiles();
    cachedServerProfiles = { generation, profiles };
    return profiles;
}

/**
 * All app-shell plugin selectors observe the same raw inventory update. Resolve
 * that canonical projection once per store snapshot instead of once per plugin.
 */
function readExecutionOriginMachineSnapshots(params: Readonly<{
    activeServerId: string;
    profilesGeneration: number;
    reachabilityRevision: number;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    state: StorageState;
}>): readonly ServerMachineInventorySnapshotV1[] {
    const profiles = readServerProfilesForGeneration(params.profilesGeneration);
    const accountScopeKey = serverAccountScopeListKey([...params.accountScopesByServerId.values()]);
    const cached = cachedExecutionOriginMachineSnapshots;
    const nowMs = Date.now();
    if (
        cached?.profiles === profiles
        && cached.activeServerId === params.activeServerId
        && cached.accountScopeKey === accountScopeKey
        && cached.machines === params.state.machines
        && cached.machineListByServerId === params.state.machineListByServerId
        && cached.machineListStatusByServerId === params.state.machineListStatusByServerId
        && cached.reachabilityRevision === params.reachabilityRevision
        && nowMs >= cached.observedAtMs
        && (cached.nextRefreshAtMs === null || nowMs < cached.nextRefreshAtMs)
    ) return cached.snapshots;

    const snapshots = resolveAllProfileMachineInventorySnapshots({
        profiles,
        activeServerId: params.activeServerId,
        activeMachines: Object.values(params.state.machines),
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        accountScopesByServerId: params.accountScopesByServerId,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    });
    // Time is also an eligibility input. Reuse the canonical presence deadline
    // rather than keeping equal raw rows authoritative past their grace period.
    let nextRefreshAtMs: number | null = null;
    for (const snapshot of snapshots) for (const machine of snapshot.machines) {
        const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
        if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
    }
    cachedExecutionOriginMachineSnapshots = {
        profiles,
        activeServerId: params.activeServerId,
        accountScopeKey,
        machines: params.state.machines,
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        observedAtMs: nowMs,
        reachabilityRevision: params.reachabilityRevision,
        nextRefreshAtMs,
        snapshots,
    };
    return snapshots;
}

function usePluginExecutionOriginMachineSnapshots(params: Readonly<{
    enabled: boolean;
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
}>): ExecutionOriginMachineSnapshotSelection {
    const activeServerId = useActiveServerSnapshot().serverId;
    const profilesGeneration = useServerProfilesGeneration();
    const profiles = readServerProfilesForGeneration(profilesGeneration);
    const bindings = useServerCredentialAccountScopeBindings(params.enabled ? profiles.map(profile => profile.serverIdentityId) : []);
    const accountScopesByServerId = React.useMemo(() => new Map([...bindings].flatMap(([serverId, binding]) =>
        binding.isCurrent() ? [[serverId, binding.scope] as const] : [])), [bindings]);
    const reachabilityRevision = useMachineReachabilityRevision(params.enabled);
    const presenceNowMs = useSessionListRuntimeNowMs(params.enabled);
    const selectSnapshots = React.useMemo(() => {
        // React can retain the previous getSnapshot while rendering new inputs.
        // Its settled value belongs to this selector, not a ref shared with its successor.
        let previous: Readonly<{
            snapshots: readonly ServerMachineInventorySnapshotV1[];
            selection: ExecutionOriginMachineSnapshotSelection;
        }> | null = null;
        return (state: StorageState) => {
            if (!params.enabled) return DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION;
            const snapshots = readExecutionOriginMachineSnapshots({ activeServerId, profilesGeneration, reachabilityRevision, accountScopesByServerId, state });
            // The raw inventory owner already preserves identity for unrelated store
            // updates. Reuse that fact before doing per-plugin eligibility scans.
            if (previous?.snapshots === snapshots) return previous.selection;
            const key = `${serverAccountScopeListKey([...accountScopesByServerId.values()])}\u0000${serializePluginMachineExecutionOriginMachineFacts({
                pluginId: params.pluginId,
                materializations: params.materializations,
                sources: params.sources,
                machineSnapshots: snapshots,
            })}`;
            const selection = previous?.selection.key === key ? previous.selection : Object.freeze({ key, snapshots });
            previous = { snapshots, selection };
            return selection;
        };
    }, [activeServerId, params.enabled, params.materializations, params.pluginId, params.sources, profilesGeneration, reachabilityRevision, accountScopesByServerId, presenceNowMs]);
    const selection = getStorage()(selectSnapshots);
    const nextRefreshAtMs = React.useMemo(() => {
        let deadline: number | null = null;
        for (const snapshot of selection.snapshots) for (const machine of snapshot.machines) {
            const next = readMachineStatusNextRefreshAtMs(machine, Math.max(presenceNowMs, Date.now()));
            if (next !== null) deadline = deadline === null ? next : Math.min(deadline, next);
        }
        return deadline;
    }, [selection.snapshots, presenceNowMs]);
    useSessionListRuntimeWake(nextRefreshAtMs, params.enabled);
    return selection;
}

export function advancePluginExecutionOriginSelectionRevision(
    previous: PluginExecutionOriginSelectionRevisionState,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null,
): PluginExecutionOriginSelectionRevisionState {
    const unchanged = previous.pluginId === pluginId
        && (
            previous.origin === null
                ? origin === null
                : origin !== null && arePluginMachineExecutionOriginsEqual(previous.origin, origin)
        );
    return unchanged
        ? previous
        : Object.freeze({ pluginId, origin, revision: previous.revision + 1 });
}

type FreshPluginExecutionOriginParams = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>;

/** Invocation-time candidates over the same Availability and raw machine owners. */
export function readFreshPluginMachineExecutionOriginCandidates(params: FreshPluginExecutionOriginParams): readonly PluginExecutionOriginCandidateV1[] {
    const admission = params.reader?.readMaterializations();
    const materializationCandidates = admission?.kind === 'available'
        ? admission.materializations.filter((entry) => entry.pluginId === params.pluginId).map((materialization) => {
            const release = params.classifyRelease(materialization);
            const rejected = !materialization.enabled ? 'disabled' as const
                : materialization.trustState !== 'trusted' ? 'untrusted' as const
                    : !resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId }) ? 'offline' as const : null;
            return { materialization, ...release, ...(rejected ? { validation: { kind: 'rejected' as const, reason: rejected } } : {}) };
        }) : [];
    const sourceCandidates = (params.sourceCandidates ?? []).filter(candidate => candidate.source.origin.sourceRef.pluginId === params.pluginId)
        .map((candidate): PluginMachineSourceExecutionOriginCandidateV1 => {
        const origin = candidate.source.origin;
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId });
        return machineTarget ? candidate : { ...candidate, validation: { kind: 'rejected', reason: 'offline' } };
    });
    return combinePluginMachineExecutionOriginCandidates(materializationCandidates, sourceCandidates);
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: FreshPluginExecutionOriginParams): FreshPluginMachineExecutionOriginV1 | null {
    const candidates = readFreshPluginMachineExecutionOriginCandidates(params);
    const state = resolvePluginMachineExecutionOriginState({ pluginId: params.pluginId, storedOrigin: params.origin,
        candidates, declaredDefaultOrigins: params.declaredDefaultOrigins, contextualTarget: params.contextualTarget });
    if (state.kind !== 'selected') return null;
    const origin = state.origin;
    const machineTarget = resolveFreshMachineAdministrationExecutionTarget({
        serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId,
    });
    if (!machineTarget) return null;
    return Object.freeze({ origin, ...('source' in state.candidate ? { source: state.candidate.source } : { materialization: state.candidate.materialization }), machineTarget });
}

export type PluginMachineExecutionOriginSelectionV1 = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    selectedOrigin: PluginMachineExecutionOriginV1 | null;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => Promise<PluginExecutionOriginSelectionMutationResult>;
    clearOrigin: () => Promise<PluginExecutionOriginSelectionMutationResult>;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

export type PluginExecutionOriginSelectionMutationResult =
    | OneShotAccountSettingsMutationResult<void>
    | Readonly<{ status: 'applied'; value: void }>
    | Readonly<{ status: 'unavailable' }>
    | PluginExecutionOriginPreferenceApproval;

export type PluginExecutionOriginPreferenceApproval = Readonly<{
    status: 'approvalPending';
    scope: AccountSettingsScope;
    input: unknown;
    approval: ActionApprovalRequestCreatedResult & Readonly<{
        actionId: Exclude<PluginExecutionOriginActionId, 'plugins.execution_origin.list'>;
    }>;
}>;

/**
 * Exact plugin-origin selection over the canonical Account Availability
 * reader. Artifact release classification is a required dependency, keeping
 * immutable-content and compatibility authority out of Administration.
 */
export function usePluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    enabled?: boolean;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readSourceCandidates?: () => readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    readDeclaredDefaultOrigins?: () => readonly PluginMachineExecutionOriginV1[];
    /** Renderless app-shell consumers do not subscribe to machine labels or heartbeat timestamps. */
    includeMachineCandidates?: boolean;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const enabled = params.enabled !== false;
    const materializationAdmission = React.useMemo(
        () => enabled ? reader?.readMaterializations() ?? null : null,
        [enabled, reader],
    );
    const includeMachineCandidates = params.includeMachineCandidates !== false;
    const materializations = materializationAdmission?.kind === 'available'
        ? materializationAdmission.materializations : EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS;
    const sources = params.sourceCandidates ?? EMPTY_EXECUTION_ORIGIN_SOURCES;
    const semanticMachineSelection = usePluginExecutionOriginMachineSnapshots({
        enabled: enabled && !includeMachineCandidates,
        pluginId: params.pluginId,
        materializations,
        sources,
    });
    const presentationMachineSnapshots = useAllProfileMachineInventorySnapshots(enabled && includeMachineCandidates);
    const machineSnapshots = includeMachineCandidates ? presentationMachineSnapshots : semanticMachineSelection.snapshots;
    const machineCandidates = React.useMemo(() => enabled && includeMachineCandidates
        ? buildMachineAdministrationCandidatesFromSnapshots({ snapshots: presentationMachineSnapshots })
        : Object.freeze([]), [enabled, includeMachineCandidates, presentationMachineSnapshots]);
    const selections = useSetting('machineAdministrationSelectionsV1');
    const settingsVersion = useSettingsVersion();
    const expectedSettingsScope = useAccountSettingsScope();
    const expectedAccountLifetime = captureActiveServerAccountScopeLifetime();
    const [contextualChoice, setContextualChoice] = React.useState<Readonly<{
        pluginId: string;
        target: PluginExecutionOriginContextualTarget;
        accountLifetime: typeof expectedAccountLifetime;
        origin: PluginMachineExecutionOriginV1;
    }> | null>(null);
    const hasContextualChoice = Boolean(params.contextualTarget && contextualChoice
        && contextualChoice.pluginId === params.pluginId
        && contextualChoice.accountLifetime === expectedAccountLifetime
        && contextualChoice.target.serverIdentityId === params.contextualTarget.serverIdentityId
        && contextualChoice.target.machineId === params.contextualTarget.machineId);
    const contextualChoiceRef = React.useRef(contextualChoice);
    contextualChoiceRef.current = contextualChoice;
    const storedOrigin = params.contextualTarget !== undefined
        ? hasContextualChoice ? contextualChoice!.origin : null
        : selections.pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
    const contextualTarget = hasContextualChoice ? undefined : params.contextualTarget;
    const selectionRevisionRef = React.useRef<PluginExecutionOriginSelectionRevisionState>({
        pluginId: params.pluginId,
        origin: storedOrigin,
        revision: 0,
    });
    selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
        selectionRevisionRef.current,
        params.pluginId,
        storedOrigin,
    );
    const machineFactsKey = includeMachineCandidates
        ? serializePluginMachineExecutionOriginMachineFacts({ pluginId: params.pluginId,
            materializations, sources, machineSnapshots: presentationMachineSnapshots })
        : semanticMachineSelection.key;
    // Raw inventory can refresh presentation without changing any selection fact.
    const candidates = React.useMemo(() => enabled ? combinePluginMachineExecutionOriginCandidates(buildPluginMachineExecutionOriginCandidates({
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        classifyRelease: params.classifyRelease,
    }), buildPluginMachineSourceExecutionOriginCandidates({ pluginId: params.pluginId,
        sources: params.sourceCandidates ?? [], machineSnapshots })) : Object.freeze([]), [enabled, machineFactsKey, materializationAdmission, params.classifyRelease, params.pluginId, params.sourceCandidates]);
    const state = React.useMemo<PluginMachineExecutionOriginStateV1>(() => enabled ? resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        candidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
        contextualTarget,
    }) : Object.freeze({ kind: 'selectionRequired', candidates }), [enabled, candidates, contextualTarget, params.declaredDefaultOrigins, params.pluginId, storedOrigin]);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;
    const contextualFacts = React.useRef({ params, enabled, reader, expectedAccountLifetime, expectedSettingsScope });
    contextualFacts.current = { params, enabled, reader, expectedAccountLifetime, expectedSettingsScope };
    const contextualCommand = React.useMemo<CurrentUiContextPluginExecutionOriginCommand | null>(() => {
        const target = params.contextualTarget;
        const account = expectedAccountLifetime;
        if (!target || !account || !enabled) return null;
        const facts = () => {
            const latest = contextualFacts.current;
            if (!latest.enabled || latest.expectedAccountLifetime !== account || !account.isCurrent()
                || latest.params.pluginId !== params.pluginId
                || latest.params.contextualTarget?.serverIdentityId !== target.serverIdentityId
                || latest.params.contextualTarget?.machineId !== target.machineId
                || !areAccountSettingsScopesEqual(latest.expectedSettingsScope, storage.getState().settingsScope)) return null;
            return { pluginId: params.pluginId, origin: null, reader: latest.reader, classifyRelease: latest.params.classifyRelease,
                sourceCandidates: latest.params.readSourceCandidates?.() ?? latest.params.sourceCandidates,
                declaredDefaultOrigins: latest.params.readDeclaredDefaultOrigins?.() ?? latest.params.declaredDefaultOrigins };
        };
        return {
            kind: 'pluginExecutionOrigin', pluginId: params.pluginId, account, target,
            read: () => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                const choice = contextualChoiceRef.current;
                const storedOrigin = choice?.accountLifetime === account && choice.pluginId === params.pluginId
                    && choice.target.serverIdentityId === target.serverIdentityId && choice.target.machineId === target.machineId
                    ? choice.origin : null;
                const candidates = readFreshPluginMachineExecutionOriginCandidates(current);
                const selection = resolvePluginMachineExecutionOriginState({ ...current, storedOrigin, candidates,
                    contextualTarget: storedOrigin ? undefined : target });
                return { status: 'available', storedOrigin, selectedOrigin: selection.kind === 'selected' ? selection.origin : null,
                    candidates: candidates.map(candidate => ({ origin: getPluginExecutionOriginCandidateOrigin(candidate),
                        version: getPluginExecutionOriginCandidateVersion(candidate), selectable: isPluginMachineExecutionOriginCandidateSelectable(candidate) })) };
            },
            apply: origin => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                if (origin) {
                    const admitted = resolveFreshPluginMachineExecutionOrigin({ ...current, origin });
                    if (!admitted || !arePluginMachineExecutionOriginsEqual(admitted.origin, origin)) return { status: 'unavailable' };
                }
                const choice = origin ? { pluginId: params.pluginId, target, accountLifetime: account, origin } : null;
                contextualChoiceRef.current = choice;
                setContextualChoice(choice);
                return { status: 'applied' };
            },
        };
    }, [enabled, expectedAccountLifetime, params.pluginId, params.contextualTarget?.serverIdentityId, params.contextualTarget?.machineId]);
    const readContextualCommandId = useCurrentUiContextMountedCommand(contextualCommand, t('plugins.executionOriginTitle'));

    const executePreference = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1 | null,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        const isCurrent = () => enabled && expectedAccountLifetime?.isCurrent() === true
            && areAccountSettingsScopesEqual(expectedSettingsScope, expectedAccountLifetime.scope)
            && areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope);
        const contextual = params.contextualTarget !== undefined;
        const commandId = contextual ? readContextualCommandId() : null;
        if (!expectedSettingsScope || !isCurrent() || (contextual ? !commandId : settingsVersion === null)) return { status: 'unavailable' };
        const actionId = origin === null ? 'plugins.execution_origin.clear' : 'plugins.execution_origin.set';
        const input = { pluginId: params.pluginId,
            ...(contextual ? { contextualTarget: { commandId } } : { expectedSettingsVersion: settingsVersion }),
            ...(origin === null ? {} : { origin }) };
        // Resolve the canonical policy/provenance owner only on intent. Idle
        // plugin selectors do not construct Action dependencies or approval subscriptions.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        if (!isCurrent()) return { status: 'unavailable' };
        const result = await createFrontDoorActionExecute()(actionId, input, {
            surface: 'ui', serverId: expectedSettingsScope.serverId, expectedAccountId: expectedSettingsScope.accountId,
        });
        if (!result.ok || !isCurrent()) return { status: 'unavailable' };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success && approval.data.actionId === actionId) {
            return { status: 'approvalPending', scope: expectedSettingsScope, input,
                approval: { ...approval.data, actionId } };
        }
        const settled = PluginExecutionOriginActionOutputSchemas[actionId].safeParse(result.result);
        if (!settled.success) return { status: 'unavailable' };
        return settled.data.status === 'applied' ? { ...settled.data, value: undefined } : settled.data;
    }, [enabled, expectedAccountLifetime, expectedSettingsScope, params.contextualTarget, params.pluginId, readContextualCommandId, settingsVersion]);

    const selectOrigin = React.useCallback((origin: PluginMachineExecutionOriginV1) => executePreference(origin), [executePreference]);
    const clearOrigin = React.useCallback(() => executePreference(null), [executePreference]);

    const resolveExecutionOrigin = React.useCallback(() => {
        if (!enabled || !areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope)) return null;
        const origin = params.contextualTarget !== undefined ? storedOrigin : storage.getState().settings.machineAdministrationSelectionsV1
            .pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
        selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
            selectionRevisionRef.current,
            params.pluginId,
            origin,
        );
        const resolved = resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: currentParamsRef.current.readSourceCandidates?.() ?? currentParamsRef.current.sourceCandidates,
            declaredDefaultOrigins: currentParamsRef.current.readDeclaredDefaultOrigins?.() ?? currentParamsRef.current.declaredDefaultOrigins,
            contextualTarget,
        });
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedSettingsScope, contextualTarget, params.contextualTarget, params.classifyRelease, params.pluginId, reader, storedOrigin]);

    const canExecute = React.useMemo(() => enabled && resolveFreshPluginMachineExecutionOrigin({
        pluginId: params.pluginId,
        origin: storedOrigin,
        reader,
        classifyRelease: params.classifyRelease,
        sourceCandidates: params.sourceCandidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
        contextualTarget,
    }) !== null, [enabled, machineFactsKey, params.classifyRelease, params.pluginId, params.sourceCandidates,
        contextualTarget, params.declaredDefaultOrigins, reader, storedOrigin]);

    return React.useMemo(() => ({
        candidates,
        machineCandidates,
        state,
        selectedOrigin: enabled ? state.kind === 'selected' ? state.origin : storedOrigin : null,
        canExecute,
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        canExecute,
        machineCandidates,
        enabled,
        clearOrigin,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
    ]);
}
