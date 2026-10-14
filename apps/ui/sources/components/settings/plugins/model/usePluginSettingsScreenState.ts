import * as React from 'react';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';

import {
    getMachineCapabilitiesCacheState,
    prefetchMachineCapabilities,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { MARKETPLACE_CAPABILITY_REQUEST, usePluginsAdministrationTarget } from './usePluginsAdministrationTarget';
import {
    resolveMachineAdministrationTargetLabel,
} from '@/sync/domains/machines/administration/targetSelection';
import type {
    FreshMachineAdministrationExecutionTargetV1,
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
    publishMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    machinePluginInstallDecision,
    reviewMachinePluginInstallationAsPresentUser,
    type MachinePluginInstallDecisionOutcome,
    type MachinePluginInstallDecisionResult,
} from '@/sync/ops/machinePluginInstallDecision';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { PluginDevLoopActionIdV1 } from '@happier-dev/protocol';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { type PluginProjectionV2, type PluginScaffoldUiMode } from '@happier-dev/protocol';
import {
    type PluginUpdatePolicyV1,
} from '@happier-dev/protocol/marketplace';
import { t } from '@/text';
import { Modal } from '@/modal';

import {
    mergeDiscoverEntries,
    mergeDiscoverNonInstallableListings,
    projectRegistryMarketplacePage,
    registryPluginSourceKind,
    type PluginMarketplaceCatalogEntry,
    type PluginMarketplaceCatalogSourceKind,
    type PluginMarketplaceDiscoverDiagnostic,
    type PluginMarketplaceDiscoverSourceStatus,
    type PluginMarketplaceNonInstallableListing,
} from '../readPluginMarketplaceCatalog';
import { showPluginRegistryProfileSelectionDialog } from '../PluginRegistryProfileSelectionDialog';
import {
    usePluginRegistrySourceAdministration,
    type PluginRegistrySourceAdministrationV1,
    type MarketplaceSourceRegistryPresentationV1,
} from './usePluginRegistrySourceAdministration';
import {
    MARKETPLACE_CAPABILITY_ID,
    readDevelopmentCreateAvailable,
    readDevelopmentSourceInstallAvailable,
    readDevelopmentPlugins,
    readInstalledPlugins,
    projectAccountInstalledPlugins,
    isPluginMutationVisibleAfterRefresh,
    readPluginChangeKind,
    readPluginManagedResourceRemovalReview,
    isPluginDisableNoopResult,
    readPluginCreateResult,
    readPluginEditTargetResult,
    readPendingPluginChangeDecision,
    readPendingPluginChangeDecisionId,
    readPendingPluginChangeListingId,
    readPendingPluginChanges,
    resolvePluginDaemonOperationsAvailability,
    readPendingPluginChangeReview,
    readPendingPluginChangeStatus,
    readPluginInstallationReviewChange,
    readPluginRegistryProfileRequirement,
    resolvePluginReadOnlySnapshotNotice,
    resolvePluginTruthReadState,
    type DevelopmentPluginEntry,
    projectInstalledPluginLifecycleCapabilities,
    type InstalledPluginEntry,
    type PendingPluginChangeDecision,
    type PendingPluginChangeListing,
    type PendingPluginChangeReview,
    type PendingPluginDevelopmentProjectTrustReview,
    type PluginMarketplaceActionRequest,
    type PluginReadOnlySnapshotNoticeState,
    type PluginSettingsViewId,
} from './pluginMarketplaceModel';

/**
 * The lifecycle actions an installed row or its detail screen may run.
 *
 * `update` belongs here rather than only on a marketplace listing: the daemon
 * update owner reads the installed record's own trusted channel, so whether a
 * Discover listing happens to be on screen has nothing to do with whether the
 * user can update what they already have.
 */
export type InstalledPluginActionId =
    | 'enable'
    | 'disable'
    | 'update'
    | 'rollback'
    | 'uninstall'
    | 'forgetTrust';

type ConfirmedPluginChangeAction = 'update' | 'rollback' | 'uninstall' | 'forgetTrust';
type CommitIntendedPluginChangeAction = 'install' | 'disable' | ConfirmedPluginChangeAction;
type PluginActionCountsByAuthority = Readonly<Record<string, Readonly<Record<string, number>>>>;
type DiscoverQueryIntent = Readonly<{
    text: string;
    sourceId: string | null;
    /** A listing page resolves exactly this source-qualified listing through the same query. */
    pluginId?: string | null;
}>;
const EMPTY_DISCOVER_VALUES: readonly never[] = [];

export type PluginRoutineOperationSettlement = Readonly<{
    scope: 'installed' | 'discover' | 'pending' | 'development';
    message: string;
    detail?: string;
}>;

export type DevelopmentCreateSettlement =
    | Readonly<{
        status: 'success';
        created: Readonly<{ pluginId: string; sourceRootPath: string }>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'operationUnavailable' | 'authorityChanged' | 'requestFailed' | 'invalidResult';
    }>;

export type DevelopmentEditTargetSettlement =
    | Readonly<{
        status: 'success';
        target: Readonly<{ pluginId: string; sourceRootPath: string; sessionDirectory: string }>;
    }>
    | Readonly<{
        status: 'unavailable';
        reason: 'operationUnavailable' | 'authorityChanged' | 'requestFailed' | 'invalidResult';
    }>;

function resolvePluginChangeActionLabel(action: CommitIntendedPluginChangeAction): string {
    if (action === 'install') return t('common.install');
    if (action === 'update') return t('common.update');
    if (action === 'rollback') return t('settingsPlugins.rollback');
    if (action === 'uninstall') return t('settingsPlugins.uninstall');
    if (action === 'disable') return t('common.disable');
    return t('settingsPlugins.forgetTrust');
}

export type PluginSettingsScreenState = Readonly<{
    activeView: PluginSettingsViewId;
    administrationTargetSelection: MachineAdministrationTargetSelectionV1;
    administrationTargetLabel: Readonly<{ machine: string; server: string }> | null;
    currentDiagnostics: readonly { code: string; message: string }[];
    accountServerIdentityId: string | null;
    selectedServerIdentityId: string | null;
    executionServerIdentityId: string | null;
    executionServerId: string | null;
    executionMachineId: string | null;
    /**
     * The selected machine's reported home directory, so a canonical
     * development root can be shown `~`-relative exactly as an ordinary Session
     * working directory is. Absent home simply shows the absolute root.
     */
    executionMachineHomeDir: string | null;
    /** Rejects renderer-originated writes once this exact daemon target retires. */
    isDaemonSettingsTargetCurrent: (target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => boolean;
    discoverError: string | null;
    /** Draft search text for the aggregate Discover query. */
    discoverSearchText: string;
    /** The query the shown results answer; null until a query returns, not an empty result. */
    discoverResultsSearchText: string | null;
    /** Empties the search and shows every listing again (the "no match" Clear). */
    clearDiscoverSearch: () => void;
    canRefreshDiscover: boolean;
    canRunDiscoverActions: boolean;
    canRefreshInstalledPlugins: boolean;
    daemonOperationsAvailable: boolean;
    /** Exact daemon administration RPCs; independent of contribution projection readiness. */
    daemonAdministrationAvailable: boolean;
    developmentCreateAvailable: boolean;
    developmentSourceInstallAvailable: boolean;
    developmentPlugins: readonly DevelopmentPluginEntry[];
    discoverEntries: readonly PluginMarketplaceCatalogEntry[];
    discoverNextCursor: string | null;
    /** Selectable source chips beside All: enabled configured sources plus community npm. */
    discoverSources: readonly Readonly<{ id: string; title: string; kind: PluginMarketplaceCatalogSourceKind }>[];
    /** Per-source freshness the daemon actually had when it served the shown page. */
    discoverSourceStatuses: readonly PluginMarketplaceDiscoverSourceStatus[];
    /** Index-wide diagnostics for the shown page; never collapsed into one failure. */
    discoverDiagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    /** Listings the daemon returned that this machine cannot install right now. */
    discoverNonInstallable: readonly PluginMarketplaceNonInstallableListing[];
    /** The shown list answers an earlier query than the controls now describe. */
    discoverStale: boolean;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    installedPlugins: readonly InstalledPluginEntry[];
    /** `null` is aggregate All: the query carries no source filter at all. */
    selectedDiscoverSourceId: string | null;
    loadingMoreDiscover: boolean;
    /** Daemon-held changes — including ones an Agent prepared — awaiting this user. */
    pendingPluginChanges: readonly PendingPluginChangeListing[];
    routineOperationSettlement: PluginRoutineOperationSettlement | null;
    decidePendingPluginChange: (pendingChangeId: string, decision: 'approve' | 'reject') => void;
    readOnlySnapshotNotice: PluginReadOnlySnapshotNoticeState | null;
    refreshPluginTruth: () => void;
    isPluginActionInFlight: (pluginId: string) => boolean;
    refreshDiscover: () => void;
    loadingDiscover: boolean;
    marketplaceSourceRegistry: MarketplaceSourceRegistryPresentationV1 | null;
    marketplaceSourceRegistryAvailable: boolean;
    marketplaceSourceRegistryScopeKey: string | null;
    marketplaceSourceRegistryLoading: boolean;
    marketplaceSourceRegistryLoadError: boolean;
    marketplaceSourceRegistryMutationInFlight: boolean;
    marketplaceSourceRegistryMutationOutcomeUnknown: boolean;
    refreshMarketplaceSourceRegistry: () => void;
    upsertMarketplaceSource: PluginRegistrySourceAdministrationV1['upsertSource'];
    setMarketplaceSourceEnabled: PluginRegistrySourceAdministrationV1['setSourceEnabled'];
    removeMarketplaceSource: PluginRegistrySourceAdministrationV1['removeSource'];
    pluginProjectionById: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { pluginProjectionById: infer TProjectionById }
            ? TProjectionById
            : Record<string, never>
        : Record<string, never>;
    /** Current exact daemon projection only; stale cache never authorizes execution. */
    pluginProjectionV2: PluginProjectionV2 | null;
    /** True only when the selected daemon has authoritatively answered both installed and projected plugin truth. */
    pluginTruthSettled: boolean;
    /**
     * Whether the selected machine has answered what it has installed. The Installed list waits on
     * this read alone (not on the contribution projection, which only enriches a plugin's detail),
     * so a slow or failed projection never leaves the list loading.
     */
    installedPluginsRead: boolean;
    registryDiagnostics: ReturnType<typeof useDaemonMergedProjectionInputs>['inputs'] extends infer TInputs
        ? TInputs extends { registryDiagnostics: infer TDiagnostics }
            ? TDiagnostics
            : readonly []
        : readonly [];
    runCatalogAction: (params: PluginMarketplaceActionRequest) => void;
    runDevelopmentCreate: (params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>) => Promise<DevelopmentCreateSettlement>;
    resolveDevelopmentEditTarget: (pluginId: string) => Promise<DevelopmentEditTargetSettlement>;
    runDevelopmentSourceInstall: (sourceRootPath: string) => void;
    runDevelopmentAction: (action: 'test' | 'pack' | 'unregister', pluginId: string) => void;
    runInstalledPluginAction: (action: InstalledPluginActionId, pluginId: string) => void;
    setInstalledPluginUpdatePolicy: (pluginId: string, policy: PluginUpdatePolicyV1) => void;
    setActiveView: (view: PluginSettingsViewId) => void;
    setDiscoverSearchText: (value: string) => void;
    setSelectedDiscoverSourceId: (sourceId: string | null) => void;
    /**
     * Acquires one exact source-qualified listing (a listing page, a deep link) through the one
     * Discover query, so its Install acts under the same authority as a Browse card's.
     */
    openDiscoverListing: (listing: Readonly<{ sourceId: string; pluginId: string }>) => void;
    loadMoreDiscover: () => void;
    setMarketplaceSourceProfile: PluginRegistrySourceAdministrationV1['setSourceRegistryProfile'];
}>;

export function usePluginSettingsScreenState(params: Readonly<{ focused?: boolean }> = {}): PluginSettingsScreenState {
    const activeServer = useActiveServerSnapshot();
    const discoverExecution = useMountedActionExecution(activeServer.serverId);
    const discoverAccountKey = discoverExecution.binding ? JSON.stringify([
        discoverExecution.binding.scope.serverId, discoverExecution.binding.scope.accountId,
    ]) : null;
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const accountInstalledAdmission = React.useMemo(() => availabilityReader?.readInstalledPlugins() ?? null, [availabilityReader]);
    // The one administration-target owner. It supplies the selection, the exact
    // Settings/Secrets record target, and the single currentness fence every
    // asynchronous write re-checks — shared with the deep-linked Settings page
    // screen so the two cannot disagree about which machine is being edited.
    const {
        administration,
        selectedMachineScopeKey,
        daemonTransportOnline,
        daemonCacheFreshnessKey,
        machineCapabilities,
    } = usePluginsAdministrationTarget();
    const capabilityRequest = MARKETPLACE_CAPABILITY_REQUEST;
    const administrationTargetSelection = administration.selection;
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const executionTarget = administration.executionTarget;
    const selectedServerIdentityId = administration.selectedServerIdentityId;
    const executionMachineId = executionTarget?.machine.id ?? null;
    const executionMachineHomeDir = executionTarget?.machine.metadata?.homeDir ?? null;
    const executionServerId = executionTarget?.serverId ?? null;
    const executionServerIdentityId = executionTarget?.target.serverIdentityId ?? null;
    const { invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    /**
     * Every asynchronous daemon boundary re-resolves the portable target. A
     * rendered target is presentation state; this guard rejects a stale or
     * retired target before it can route an effect or mutation.
     */
    const resolveCurrentExecutionTarget = administration.resolveCurrentExecutionTarget;
    const isDaemonSettingsTargetCurrent = administration.isTargetCurrent;

    const [activeView, setActiveView] = React.useState<PluginSettingsViewId>('installed');
    /**
     * The Discover controls, split into the draft the user is editing and the
     * query the shown list actually answers.
     *
     * They are separate on purpose: typing must not re-query, and the list on
     * screen must be able to say honestly which text and which source it came
     * from even after the user has changed the controls again.
     */
    const [discoverSearchText, setDiscoverSearchText] = React.useState('');
    // `null` is aggregate All. Discover opens on All and stays there until the
    // user picks a chip; no configured "preferred" source silently narrows it.
    const [selectedDiscoverSourceId, setSelectedDiscoverSourceIdState] = React.useState<string | null>(null);
    const [desiredDiscoverQuery, setDesiredDiscoverQuery] = React.useState<DiscoverQueryIntent | null>(null);
    const registryBrowse = useRegistryItems({ kind: 'plugin',
        ...(desiredDiscoverQuery?.sourceId ? { sourceIds: [desiredDiscoverQuery.sourceId] } : {}),
        query: desiredDiscoverQuery?.text.trim() ?? '',
    }, desiredDiscoverQuery !== null && discoverExecution.ready);
    // Rich cards are a projection of one Account/source snapshot, not authority
    // to keep a removed or retired source actionable while its replacement fails.
    const discoverDataKey = discoverAccountKey === null ? null
        : JSON.stringify([discoverAccountKey, registryBrowse.sourceRevision]);
    const [acquiredDiscoverQuery, setAcquiredDiscoverQuery] = React.useState<Readonly<{
        text: string;
        sourceId: string | null;
    }> | null>(null);
    const [discoverEntries, setDiscoverEntries] = React.useState<readonly PluginMarketplaceCatalogEntry[]>([]);
    const [discoverNextCursor, setDiscoverNextCursor] = React.useState<string | null>(null);
    const [discoverSourceStatuses, setDiscoverSourceStatuses] = React.useState<
        readonly PluginMarketplaceDiscoverSourceStatus[]
    >([]);
    const [discoverDiagnostics, setDiscoverDiagnostics] = React.useState<
        readonly PluginMarketplaceDiscoverDiagnostic[]
    >([]);
    const [discoverNonInstallable, setDiscoverNonInstallable] = React.useState<
        readonly PluginMarketplaceNonInstallableListing[]
    >([]);
    const [discoverAuthorityKey, setDiscoverAuthorityKey] = React.useState<string | null>(null);
    const [loadingDiscover, setLoadingDiscover] = React.useState(false);
    const [loadingMoreDiscover, setLoadingMoreDiscover] = React.useState(false);
    const [discoverError, setDiscoverError] = React.useState<string | null>(null);
    const [hasLoadedDiscoverForScope, setHasLoadedDiscoverForScope] = React.useState<string | null>(null);
    const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
    const [pluginActionCountByAuthority, setPluginActionCountByAuthority] = React.useState<PluginActionCountsByAuthority>({});
    const [routineOperationSettlement, setRoutineOperationSettlement] = React.useState<PluginRoutineOperationSettlement | null>(null);
    const pluginActionCountByAuthorityRef = React.useRef<PluginActionCountsByAuthority>(
        pluginActionCountByAuthority,
    );

    const discoverRequestIdRef = React.useRef(0);

    React.useEffect(() => {
        setRoutineOperationSettlement(null);
    }, [selectedMachineScopeKey]);

    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionMachineId,
        serverId: executionServerId,
        enabled: executionTarget !== null,
        refreshKey: `${projectionRefreshKey}:${daemonCacheFreshnessKey}`,
    });

    const hasCapabilitySnapshot = (
        machineCapabilities.state.status === 'loaded'
        || machineCapabilities.state.status === 'loading'
        || machineCapabilities.state.status === 'error'
    ) && machineCapabilities.state.snapshot !== undefined;
    const currentInstalledPlugins = React.useMemo(
        () => readInstalledPlugins(machineCapabilities.state),
        [machineCapabilities.state],
    );
    const lastKnownInstalledPluginsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        installedPlugins: readonly InstalledPluginEntry[];
    }>>({ scopeKey: selectedMachineScopeKey, installedPlugins: currentInstalledPlugins });
    if (lastKnownInstalledPluginsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownInstalledPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            installedPlugins: hasCapabilitySnapshot ? currentInstalledPlugins : [],
        };
    } else if (hasCapabilitySnapshot) {
        lastKnownInstalledPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            installedPlugins: currentInstalledPlugins,
        };
    }
    const administeredInstalledPlugins = hasCapabilitySnapshot
        ? currentInstalledPlugins
        : lastKnownInstalledPluginsRef.current.installedPlugins;
    const installedPlugins = React.useMemo(() => projectAccountInstalledPlugins(administeredInstalledPlugins, accountInstalledAdmission), [accountInstalledAdmission, administeredInstalledPlugins]);
    const installedPluginById = React.useMemo(
        () => new Map(administeredInstalledPlugins.map((entry) => [entry.pluginId, entry] as const)),
        [administeredInstalledPlugins],
    );
    const installedPluginByIdRef = React.useRef(installedPluginById);
    installedPluginByIdRef.current = installedPluginById;
    /**
     * The exact machine and server a plugin change would land on. A plugin is
     * installed on ONE machine reached through ONE server, so a confirmation
     * that omits them describes a different action than the one it performs.
     * Naming stays with the Administration selection owner.
     */
    const selectedAdministrationTargetLabel = React.useMemo(() => (
        resolveMachineAdministrationTargetLabel({
            target: administrationTargetSelection.selectedTarget,
            candidates: administrationTargetSelection.candidates,
        })
    ), [administrationTargetSelection.candidates, administrationTargetSelection.selectedTarget]);
    const selectedAdministrationTargetLabelRef = React.useRef(selectedAdministrationTargetLabel);
    selectedAdministrationTargetLabelRef.current = selectedAdministrationTargetLabel;
    // An asynchronous decision names the EXACT target it routes to, which is
    // the resolved execution target rather than whatever is selected when the
    // daemon finally asks. The inventory still owns the naming.
    const administrationCandidatesRef = React.useRef(administrationTargetSelection.candidates);
    administrationCandidatesRef.current = administrationTargetSelection.candidates;
    const currentDevelopmentPlugins = React.useMemo(
        () => readDevelopmentPlugins(machineCapabilities.state, administeredInstalledPlugins),
        [administeredInstalledPlugins, machineCapabilities.state],
    );
    const lastKnownDevelopmentPluginsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        developmentPlugins: readonly DevelopmentPluginEntry[];
    }>>({ scopeKey: selectedMachineScopeKey, developmentPlugins: currentDevelopmentPlugins });
    if (lastKnownDevelopmentPluginsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownDevelopmentPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            developmentPlugins: hasCapabilitySnapshot ? currentDevelopmentPlugins : [],
        };
    } else if (hasCapabilitySnapshot) {
        lastKnownDevelopmentPluginsRef.current = {
            scopeKey: selectedMachineScopeKey,
            developmentPlugins: currentDevelopmentPlugins,
        };
    }
    const developmentPlugins = hasCapabilitySnapshot
        ? currentDevelopmentPlugins
        : lastKnownDevelopmentPluginsRef.current.developmentPlugins;
    /**
     * Deliberately not retained across machines like the installed list is: a
     * pending decision belongs to exactly one daemon lifetime, and offering a
     * stale one would invite the user to answer a change that no longer exists.
     */
    const pendingPluginChanges = React.useMemo(
        () => readPendingPluginChanges(machineCapabilities.state),
        [machineCapabilities.state],
    );
    const developmentCreateAvailable = readDevelopmentCreateAvailable(machineCapabilities.state);
    const developmentSourceInstallAvailable = readDevelopmentSourceInstallAvailable(machineCapabilities.state);
    const currentDaemonCapabilitiesState = executionMachineId && executionServerId
        ? getMachineCapabilitiesCacheState(
            executionMachineId,
            executionServerId,
            daemonCacheFreshnessKey,
        )
        : null;
    const daemonOperationAvailability = resolvePluginDaemonOperationsAvailability({
        hasExactExecutionTarget: executionTarget !== null,
        daemonTransportOnline,
        capabilityStateIsCurrent: currentDaemonCapabilitiesState === machineCapabilities.state,
        capabilityState: machineCapabilities.state,
        projectionPhase: daemonMergedProjection.phase,
    });
    const daemonAdministrationAvailable = daemonOperationAvailability.administration;
    const daemonOperationsAvailable = daemonOperationAvailability.projection;
    const mutationAuthorityKey = daemonOperationsAvailable && selectedMachineScopeKey
        ? `${selectedMachineScopeKey}:${daemonCacheFreshnessKey}`
        : null;
    const mutationAuthorityKeyRef = React.useRef(mutationAuthorityKey);
    mutationAuthorityKeyRef.current = mutationAuthorityKey;
    const installLifetime = React.useMemo(() => ({ controller: new AbortController() }), [mutationAuthorityKey]);
    React.useEffect(() => {
        if (installLifetime.controller.signal.aborted) installLifetime.controller = new AbortController();
        const controller = installLifetime.controller;
        return () => controller.abort();
    }, [installLifetime]);
    /**
     * The machine's configured marketplace sources, read through the one
     * registry owner this screen shares with the Sources & registries
     * administration screen. Discover only reads it; every write to it is
     * issued through the same owner — from that screen, or from the registry
     * selection an install owes, which binds the listing's source there.
     */
    const marketplaceSourceRegistryAdministration = usePluginRegistrySourceAdministration({
        scopeKey: selectedMachineScopeKey,
        enabled: discoverExecution.ready,
        focused: params.focused ?? true,
        executionTarget,
        resolveCurrentExecutionTarget,
    });
    const marketplaceSourceRegistry = marketplaceSourceRegistryAdministration.registry;
    const setMarketplaceSourceProfile = marketplaceSourceRegistryAdministration.setSourceRegistryProfile;
    const lastKnownProjectionInputsRef = React.useRef<Readonly<{
        scopeKey: string | null;
        inputs: typeof daemonMergedProjection.inputs;
    }>>({ scopeKey: selectedMachineScopeKey, inputs: daemonMergedProjection.inputs });
    if (lastKnownProjectionInputsRef.current.scopeKey !== selectedMachineScopeKey) {
        lastKnownProjectionInputsRef.current = { scopeKey: selectedMachineScopeKey, inputs: null };
    } else if (daemonMergedProjection.inputs) {
        lastKnownProjectionInputsRef.current = {
            scopeKey: selectedMachineScopeKey,
            inputs: daemonMergedProjection.inputs,
        };
    }
    const projectionInputs = daemonMergedProjection.inputs ?? lastKnownProjectionInputsRef.current.inputs;
    const pluginProjectionById = projectionInputs?.pluginProjectionById ?? {};
    // Account release selection may use an exact Account-hosted source while
    // offline. A daemon execution path, however, is valid only from the live
    // raw projection for this exact administration target.
    const pluginProjectionV2 = daemonOperationsAvailable
        ? daemonMergedProjection.inputs?.pluginProjectionV2 ?? null
        : null;
    const { pluginTruthSettled, targetResolving, installedPluginsRead: administeredInstalledPluginsRead } = resolvePluginTruthReadState({
        targetOnline: administrationTargetSelection.state.kind === 'online',
        hasExecutionTarget: executionTarget !== null,
        capabilitiesLoaded: machineCapabilities.state.status === 'loaded',
        daemonAdministrationAvailable,
        projectionPhase: daemonMergedProjection.phase,
    });
    const installedPluginsRead = accountInstalledAdmission?.kind === 'available'
        || (executionTarget !== null && administeredInstalledPluginsRead);
    const registryDiagnostics = projectionInputs?.registryDiagnostics ?? [];
    const currentDiagnostics = React.useMemo(() => [
        ...registryDiagnostics,
        ...Object.values(pluginProjectionById).flatMap((plugin) => plugin.diagnostics),
    ], [pluginProjectionById, registryDiagnostics]);
    const readOnlySnapshotNotice = resolvePluginReadOnlySnapshotNotice({
        daemonOperationsAvailable,
        daemonTransportOnline,
        projectionPhase: daemonMergedProjection.phase,
        hasCapabilitySnapshot,
        installedPluginCount: installedPlugins.length,
        developmentPluginCount: developmentPlugins.length,
        // Account registry reads are current independently of the selected daemon.
        hasCatalog: false,
        hasMarketplaceSourceRegistry: false,
        hasProjectionInputs: projectionInputs !== null,
        targetResolving,
        capabilityReadFailed: machineCapabilities.state.status === 'error'
            || machineCapabilities.state.status === 'not-supported'
            || (machineCapabilities.state.status === 'loaded'
                && currentDaemonCapabilitiesState === machineCapabilities.state
                && !daemonAdministrationAvailable),
    });
    /**
     * Re-reads daemon-owned plugin truth: the projection cache holds a failure
     * until something invalidates it, so both a completed mutation and the
     * projection-failure notice's retry go through this one owner.
     */
    const refreshPluginTruth = React.useCallback(() => {
        setProjectionRefreshKey((prev) => prev + 1);
        const currentTarget = resolveCurrentExecutionTarget(executionTarget);
        if (!currentTarget) return;
        if (readOnlySnapshotNotice?.reason === 'installationUnavailable') {
            machineCapabilities.refresh({ bypassCache: true });
        }
        publishMachineContributionRegistryProjectionInvalidation({
            machineId: currentTarget.machine.id,
            serverId: currentTarget.serverId,
        });
    }, [executionTarget, machineCapabilities.refresh, readOnlySnapshotNotice?.reason, resolveCurrentExecutionTarget]);
    /**
     * Reconciles one commit-intended mutation whose outcome the daemon could
     * not confirm, against the exact original target only.
     *
     * The refresh re-reads the ORIGINAL target the user acted on — never
     * another machine, so an ambiguous install cannot be answered by whatever
     * a different machine happens to have. When the refresh proves the change
     * landed the user gets the success answer; otherwise they get the truthful
     * unresolved copy naming the exact machine and server, never a false
     * failure and never an invitation to retry a change that may have
     * committed. `probe` is null when no caller-known installed identity
     * exists (a project-source trust), so the refresh itself is all the
     * reconciliation that can be offered.
     */
    const reconcileCommitIntendedMutation = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        settlementScope: PluginRoutineOperationSettlement['scope'];
        successMessage: string;
        actionLabel: string;
        name: string;
        probe: Readonly<{
            method: 'install' | 'update' | 'rollback' | 'uninstall' | 'forgetTrust' | 'disable';
            pluginId: string;
            before: InstalledPluginEntry | null;
            targetVersion: string | null;
        }> | null;
    }>): Promise<void> => {
        const showUnresolvedOutcome = () => {
            const label = resolveMachineAdministrationTargetLabel({
                target: params.target.target,
                candidates: administrationCandidatesRef.current,
            }) ?? { machine: params.target.machine.id, server: params.target.serverId };
            Modal.alert(
                t('settingsPlugins.pluginChangeOutcomeUnknownTitle'),
                t('settingsPlugins.pluginChangeOutcomeUnknownBody', {
                    action: params.actionLabel,
                    name: params.name,
                    machine: label.machine,
                    server: label.server,
                }),
            );
        };
        try {
            await prefetchMachineCapabilities({
                machineId: params.target.machine.id,
                serverId: params.target.serverId,
                cacheKeySalt: daemonCacheFreshnessKey,
                request: {
                    ...capabilityRequest,
                    bypassCache: true,
                },
            });
        } catch {
            if (params.isAuthorityCurrent()) {
                refreshPluginTruth();
                showUnresolvedOutcome();
            }
            return;
        }
        if (!params.isAuthorityCurrent()) return;

        const refreshedState = getMachineCapabilitiesCacheState(
            params.target.machine.id,
            params.target.serverId,
            daemonCacheFreshnessKey,
        );
        refreshPluginTruth();
        const probe = params.probe;
        if (refreshedState?.status !== 'loaded' || probe === null) {
            showUnresolvedOutcome();
            return;
        }
        const installedAfter = readInstalledPlugins(refreshedState)
            .find((entry) => entry.pluginId === probe.pluginId) ?? null;
        if (isPluginMutationVisibleAfterRefresh({
            method: probe.method,
            pluginId: probe.pluginId,
            before: probe.before,
            after: installedAfter,
            targetVersion: probe.targetVersion,
        })) {
            setRoutineOperationSettlement({
                scope: params.settlementScope,
                message: params.successMessage,
            });
        } else {
            showUnresolvedOutcome();
        }
    }, [capabilityRequest, daemonCacheFreshnessKey, refreshPluginTruth]);
    /** Source chips are the enabled Account union, including built-ins. */
    const discoverSources = React.useMemo(() => marketplaceSourceRegistryAdministration.sources
        .filter(source => source.enabled)
        .map(source => ({ id: source.id, title: source.title, kind: registryPluginSourceKind(source) })),
        [marketplaceSourceRegistryAdministration.sources]);
    const canRefreshInstalledPlugins = daemonOperationsAvailable;
    const canRunDiscoverActions = canRefreshInstalledPlugins && discoverAuthorityKey !== null
        && discoverAuthorityKey === discoverDataKey;
    const canRefreshDiscover = discoverExecution.ready && !loadingDiscover && !registryBrowse.loading && !loadingMoreDiscover;
    const discoverStale = registryBrowse.stale || acquiredDiscoverQuery !== null
        && (acquiredDiscoverQuery.text !== discoverSearchText.trim()
            || acquiredDiscoverQuery.sourceId !== selectedDiscoverSourceId);

    // Discovery is Account-owned and survives a selected install-machine change.
    React.useEffect(() => {
        discoverRequestIdRef.current += 1;
        setLoadingDiscover(false); setLoadingMoreDiscover(false);
        setDiscoverEntries([]); setDiscoverNextCursor(null); setDiscoverSourceStatuses([]);
        setDiscoverDiagnostics([]); setDiscoverNonInstallable([]); setAcquiredDiscoverQuery(null);
        setSelectedDiscoverSourceIdState(null); setDesiredDiscoverQuery(null);
        setDiscoverAuthorityKey(null); setDiscoverError(null); setHasLoadedDiscoverForScope(null);
    }, [discoverAccountKey]);

    const markPluginActionStarted = React.useCallback((authorityKey: string, pluginId: string) => {
        setRoutineOperationSettlement(null);
        const authorityCounts = pluginActionCountByAuthorityRef.current[authorityKey] ?? {};
        const next = {
            ...pluginActionCountByAuthorityRef.current,
            [authorityKey]: {
                ...authorityCounts,
                [pluginId]: (authorityCounts[pluginId] ?? 0) + 1,
            },
        };
        pluginActionCountByAuthorityRef.current = next;
        setPluginActionCountByAuthority(next);
    }, []);

    const markPluginActionFinished = React.useCallback((authorityKey: string, pluginId: string) => {
        const authorityCounts = pluginActionCountByAuthorityRef.current[authorityKey];
        if (!authorityCounts) return;
        const nextCount = (authorityCounts[pluginId] ?? 0) - 1;
        if (nextCount > 0) {
            const next = {
                ...pluginActionCountByAuthorityRef.current,
                [authorityKey]: {
                    ...authorityCounts,
                    [pluginId]: nextCount,
                },
            };
            pluginActionCountByAuthorityRef.current = next;
            setPluginActionCountByAuthority(next);
            return;
        }
        const nextAuthorityCounts = { ...authorityCounts };
        delete nextAuthorityCounts[pluginId];
        const nextCountsByAuthority = { ...pluginActionCountByAuthorityRef.current };
        if (Object.keys(nextAuthorityCounts).length === 0) {
            delete nextCountsByAuthority[authorityKey];
        } else {
            nextCountsByAuthority[authorityKey] = nextAuthorityCounts;
        }
        pluginActionCountByAuthorityRef.current = nextCountsByAuthority;
        setPluginActionCountByAuthority(nextCountsByAuthority);
    }, []);

    const isPluginActionInFlight = React.useCallback((pluginId: string) => {
        if (!mutationAuthorityKey) return false;
        return (pluginActionCountByAuthorityRef.current[mutationAuthorityKey]?.[pluginId] ?? 0) > 0;
    }, [mutationAuthorityKey, pluginActionCountByAuthority]);

    /**
     * Asks the present user the install-and-trust question and answers the
     * daemon with their decision.
     *
     * Every caller that reaches an install review — a marketplace install, a
     * local folder adopted from this screen, and a change some other client
     * prepared — goes through this one step, so the dialog a user sees and the
     * evidence the daemon receives cannot drift apart per entry point. Outcome
     * policy stays with the caller: only the caller knows what it was trying
     * to achieve.
     */
    const decidePluginInstallationReviewAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        installationReview: PendingPluginChangeReview;
    }>): Promise<MachinePluginInstallDecisionResult> => await reviewMachinePluginInstallationAsPresentUser(params.target.machine.id, {
        serverId: params.target.serverId,
        isAuthorityCurrent: params.isAuthorityCurrent,
        installationReview: params.installationReview,
        target: resolveMachineAdministrationTargetLabel({
            target: params.target.target, candidates: administrationCandidatesRef.current,
        }) ?? { machine: params.target.machine.id, server: params.target.serverId },
    }), []);

    /**
     * Asks the present user to trust a development project source.
     *
     * The locator is the entire security payload of this decision — the daemon
     * has not been allowed to read that folder yet, so there is no package
     * identity to show — and it is therefore echoed verbatim. A locator is a
     * location on ONE machine reached through ONE server, so it is named beside
     * the target the same Administration owner supplies to every other
     * machine-scoped confirmation on this screen.
     */
    const decidePluginProjectTrustAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        projectTrustReview: PendingPluginDevelopmentProjectTrustReview;
    }>): Promise<MachinePluginInstallDecisionResult> => await machinePluginInstallDecision(params.target.machine.id, {
        serverId: params.target.serverId,
        timeoutMs: null,
        isAuthorityCurrent: params.isAuthorityCurrent,
        decision: {
            pendingChangeId: params.projectTrustReview.pendingChangeId,
            decision: 'installAndTrust',
            confirmPresentUser: async () => await Modal.confirm(
                    t('settingsPlugins.developmentTrustProjectSourceTitle'),
                    t('settingsPlugins.developmentTrustProjectSourceBody', {
                        path: params.projectTrustReview.review.source.locator,
                        ...(resolveMachineAdministrationTargetLabel({
                            target: params.target.target,
                            candidates: administrationCandidatesRef.current,
                        }) ?? {
                            machine: params.target.machine.id,
                            server: params.target.serverId,
                        }),
                    }),
                    {
                        confirmText: t('settingsPlugins.developmentTrustProjectSourceConfirm'),
                        cancelText: t('common.cancel'),
                    },
                ) ? [] : null,
        },
    }), []);

    /** Answers one daemon review with one present-user decision. */
    const decidePendingPluginChangeAsPresentUser = React.useCallback(async (params: Readonly<{
        target: FreshMachineAdministrationExecutionTargetV1;
        isAuthorityCurrent: () => boolean;
        decision: PendingPluginChangeDecision;
        settlementScope: PluginRoutineOperationSettlement['scope'];
        successMessage: string;
        formatFailure: (outcome: string) => string;
    }>): Promise<void> => {
        let current = params.decision;
        while (true) {
            const response: MachinePluginInstallDecisionResult = current.kind === 'projectTrust'
                ? await decidePluginProjectTrustAsPresentUser({
                    target: params.target,
                    isAuthorityCurrent: params.isAuthorityCurrent,
                    projectTrustReview: current.projectTrustReview,
                })
                : await decidePluginInstallationReviewAsPresentUser({
                    target: params.target,
                    isAuthorityCurrent: params.isAuthorityCurrent,
                    installationReview: current.installationReview,
                });
            if (!params.isAuthorityCurrent()) return;
            if (!response.supported) {
                Modal.alert(
                    t('common.error'),
                    response.detail ?? (response.reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed')),
                );
                return;
            }
            const outcome: MachinePluginInstallDecisionOutcome = response.outcome;
            if (outcome.kind === 'cancelled') return;
            if (outcome.kind === 'committed' || outcome.kind === 'projectTrustAccepted') {
                setRoutineOperationSettlement({
                    scope: params.settlementScope,
                    message: params.successMessage,
                });
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
                return;
            }
            if (outcome.kind === 'reviewRequired') {
                const continuation = readPendingPluginChangeDecision(outcome.change);
                if (
                    current.kind === 'projectTrust'
                    && continuation?.kind === 'installation'
                    && continuation.installationReview.reason === 'authorityExpansion'
                    && continuation.installationReview.authorityExpansion.length > 0
                ) {
                    current = continuation;
                    continue;
                }
            }
            if (outcome.kind === 'outcomeUnknown') {
                // Approving is commit-intended: the daemon may have applied the
                // change after the decision left this device. Reconcile against
                // the exact original target instead of presenting a false failure.
                if (current.kind === 'installation') {
                    const review = current.installationReview.review;
                    const before = installedPluginByIdRef.current.get(review.pluginId) ?? null;
                    await reconcileCommitIntendedMutation({
                        target: params.target,
                        isAuthorityCurrent: params.isAuthorityCurrent,
                        settlementScope: params.settlementScope,
                        successMessage: params.successMessage,
                        actionLabel: t('settingsPlugins.installAndTrust'),
                        name: review.displayName,
                        probe: {
                            method: before === null ? 'install' : 'update',
                            pluginId: review.pluginId,
                            before,
                            targetVersion: review.version,
                        },
                    });
                } else {
                    // Project trust has no caller-known plugin identity yet, so
                    // refresh is the only available reconciliation.
                    await reconcileCommitIntendedMutation({
                        target: params.target,
                        isAuthorityCurrent: params.isAuthorityCurrent,
                        settlementScope: params.settlementScope,
                        successMessage: params.successMessage,
                        actionLabel: t('settingsPlugins.developmentTrustProjectSourceConfirm'),
                        name: current.projectTrustReview.review.source.locator,
                        probe: null,
                    });
                }
                return;
            }
            Modal.alert(
                t('common.error'),
                params.formatFailure(outcome.kind === 'reviewRequired' ? outcome.kind : outcome.detail ?? outcome.kind),
            );
            machineCapabilities.refresh({ bypassCache: true });
            refreshPluginTruth();
            return;
        }
    }, [
        decidePluginInstallationReviewAsPresentUser,
        decidePluginProjectTrustAsPresentUser,
        machineCapabilities,
        reconcileCommitIntendedMutation,
        refreshPluginTruth,
    ]);

    const runCatalogAction = React.useCallback((params: PluginMarketplaceActionRequest) => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return;
        }
        const installedBefore = installedPluginByIdRef.current.get(params.pluginId) ?? null;
        // Only an exact catalog install is answerable from a listing. An update is
        // answered by the installed record at its canonical owner, so the listing
        // never becomes that action's authority or its success target.
        const exactInstallEntry = params.method === 'install'
            ? discoverEntries.find((entry) => (
                entry.id === params.pluginId && entry.sourceId === params.sourceId
            )) ?? null
            : null;
        if (
            params.method === 'rollback'
            && installedBefore?.rollbackAvailability !== 'available'
        ) {
            return;
        }
        if (params.method === 'install') {
            if (
                discoverAuthorityKey !== discoverDataKey
                || exactInstallEntry?.installable !== true
                || !exactInstallEntry.version
                || installedBefore !== null
            ) {
                return;
            }
        }
        if (params.method === 'update' && installedBefore === null) {
            return;
        }
        if (
            params.method === 'setUpdatePolicy'
            && (
                installedBefore === null
                || params.policy === undefined
                || installedBefore.install.updatePolicy === params.policy
            )
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                const isAuthorityCurrent = () => (
                    accountCurrentness.isCurrent()
                    && mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
                const commitAction: CommitIntendedPluginChangeAction | null = params.method === 'install'
                    || params.method === 'update'
                    || params.method === 'rollback'
                    || params.method === 'uninstall'
                    || params.method === 'disable'
                    || params.method === 'forgetTrust'
                    ? params.method
                    : null;
                const showMutationFailure = (outcome: string) => {
                    if (!commitAction) return;
                    Modal.alert(
                        t('common.error'),
                        commitAction === 'install'
                            ? t('settingsPlugins.marketplaceInstallDecisionFailed', { outcome })
                            : t('settingsPlugins.marketplaceChangeDecisionFailed', {
                                action: resolvePluginChangeActionLabel(commitAction),
                                outcome,
                            }),
                    );
                };
                /**
                 * Reconciliation could not establish whether the change landed.
                 * That is not the same fact as "it failed": the daemon may have
                 * committed it. The shared reconciler re-reads only the exact
                 * original target and answers with success or the truthful
                 * unresolved copy — never a false failure, never an invitation
                 * to retry a change that may have committed.
                 */
                const reconcileAmbiguousMutation = async (targetVersion: string | null) => {
                    if (!commitAction) return;
                    await reconcileCommitIntendedMutation({
                        target: initialTarget,
                        isAuthorityCurrent,
                        settlementScope: params.method === 'install' ? 'discover' : 'installed',
                        successMessage: t('common.done'),
                        actionLabel: resolvePluginChangeActionLabel(commitAction),
                        name: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                        probe: {
                            method: commitAction,
                            pluginId: params.pluginId,
                            before: installedBefore,
                            targetVersion,
                        },
                    });
                };
                const requestChange = async (managedResourceDispositions?: readonly ManagedResourceDispositionV1[]) => {
                    if (params.method === 'install') {
                        if (!exactInstallEntry?.version) return { supported: true as const, response: {
                            ok: false as const, error: { code: 'install_unavailable', message: t('common.unavailable') },
                        } };
                        const execution = await discoverExecution.execute('plugins.install', {
                            machineId: initialTarget.machine.id,
                            source: { kind: 'marketplace', sourceId: exactInstallEntry.sourceId,
                                pluginId: exactInstallEntry.id, version: exactInstallEntry.version,
                                packageName: exactInstallEntry.packageName },
                        }, { signal: installLifetime.controller.signal });
                        if (!execution.ok) return { supported: true as const, response: {
                            ok: false as const, error: { code: execution.errorCode, message: execution.error },
                        } };
                        const result = execution.result;
                        const change = result && typeof result === 'object'
                            ? 'pendingReview' in result ? result.pendingReview
                                : 'change' in result ? result.change : null
                            : null;
                        return { supported: true as const, response: { ok: true as const,
                            result: { action: 'install', pluginId: params.pluginId, change },
                        } };
                    }
                    return await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: params.method,
                        params: {
                            pluginId: params.pluginId,
                            ...(params.sourceId ? { sourceId: params.sourceId } : {}),
                            ...(params.policy ? { policy: params.policy } : {}),
                            ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                            // The npm package name of the exact listing this
                            // action was raised from. It comes from the entry
                            // this hook already resolved and validated, never
                            // from the caller and never derived from the
                            // plugin id, which an npm package need not match.
                            ...(exactInstallEntry ? { packageName: exactInstallEntry.packageName } : {}),
                        },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        deferAmbiguousOutcomeToCaller: commitAction !== null,
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                    });
                };
                let response = await requestChange();
                if (!isAuthorityCurrent()) return;
                while ((params.method === 'disable' || params.method === 'uninstall')
                    && 'response' in response && response.response.ok) {
                    const resources = readPluginManagedResourceRemovalReview(response.response.result, params.method, params.pluginId);
                    if (!resources) break;
                    const dispositions = await reviewManagedResourceRemoval(resources);
                    if (!dispositions || !isAuthorityCurrent()) return;
                    // A renewed daemon census is a new consent question, never a replay of older acknowledgments.
                    response = await requestChange(dispositions);
                    if (!isAuthorityCurrent()) return;
                }
                // A registry selection the daemon names is answered by the
                // present user through the existing profile administration,
                // then the same change is requested again: the daemon either
                // prepares the Install and Trust review or names what is still
                // missing. Cancel ends the action with nothing fetched.
                while (
                    (params.method === 'install' || params.method === 'update')
                    && 'response' in response
                    && response.response.ok
                ) {
                    const registryRequirement = readPluginRegistryProfileRequirement(
                        response.response.result,
                        params.method,
                        params.pluginId,
                    );
                    if (!registryRequirement) break;
                    const proceed = await showPluginRegistryProfileSelectionDialog({
                        requirement: registryRequirement,
                        pluginName: installedBefore?.title ?? exactInstallEntry?.title ?? params.pluginId,
                        sourceId: params.sourceId ?? null,
                        target: resolveMachineAdministrationTargetLabel({
                            target: initialTarget.target,
                            candidates: administrationCandidatesRef.current,
                        }) ?? {
                            machine: initialTarget.machine.id,
                            server: initialTarget.serverId,
                        },
                        daemonOperationsAvailable: daemonAdministrationAvailable,
                        targetSelection: administrationTargetSelection,
                        sourceRegistry: {
                            scopeKey: selectedMachineScopeKey,
                            executionTarget: initialTarget,
                            resolveCurrentExecutionTarget,
                        },
                    });
                    // The selection may have rebound this machine's source; the
                    // screen's own registry read is refreshed either way.
                    marketplaceSourceRegistryAdministration.refresh();
                    if (!proceed || !isAuthorityCurrent()) return;
                    response = await requestChange();
                    if (!isAuthorityCurrent()) return;
                }

                if (!('response' in response)) {
                    if (commitAction && response.reason === 'error') {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                    }
                    return;
                }
                if (!response.response.ok) {
                    if (commitAction && response.response.error.code === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                    }
                    return;
                }

                const pendingReview = params.method === 'install' || params.method === 'update'
                    ? readPendingPluginChangeReview(response.response.result, params.method, params.pluginId)
                    : null;
                if (pendingReview) {
                    const decisionResponse = await decidePluginInstallationReviewAsPresentUser({
                        target: initialTarget,
                        isAuthorityCurrent,
                        installationReview: pendingReview,
                    });
                    if (!isAuthorityCurrent()) return;
                    if (!decisionResponse.supported) {
                        if (decisionResponse.reason === 'error') {
                            await reconcileAmbiguousMutation(pendingReview.review.version);
                        } else {
                            Modal.alert(t('common.error'), t('common.unavailable'));
                        }
                        return;
                    }
                    const outcome = decisionResponse.outcome;
                    if (outcome.kind === 'committed') {
                        setRoutineOperationSettlement({
                            scope: params.method === 'install' ? 'discover' : 'installed',
                            message: t('common.done'),
                        });
                        machineCapabilities.refresh({ bypassCache: true });
                        refreshPluginTruth();
                        return;
                    }
                    if (outcome.kind === 'cancelled') {
                        return;
                    }
                    if (outcome.kind === 'outcomeUnknown') {
                        await reconcileAmbiguousMutation(pendingReview.review.version);
                    } else {
                        showMutationFailure(outcome.detail ?? outcome.kind);
                    }
                    return;
                }

                if (commitAction) {
                    const changeKind = readPluginChangeKind(response.response.result, params.method, params.pluginId);
                    if (changeKind === 'cancelled') return;
                    const disabledNoop = params.method === 'disable'
                        && isPluginDisableNoopResult(response.response.result, params.pluginId);
                    if (changeKind !== 'committed' && !disabledNoop) {
                        if (changeKind === 'outcomeUnknown') {
                            await reconcileAmbiguousMutation(exactInstallEntry?.version ?? null);
                        } else {
                            showMutationFailure(changeKind ?? 'invalid-response');
                            if (changeKind === 'dataRemovalPartial') {
                                machineCapabilities.refresh({ bypassCache: true });
                                refreshPluginTruth();
                            }
                        }
                        return;
                    }
                    setRoutineOperationSettlement({
                        scope: params.method === 'install' ? 'discover' : 'installed',
                        message: t('common.done'),
                    });
                } else {
                    setRoutineOperationSettlement({
                        scope: params.method === 'install' ? 'discover' : 'installed',
                        message: t('common.done'),
                    });
                }
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [administrationTargetSelection, capabilityRequest, daemonAdministrationAvailable, decidePluginInstallationReviewAsPresentUser, discoverDataKey, discoverAuthorityKey, discoverEntries, discoverExecution.execute, executionTarget, installLifetime, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, marketplaceSourceRegistryAdministration.refresh, mutationAuthorityKey, reconcileCommitIntendedMutation, refreshPluginTruth, resolveCurrentExecutionTarget, selectedMachineScopeKey]);

    const runInstalledPluginAction = React.useCallback((
        action: InstalledPluginActionId,
        pluginId: string,
    ) => {
        const installed = installedPluginByIdRef.current.get(pluginId) ?? null;
        if (
            !installed
            || !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || isPluginActionInFlight(pluginId)
        ) {
            return;
        }
        const capabilities = projectInstalledPluginLifecycleCapabilities(installed);
        if (
            (action === 'enable' && !capabilities.canEnable)
            || (action === 'disable' && !capabilities.canDisable)
            || (action === 'update' && !capabilities.canUpdate)
            || (action === 'rollback' && !capabilities.canRollback)
            || (action === 'uninstall' && !capabilities.canUninstall)
            || (action === 'forgetTrust' && !capabilities.canForgetTrust)
        ) {
            return;
        }
        // Update is the same canonical daemon action wherever it is started
        // from, so it goes straight to its owner: the daemon either commits it
        // under the installed record's policy or hands back the install-and-trust
        // review this screen already knows how to present. A second local
        // confirmation before that review would ask the same question twice.
        if (action === 'enable' || action === 'disable' || action === 'update') {
            runCatalogAction({
                method: action,
                pluginId,
            });
            return;
        }
        const actionLabel = resolvePluginChangeActionLabel(action);
        const target = selectedAdministrationTargetLabelRef.current;
        if (!target) return;
        void (async () => {
            const confirmed = await Modal.confirm(
                actionLabel,
                t('settingsPlugins.pluginChangeConfirmBody', {
                    action: actionLabel,
                    name: installed.title,
                    machine: target.machine,
                    server: target.server,
                }),
                {
                    confirmText: actionLabel,
                    cancelText: t('common.cancel'),
                    // Uninstall and forgetting trust discard state this screen
                    // cannot restore; rollback moves between versions it can.
                    destructive: action === 'uninstall' || action === 'forgetTrust',
                },
            );
            if (!confirmed) return;
            runCatalogAction({
                method: action,
                pluginId,
            });
        })();
    }, [isPluginActionInFlight, mutationAuthorityKey, runCatalogAction]);

    const setInstalledPluginUpdatePolicy = React.useCallback((
        pluginId: string,
        policy: PluginUpdatePolicyV1,
    ) => {
        runCatalogAction({ method: 'setUpdatePolicy', pluginId, policy });
    }, [runCatalogAction]);

    const executeDevelopmentAction = React.useMemo(() => createFrontDoorActionExecute(), []);
    const invokeDevelopmentAction = React.useCallback(async (
        actionId: PluginDevLoopActionIdV1,
        input: unknown,
        target: FreshMachineAdministrationExecutionTargetV1,
        isAuthorityCurrent: () => boolean,
    ): Promise<boolean> => {
        if (!isAuthorityCurrent()) return false;
        try {
            const response = await executeDevelopmentAction(actionId, input, {
                surface: 'ui',
                serverId: target.serverId,
                executionRunTargetMachineId: target.machine.id,
            });
            if (!isAuthorityCurrent()) return false;
            if (!response.ok) {
                Modal.alert(t('common.error'), response.error);
                return false;
            }
            const result = response.result;
            if (result && typeof result === 'object' && 'ok' in result && result.ok === true
                && 'kind' in result && result.kind === actionId.replaceAll('.', '_')) return true;
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
                const messages = 'diagnostics' in result && Array.isArray(result.diagnostics)
                    ? result.diagnostics.flatMap((diagnostic: unknown) => (
                        diagnostic && typeof diagnostic === 'object' && 'message' in diagnostic
                            && typeof diagnostic.message === 'string' ? [diagnostic.message] : []
                    ))
                    : [];
                Modal.alert(t('common.error'), messages.join('\n') || t('common.requestFailed'));
            }
            // A queued approval belongs to the canonical Actions approval UI.
            // It is pending, not a completed development operation.
            return false;
        } catch (error) {
            if (isAuthorityCurrent()) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
            }
            return false;
        }
    }, [executeDevelopmentAction]);

    const runDevelopmentAction = React.useCallback((action: 'test' | 'pack' | 'unregister', pluginId: string) => {
        const development = developmentPlugins.find((entry) => entry.installed.pluginId === pluginId) ?? null;
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !development
            || development.actions[action] !== true
            || isPluginActionInFlight(pluginId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, pluginId);
            try {
                const succeeded = await invokeDevelopmentAction(
                    action === 'pack' ? 'plugins.pack' : action === 'test' ? 'plugins.dev.test' : 'plugins.dev.unregister',
                    action === 'pack' ? { locator: development.sourceRootPath } : { projectRoot: development.sourceRootPath },
                    initialTarget,
                    () => mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null,
                );
                if (succeeded) {
                    setRoutineOperationSettlement({
                        scope: 'development',
                        message: action === 'test'
                            ? t('settingsPlugins.developmentTestSucceeded')
                            : action === 'pack'
                                ? t('settingsPlugins.developmentPackSucceeded')
                                : t('common.done'),
                    });
                }
                if (
                    action === 'unregister'
                    && succeeded
                ) {
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                }
            } finally {
                markPluginActionFinished(mutationAuthorityKey, pluginId);
            }
        })();
    }, [developmentPlugins, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);

    const resolveDevelopmentEditTarget = React.useCallback((
        pluginId: string,
    ): Promise<DevelopmentEditTargetSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !developmentPlugins.some((entry) => entry.installed.pluginId === pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentEditTargetSettlement> => {
            const isAuthorityCurrent = () => (
                mutationAuthorityKeyRef.current === mutationAuthorityKey
                && resolveCurrentExecutionTarget(initialTarget) !== null
            );
            const response = await invokeWithAlerts({
                machineId: initialTarget.machine.id,
                serverId: initialTarget.serverId,
                request: {
                    id: MARKETPLACE_CAPABILITY_ID,
                    method: 'edit',
                    params: { pluginId },
                },
                isAuthorityCurrent,
                alerts: {
                    errorTitle: t('common.error'),
                    successTitle: t('common.success'),
                    unsupportedMessage: (reason) => reason === 'not-supported'
                        ? t('common.unavailable')
                        : t('common.requestFailed'),
                    successMessage: null,
                },
            });
            if (!isAuthorityCurrent()) {
                return { status: 'unavailable', reason: 'authorityChanged' };
            }
            if (!('response' in response) || !response.response.ok) {
                return { status: 'unavailable', reason: 'requestFailed' };
            }
            const target = readPluginEditTargetResult(response.response.result, pluginId);
            if (!target) {
                Modal.alert(t('common.error'), t('common.requestFailed'));
                return { status: 'unavailable', reason: 'invalidResult' };
            }
            return { status: 'success', target };
        })();
    }, [developmentPlugins, executionTarget, invokeWithAlerts, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    const runDevelopmentCreate = React.useCallback((params: Readonly<{
        targetDir: string;
        displayName: string;
        pluginId: string;
        ui?: PluginScaffoldUiMode;
    }>): Promise<DevelopmentCreateSettlement> => {
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !developmentCreateAvailable
            || !initialTarget
            || isPluginActionInFlight(params.pluginId)
        ) {
            return Promise.resolve({ status: 'unavailable', reason: 'operationUnavailable' });
        }

        return (async (): Promise<DevelopmentCreateSettlement> => {
            markPluginActionStarted(mutationAuthorityKey, params.pluginId);
            try {
                const isAuthorityCurrent = () => (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
                const response = await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'create',
                        params: {
                            targetDir: params.targetDir,
                            displayName: params.displayName,
                            pluginId: params.pluginId,
                            ...(params.ui ? { ui: params.ui } : {}),
                        },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (!isAuthorityCurrent()) {
                    return { status: 'unavailable', reason: 'authorityChanged' };
                }
                if (!('response' in response) || !response.response.ok) {
                    return { status: 'unavailable', reason: 'requestFailed' };
                }
                const created = readPluginCreateResult(response.response.result);
                // Only the daemon's returned source root seeds a follow-on
                // flow; an unparseable result never falls back to the folder
                // the prompt collected.
                if (!created) {
                    Modal.alert(t('common.error'), t('common.requestFailed'));
                    return { status: 'unavailable', reason: 'invalidResult' };
                }
                return { status: 'success', created };
            } finally {
                markPluginActionFinished(mutationAuthorityKey, params.pluginId);
            }
        })();
    }, [developmentCreateAvailable, executionTarget, invokeWithAlerts, isPluginActionInFlight, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, resolveCurrentExecutionTarget]);

    /** Adopts an explicit source through the same development Action used by the CLI and Agents. */
    const runDevelopmentSourceInstall = React.useCallback((sourceRootPath: string) => {
        const trimmedSourceRootPath = sourceRootPath.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !trimmedSourceRootPath
            || !developmentSourceInstallAvailable
            || isPluginActionInFlight(trimmedSourceRootPath)
        ) return;

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, trimmedSourceRootPath);
            try {
                const succeeded = await invokeDevelopmentAction(
                    'plugins.dev.submit',
                    { projectRoot: trimmedSourceRootPath },
                    initialTarget,
                    () => mutationAuthorityKeyRef.current === mutationAuthorityKey
                        && resolveCurrentExecutionTarget(initialTarget) !== null,
                );
                if (!succeeded) return;
                setRoutineOperationSettlement({
                    scope: 'development',
                    message: t('settingsPlugins.developmentSourceInstallSucceeded'),
                    detail: trimmedSourceRootPath,
                });
                machineCapabilities.refresh({ bypassCache: true });
                refreshPluginTruth();
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedSourceRootPath);
            }
        })();
    }, [developmentSourceInstallAvailable, executionTarget, invokeDevelopmentAction, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, refreshPluginTruth, resolveCurrentExecutionTarget]);
    /**
     * Answers a change the daemon is holding that this screen did not start.
     *
     * An Agent may prepare a plugin change, but approving one is not delegable:
     * project-source trust and any authority expansion are the present user's decisions. The
     * Agent's issued id therefore has to be findable and answerable here, or the
     * change it prepared simply expires unseen.
     *
     * The listing snapshot is a projection, so the change is re-read at its
     * owner first. That read — and not the stale row — decides what the user is
     * asked, and it is the only place the honest "still applying", "already
     * expired" and "the daemon that held it is gone" arms exist.
     */
    const decidePendingPluginChange = React.useCallback((
        pendingChangeId: string,
        decision: 'approve' | 'reject',
    ) => {
        const trimmedPendingChangeId = pendingChangeId.trim();
        const initialTarget = resolveCurrentExecutionTarget(executionTarget);
        if (
            !mutationAuthorityKey
            || mutationAuthorityKeyRef.current !== mutationAuthorityKey
            || !initialTarget
            || !trimmedPendingChangeId
            || isPluginActionInFlight(trimmedPendingChangeId)
        ) {
            return;
        }

        void (async () => {
            markPluginActionStarted(mutationAuthorityKey, trimmedPendingChangeId);
            try {
                const isAuthorityCurrent = () => (
                    mutationAuthorityKeyRef.current === mutationAuthorityKey
                    && resolveCurrentExecutionTarget(initialTarget) !== null
                );
                const reportOutcome = (message: string) => {
                    Modal.alert(t('common.error'), message);
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                };

                const response = await invokeWithAlerts({
                    machineId: initialTarget.machine.id,
                    serverId: initialTarget.serverId,
                    request: {
                        id: MARKETPLACE_CAPABILITY_ID,
                        method: 'changeStatus',
                        params: { pendingChangeId: trimmedPendingChangeId },
                    },
                    timeoutMs: null,
                    isAuthorityCurrent,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) => reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed'),
                        successMessage: null,
                    },
                });
                if (!isAuthorityCurrent() || !('response' in response) || !response.response.ok) return;

                const status = readPendingPluginChangeStatus(response.response.result);
                if (!status) {
                    reportOutcome(t('common.requestFailed'));
                    return;
                }
                if (status.kind === 'applying') {
                    setRoutineOperationSettlement({
                        scope: 'pending',
                        message: t('settingsPlugins.pendingChangeApplying'),
                    });
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }
                if (status.kind === 'expired') {
                    reportOutcome(t('settingsPlugins.pendingChangeExpired'));
                    return;
                }
                if (status.kind === 'daemonUnavailable') {
                    reportOutcome(t('common.unavailable'));
                    return;
                }
                if (status.kind === 'terminal') {
                    if (status.outcome === 'committed') {
                        // The change owner answered `committed` — possibly a
                        // decision another client already made. The applied
                        // state is the success answer; re-presenting it as a
                        // failure would be untrue.
                        setRoutineOperationSettlement({
                            scope: 'pending',
                            message: t('settingsPlugins.pendingChangeCommitted'),
                        });
                        machineCapabilities.refresh({ bypassCache: true });
                        refreshPluginTruth();
                        return;
                    }
                    if (status.outcome === 'outcomeUnknown') {
                        // The change is terminal but its outcome could not be
                        // confirmed. Reconcile the exact original target's own
                        // installed truth before anything is shown; an
                        // unproven landing stays the truthful unresolved copy,
                        // never a false "was not applied".
                        const probePluginId = status.pluginId;
                        await reconcileCommitIntendedMutation({
                            target: initialTarget,
                            isAuthorityCurrent,
                            settlementScope: 'pending',
                            successMessage: t('settingsPlugins.pendingChangeCommitted'),
                            actionLabel: t('settingsPlugins.installAndTrust'),
                            name: probePluginId ?? trimmedPendingChangeId,
                            probe: probePluginId === null ? null : {
                                method: installedPluginByIdRef.current.has(probePluginId) ? 'update' : 'install',
                                pluginId: probePluginId,
                                before: installedPluginByIdRef.current.get(probePluginId) ?? null,
                                targetVersion: null,
                            },
                        });
                        return;
                    }
                    reportOutcome(t('settingsPlugins.pendingChangeFailed', { outcome: status.outcome }));
                    return;
                }

                if (decision === 'reject') {
                    // A rejection is a consequential machine-scoped operation,
                    // so its confirmation names the exact server and machine
                    // the prepared change would be discarded on — the same
                    // Administration-owned facts every other confirmation on
                    // this screen carries.
                    const label = resolveMachineAdministrationTargetLabel({
                        target: initialTarget.target,
                        candidates: administrationCandidatesRef.current,
                    }) ?? { machine: initialTarget.machine.id, server: initialTarget.serverId };
                    const confirmed = await Modal.confirm(
                        t('approvals.reject'),
                        t('settingsPlugins.pendingChangeConfirmRejectBody', {
                            machine: label.machine,
                            server: label.server,
                        }),
                        { confirmText: t('approvals.reject'), cancelText: t('common.cancel'), destructive: true },
                    );
                    if (!confirmed || !isAuthorityCurrent()) return;
                    const rejection = await machinePluginInstallDecision(initialTarget.machine.id, {
                        serverId: initialTarget.serverId,
                        timeoutMs: null,
                        isAuthorityCurrent,
                        decision: {
                            pendingChangeId: readPendingPluginChangeDecisionId(status),
                            decision: 'cancel',
                        },
                    });
                    if (!isAuthorityCurrent()) return;
                    if (!rejection.supported) {
                        Modal.alert(
                            t('common.error'),
                            rejection.detail ?? (rejection.reason === 'not-supported' ? t('common.unavailable') : t('common.requestFailed')),
                        );
                        return;
                    }
                    if (rejection.outcome.kind === 'cancelled' || rejection.outcome.kind === 'expired') {
                        setRoutineOperationSettlement({
                            scope: 'pending',
                            message: t('settingsPlugins.pendingChangeRejected'),
                        });
                    } else {
                        Modal.alert(
                            t('common.error'),
                            t('settingsPlugins.pendingChangeFailed', {
                                outcome: rejection.outcome.detail ?? rejection.outcome.kind,
                            }),
                        );
                    }
                    machineCapabilities.refresh({ bypassCache: true });
                    refreshPluginTruth();
                    return;
                }

                await decidePendingPluginChangeAsPresentUser({
                    target: initialTarget,
                    isAuthorityCurrent,
                    decision: status,
                    settlementScope: 'pending',
                    successMessage: t('common.done'),
                    formatFailure: (outcome) => t('settingsPlugins.pendingChangeFailed', { outcome }),
                });
            } finally {
                markPluginActionFinished(mutationAuthorityKey, trimmedPendingChangeId);
            }
        })();
    }, [decidePendingPluginChangeAsPresentUser, executionTarget, invokeWithAlerts, isPluginActionInFlight, machineCapabilities, markPluginActionFinished, markPluginActionStarted, mutationAuthorityKey, reconcileCommitIntendedMutation, refreshPluginTruth, resolveCurrentExecutionTarget]);

    // Registry pages own source cursors and placement. This effect obtains the
    // published detail needed by the retained cards; install admission stays on
    // the currently selected machine's existing review pipeline.
    React.useEffect(() => {
        const requestId = ++discoverRequestIdRef.current;
        if (!desiredDiscoverQuery || !discoverAccountKey || !discoverExecution.ready
            || registryBrowse.loading || registryBrowse.stale) return;
        const query = desiredDiscoverQuery;
        setLoadingDiscover(true);
        void (async () => {
            try {
                if (registryBrowse.error) throw new Error(registryBrowse.error);
                const outcomes = await Promise.allSettled(registryBrowse.items.map(async summary => {
                    const result = await discoverExecution.execute('registries.items.read', {
                        kind: 'plugin', sourceId: summary.sourceId, itemId: summary.itemId,
                        ...(summary.version ? { version: summary.version } : {}),
                    });
                    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                    return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(result.result).item;
                }));
                if (requestId !== discoverRequestIdRef.current || !discoverExecution.isCurrent()) return;
                const items = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
                const readFailures: PluginMarketplaceDiscoverDiagnostic[] = outcomes.flatMap((outcome, index) => {
                    if (outcome.status === 'fulfilled') return [];
                    const summary = registryBrowse.items[index]!;
                    const source = marketplaceSourceRegistryAdministration.sources.find(source => source.id === summary.sourceId);
                    return [{ id: 'read:' + summary.sourceId + ':' + summary.itemId, sourceId: summary.sourceId,
                        sourceTitle: source?.title ?? null, code: 'registry_item_unavailable',
                        message: t('settingsPlugins.discover.diagnostic.recovery') }];
                });
                const page = projectRegistryMarketplacePage({ items, pages: registryBrowse.pages,
                    sources: marketplaceSourceRegistryAdministration.sources });
                setDiscoverDiagnostics([...page.diagnostics, ...readFailures]);
                setDiscoverSourceStatuses(page.sources);
                if (items.length === 0 && registryBrowse.items.length > 0) throw new Error('registry_item_unavailable');
                setDiscoverAuthorityKey(discoverDataKey);
                setDiscoverNextCursor(page.nextCursor);
                setAcquiredDiscoverQuery({ text: query.text.trim(), sourceId: query.sourceId });
                setDiscoverEntries(mergeDiscoverEntries([], query.pluginId
                    ? page.entries.filter(entry => entry.id === query.pluginId) : page.entries));
                setDiscoverNonInstallable(mergeDiscoverNonInstallableListings([], query.pluginId
                    ? page.nonInstallable.filter(entry => entry.pluginId === query.pluginId) : page.nonInstallable));
                setDiscoverError(null);
            } catch {
                if (requestId === discoverRequestIdRef.current && discoverExecution.isCurrent()) {
                    setDiscoverError(t('settingsPlugins.discover.diagnostic.recovery'));
                }
            } finally {
                if (requestId === discoverRequestIdRef.current && discoverExecution.isCurrent()) setLoadingDiscover(false);
            }
        })();
        return () => { discoverRequestIdRef.current += 1; };
    }, [desiredDiscoverQuery, discoverAccountKey, discoverDataKey, discoverExecution.execute, discoverExecution.isCurrent, discoverExecution.ready,
        registryBrowse.items, registryBrowse.pages, registryBrowse.loading, registryBrowse.stale, registryBrowse.error,
        marketplaceSourceRegistryAdministration.sources]);

    const requestDiscoverQuery = React.useCallback((query: DiscoverQueryIntent) => {
        setDiscoverNextCursor(null);
        setDesiredDiscoverQuery(query);
        if (desiredDiscoverQuery?.text === query.text && desiredDiscoverQuery.sourceId === query.sourceId
            && desiredDiscoverQuery.pluginId === query.pluginId) void registryBrowse.refresh();
    }, [desiredDiscoverQuery, registryBrowse.refresh]);
    const refreshDiscover = React.useCallback(() => {
        requestDiscoverQuery({ text: discoverSearchText, sourceId: selectedDiscoverSourceId });
    }, [discoverSearchText, selectedDiscoverSourceId, requestDiscoverQuery]);
    const setSelectedDiscoverSourceId = React.useCallback((sourceId: string | null) => {
        setSelectedDiscoverSourceIdState(sourceId);
        requestDiscoverQuery({ text: discoverSearchText, sourceId });
    }, [discoverSearchText, requestDiscoverQuery]);
    const clearDiscoverSearch = React.useCallback(() => {
        setDiscoverSearchText('');
        requestDiscoverQuery({ text: '', sourceId: selectedDiscoverSourceId });
    }, [requestDiscoverQuery, selectedDiscoverSourceId]);
    const openDiscoverListing = React.useCallback((listing: Readonly<{ sourceId: string; pluginId: string }>) => {
        setSelectedDiscoverSourceIdState(listing.sourceId);
        requestDiscoverQuery({ text: '', sourceId: listing.sourceId, pluginId: listing.pluginId });
    }, [requestDiscoverQuery]);
    const loadMoreDiscover = React.useCallback(() => {
        if (!registryBrowse.hasNextPage || registryBrowse.loading || loadingMoreDiscover) return;
        setLoadingMoreDiscover(true);
        void registryBrowse.nextPage().catch(() => {
            if (discoverExecution.isCurrent()) setDiscoverError(t('settingsPlugins.discover.diagnostic.recovery'));
        }).finally(() => { if (discoverExecution.isCurrent()) setLoadingMoreDiscover(false); });
    }, [registryBrowse.hasNextPage, registryBrowse.loading, registryBrowse.nextPage, loadingMoreDiscover, discoverExecution.isCurrent]);
    React.useEffect(() => {
        if (activeView !== 'discover' || !discoverExecution.ready || !discoverAccountKey) return;
        if (hasLoadedDiscoverForScope === discoverAccountKey) return;
        setHasLoadedDiscoverForScope(discoverAccountKey);
        refreshDiscover();
    }, [activeView, discoverExecution.ready, discoverAccountKey, hasLoadedDiscoverForScope, refreshDiscover]);

    return {
        activeView,
        administrationTargetSelection,
        administrationTargetLabel: selectedAdministrationTargetLabel,
        currentDiagnostics,
        accountServerIdentityId,
        selectedServerIdentityId,
        executionServerIdentityId,
        executionServerId,
        executionMachineId,
        executionMachineHomeDir,
        isDaemonSettingsTargetCurrent,
        discoverEntries: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverEntries : EMPTY_DISCOVER_VALUES,
        discoverNextCursor: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverNextCursor : null,
        discoverSources,
        discoverSourceStatuses: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverSourceStatuses : EMPTY_DISCOVER_VALUES,
        discoverDiagnostics: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverDiagnostics : EMPTY_DISCOVER_VALUES,
        discoverNonInstallable: discoverExecution.ready && discoverAuthorityKey === discoverDataKey ? discoverNonInstallable : EMPTY_DISCOVER_VALUES,
        discoverStale,
        selectedDiscoverSourceId,
        loadingMoreDiscover,
        discoverError,
        discoverSearchText,
        discoverResultsSearchText: acquiredDiscoverQuery?.text ?? null,
        clearDiscoverSearch,
        canRefreshDiscover,
        canRunDiscoverActions,
        canRefreshInstalledPlugins,
        daemonOperationsAvailable,
        daemonAdministrationAvailable,
        developmentCreateAvailable,
        developmentSourceInstallAvailable,
        developmentPlugins,
        installedPluginById,
        installedPlugins,
        pendingPluginChanges,
        routineOperationSettlement,
        decidePendingPluginChange,
        readOnlySnapshotNotice,
        refreshPluginTruth,
        isPluginActionInFlight,
        refreshDiscover,
        loadMoreDiscover,
        openDiscoverListing,
        loadingDiscover: loadingDiscover || registryBrowse.loading,
        marketplaceSourceRegistry,
        marketplaceSourceRegistryAvailable: marketplaceSourceRegistryAdministration.available,
        marketplaceSourceRegistryScopeKey: discoverAccountKey,
        marketplaceSourceRegistryLoading: marketplaceSourceRegistryAdministration.loading,
        marketplaceSourceRegistryLoadError: marketplaceSourceRegistryAdministration.loadError,
        marketplaceSourceRegistryMutationInFlight: marketplaceSourceRegistryAdministration.mutationInFlight,
        marketplaceSourceRegistryMutationOutcomeUnknown: marketplaceSourceRegistryAdministration.mutationOutcomeUnknown,
        pluginProjectionById,
        pluginProjectionV2,
        pluginTruthSettled,
        installedPluginsRead,
        registryDiagnostics,
        runCatalogAction,
        runDevelopmentCreate,
        resolveDevelopmentEditTarget,
        runDevelopmentSourceInstall,
        runDevelopmentAction,
        runInstalledPluginAction,
        setInstalledPluginUpdatePolicy,
        setActiveView,
        setDiscoverSearchText,
        setSelectedDiscoverSourceId,
        setMarketplaceSourceProfile,
        refreshMarketplaceSourceRegistry: marketplaceSourceRegistryAdministration.refresh,
        upsertMarketplaceSource: marketplaceSourceRegistryAdministration.upsertSource,
        setMarketplaceSourceEnabled: marketplaceSourceRegistryAdministration.setSourceEnabled,
        removeMarketplaceSource: marketplaceSourceRegistryAdministration.removeSource,
    };
}
