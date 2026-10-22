import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ShimmerView } from '@/components/ui/feedback/ShimmerView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Typography } from '@/constants/Typography';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import {
    MachineAdministrationTargetSelector,
    presentMachineAdministrationTargetState,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MachineScopedSection } from '@/components/settings/machines/MachineScopedSection';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { randomUUID } from '@/platform/randomUUID';
import { PROVIDER_CONNECTION_STATUS_KEY } from '@/providers/connection/presentation';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { useProviderConnections, type ProviderConnectionRefreshScope } from '@/providers/hooks/useProviderConnections';
import { useProviderCatalogCounts } from '@/providers/hooks/useProviderCatalogCounts';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { TeamCredentialCatalogSettingsGroup } from '@/components/settings/teams/credentials/TeamCredentialCatalogSettingsGroup';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import {
    ProviderFeatureAvailabilityNotice,
    useProviderFeatureAvailability,
} from './ProviderFeatureAvailability';
import { AddProviderMenu, newProviderRoute } from './collection/AddProviderMenu';
import { ProviderCollectionInvitation } from './collection/ProviderCollectionInvitation';
import { PROVIDERS_SETTINGS } from './providersSettings';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import {
    buildProviderCollection,
    providerConnectionDetailRoute,
    type ProviderCollectionConnectionRow,
    type ProviderCollectionFoundRow,
} from './collection/providerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
export const PROVIDERS_COLLECTION_ROUTE = '/settings/providers';
export const NEW_PROVIDER_ROUTE = '/settings/providers/new';

function candidatePort(candidate: ProviderDiscoveryCandidateV1): string {
    const endpoint = new URL(candidate.normalizedEndpointUrl);
    if (endpoint.port) return endpoint.port;
    return endpoint.protocol === 'https:' ? '443' : '80';
}

/** One status line; quiet about health unless something needs the user. */
function resolveConnectionRowSubtitle(row: ProviderCollectionConnectionRow): string {
    if (row.trouble || row.off) return t(PROVIDER_CONNECTION_STATUS_KEY[row.status]);
    // A gateway is set up where its subscriptions live; this list opens the same page.
    if (row.gateway) return t('settingsProvidersCollection.gateway.managedFromConnectedServices');
    const modelCount = row.catalogCount === null ? null : t('settingsProvidersCollection.modelsShown', row.catalogCount);
    // Healthy is quiet: what it is ("API key · 2 models"), never "Not checked" for an untested row.
    return [row.provenance, row.keySaved ? t('settingsProviders.authoring.apiKey') : null, modelCount].filter(Boolean).join(' · ');
}

/**
 * The Providers collection: the connections this Account has, augmented by
 * the local model servers found on a selected machine. `rail` is the narrow list beside a connection's
 * detail; `page` is the same list as the page where no rail shows. Selection comes from the route.
 */
export const ProviderConnectionsSettingsScreen = React.memo(function ProviderConnectionsSettingsScreen(props: Readonly<{
    variant?: 'rail' | 'page';
    active?: boolean;
    selectedConnectionId?: string | null;
}>) {
    const variant = props.variant ?? 'page';
    const rail = variant === 'rail';
    const active = props.active ?? true;
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { theme } = useUnistyles();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const providerTarget = useProviderSettingsTarget();
    const { machineId, machineRows, resolveCurrentTarget, accountServerId: serverId, accountAddressAvailable } = providerTarget;
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: serverId ?? undefined,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId,
        machineId,
        enabled: active && accountAddressAvailable && teamCredentialResourcesEnabled,
    });
    const { data, error, machineError, loading, refresh, declarationContext } = useProviderConnections({
        enabled: enabled && accountAddressAvailable, active, machineId, serverId,
    });
    const catalogCounts = useProviderCatalogCounts(serverId, declarationContext);
    const captureNavigationFocusReturn = useNavigationFocusReturn({
        ready: active && pathname === PROVIDERS_COLLECTION_ROUTE
            && (!enabled || (!loading && (data !== null || error !== null || machineId === null))),
    });
    // Beside a detail, opening another item replaces the shown detail instead of stacking history.
    const besideDetail = rail && pathname.startsWith(`${PROVIDERS_COLLECTION_ROUTE}/`);
    const navigate = React.useCallback((href: string) => {
        const result = runGuardedNavigation(() => captureNavigationFocusReturn(() => {
            if (besideDetail) router.replace(href as never);
            else router.push(href as never);
        }));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionsSettingsScreen.navigate' });
    }, [besideDetail, captureNavigationFocusReturn, router]);
    const refreshConnections = React.useCallback(async (scope?: ProviderConnectionRefreshScope): Promise<void> => {
        await refresh(scope);
    }, [refresh]);
    const mutation = useProviderConnectionMutation({ resolveTarget: resolveCurrentTarget, serverId,
        initiatingLifetime: accountAddressAvailable ? undefined : null, refresh: refreshConnections });
    const [searchQuery, setSearchQuery] = React.useState('');
    const [discoverySelectionError, setDiscoverySelectionError] = React.useState<ProviderErrorV1 | null>(null);
    const collection = React.useMemo(() => buildProviderCollection({
        data, query: searchQuery, localDiscoveryEnabled, catalogCounts, declarationContext,
    }), [catalogCounts, data, declarationContext, localDiscoveryEnabled, searchQuery]);
    const searchable = collection.total > SEARCH_THRESHOLD || searchQuery.trim().length > 0;
    const noMatches = collection.total > 0 && collection.connections.length === 0 && collection.found.length === 0;
    const machineLabel = machineId
        ? machineRows.find((row) => row.target.machineId === machineId)?.displayName ?? null
        : null;
    const foundTitle = machineLabel
        ? t('settingsProvidersCollection.onMachine', { machine: machineLabel })
        : t('settingsProvidersCollection.foundOnThisMachine');

    const connectDetectedCandidate = React.useCallback(async (candidate: ProviderDiscoveryCandidateV1) => {
        if (!machineId) return;
        setDiscoverySelectionError(null);
        const candidateId = candidate.candidateId;
        if (!candidateId) {
            setDiscoverySelectionError(createProviderErrorV1('provider_authorization_changed', {
                machineId,
                ...(candidate.connection.status === 'matched'
                    ? { connectionId: candidate.connection.connectionId }
                    : {}),
            }));
            return;
        }
        const openAuthoringDraft = (displayName: string | null) => {
            const params: Array<readonly [string, string]> = [
                ['candidateId', candidateId],
            ];
            if (displayName) params.push(['displayName', displayName]);
            const queryString = params
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&');
            navigate(`${newProviderRoute(candidate.contributionKey)}&${queryString}`);
        };
        if (candidate.connection.status === 'requires_named_connection') {
            openAuthoringDraft(t('settingsProviders.local.defaultConnectionName', { provider: candidate.providerName }));
            return;
        }
        const connectionId = candidate.connection.status === 'matched'
            ? candidate.connection.connectionId
            : `pc_${randomUUID()}`;
        const result = await mutation.run({
            action: 'enableDetected', machineId, connectionId,
            candidateId,
            displayName: null,
            savedSecretId: null,
        }, `detected:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`);
        if (result?.status === 'error' && result.error.code === 'provider_secret_missing') {
            if (candidate.connection.status === 'matched') {
                navigate(providerConnectionDetailRoute(candidate.connection.connectionId));
            } else {
                openAuthoringDraft(null);
            }
            mutation.clearError();
        }
    }, [machineId, mutation, navigate]);

    const startLocalInstallation = React.useCallback(async (installation: Readonly<{
        contributionKey: string;
    }>) => {
        if (!machineId) return;
        await mutation.run({
            action: 'startLocal',
            machineId,
            connectionId: `pc_${randomUUID()}`,
            contributionKey: installation.contributionKey,
        }, `start:${installation.contributionKey}`);
    }, [machineId, mutation]);

    const openTeamResource = React.useCallback((resource: Readonly<{ teamId: string; id: string }>) => {
        if (!serverId) return;
        const result = runGuardedNavigation(() => captureNavigationFocusReturn(() => {
            router.push(teamCredentialDetailPath({ serverId, teamId: resource.teamId }, resource.id) as never);
        }));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionsSettingsScreen.openTeamResource' });
    }, [captureNavigationFocusReturn, router, serverId]);

    const renderConnectionRow = (row: ProviderCollectionConnectionRow) => {
        const selected = row.connectionId === props.selectedConnectionId;
        return (
            <Item
                key={row.connectionId}
                testID={`settings-provider-connection:${row.connectionId}`}
                title={row.title}
                subtitle={resolveConnectionRowSubtitle(row)}
                subtitleLeading={row.trouble ? (
                    <View testID={`settings-provider-connection-trouble:${row.connectionId}`} style={collectionListStyles.troubleDot} />
                ) : undefined}
                icon={(
                    <HappierCollectionListMark dimmed={row.off}>
                        <ProviderIcon contributionKey={row.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                titleStyle={row.off ? collectionListStyles.dimmedTitle : undefined}
                selected={rail ? selected : undefined}
                accessibilityCurrent={rail && selected ? 'page' : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => navigate(row.detailRoute)}
            />
        );
    };

    const renderFoundRow = (row: ProviderCollectionFoundRow) => {
        const pending = mutation.isPending(row.pendingKey);
        if (row.kind === 'candidate') {
            const candidate = row.candidate;
            const evidenceLabel = candidate.evidence.kind === 'attributed_listener'
                ? t('settingsProviders.local.detectedAtPort', { port: candidatePort(candidate) })
                : t('settingsProviders.local.possibleAtPort', { provider: candidate.providerName, port: candidatePort(candidate) });
            return (
                <Item
                    key={row.key}
                    testID={`settings-provider-found:${row.key}`}
                    title={row.title}
                    subtitle={evidenceLabel}
                    icon={<HappierCollectionListMark><ProviderIcon contributionKey={candidate.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                    mode="info"
                    density={rail ? 'compact' : undefined}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    showChevron={false}
                    rightElement={pending ? <ActivitySpinner size="small" /> : (
                        <RoundButton
                            testID={`settings-provider-found-connect:${row.key}`}
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.connect')}
                            accessibilityLabel={`${t('settingsProvidersCollection.connect')}: ${candidate.providerName}, ${candidate.normalizedEndpointUrl}`}
                            onPress={() => { void connectDetectedCandidate(candidate); }}
                        />
                    )}
                    rightElementOutsidePressable
                />
            );
        }
        const installation = row.installation;
        return (
            <Item
                key={row.key}
                testID={`settings-provider-found:${row.key}`}
                title={row.title}
                subtitle={installation.status === 'app_running_server_off'
                    ? t('settingsProviders.local.appRunningServerOff')
                    : t('settingsProviders.local.installedNotRunning')}
                subtitleLeading={<View style={collectionListStyles.troubleDot} />}
                icon={<HappierCollectionListMark><ProviderIcon contributionKey={installation.contributionKey} icon={row.icon} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
                mode="info"
                density={rail ? 'compact' : undefined}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                showChevron={false}
                rightElement={installation.managedStartAvailable ? (
                    pending ? <ActivitySpinner size="small" /> : (
                        <RoundButton
                            testID={`settings-provider-found-start:${row.key}`}
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.start')}
                            accessibilityLabel={t('settingsProviders.local.startManaged', { provider: installation.providerName })}
                            onPress={() => { void startLocalInstallation(installation); }}
                        />
                    )
                ) : undefined}
                rightElementOutsidePressable={installation.managedStartAvailable}
            />
        );
    };

    const failure = error || mutation.error || discoverySelectionError ? (() => {
        const providerFailure = mutation.error
            ? { error: mutation.error, retry: mutation.retry, reviewCurrentState: refreshConnections }
            : error
                ? { error, retry: refreshConnections }
                : { error: discoverySelectionError };
        return (
            <ProviderErrorItems
                size={rail ? 'line' : undefined}
                error={providerFailure.error}
                retry={providerFailure.retry}
                reviewCurrentState={'reviewCurrentState' in providerFailure
                    ? providerFailure.reviewCurrentState
                    : undefined}
            />
        );
    })() : null;

    // A computer only adds what runs on it (local model servers); the list itself never waits for one.
    const notice = availabilityPresentation
        ? <ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} />
        : null;
    const localScopeShown = (localDiscoveryEnabled || Boolean(machineError)) && !availabilityPresentation;
    const machineState = providerTarget.selection.state;
    const firstLoad = !availabilityPresentation && loading && !data;
    const empty = !availabilityPresentation && data !== null && collection.total === 0;
    const draftOpen = pathname === NEW_PROVIDER_ROUTE;
    const addMenu = (
        <AddProviderMenu
            available={data?.available ?? []}
            disabled={Boolean(availabilityPresentation)}
            onAdd={navigate}
        />
    );
    const search = {
        testID: 'settings-providers-search',
        value: searchQuery,
        onChangeText: setSearchQuery,
        placeholder: t('settingsProviders.searchPlaceholder'),
    };

    if (rail) {
        return (
            <CollectionList
                testID="settings-providers-screen"
                title={t('settingsProviders.title')}
                count={data ? collection.total : null}
                headerAction={addMenu}
                search={searchable ? search : null}
            >
                {draftOpen ? <ProviderDraftRow /> : null}
                {/* No notice here: beside the rail, the detail pane says what is missing and leads to it. */}
                {firstLoad ? <ProviderRailSkeleton /> : null}
                {empty && !draftOpen ? <Item mode="info" title={t('settingsProviders.emptyTitle')} /> : null}
                {noMatches ? <Item mode="info" title={t('settingsProviders.searchEmptyTitle')} /> : null}
                {collection.connections.filter(row => !row.gateway).map(renderConnectionRow)}
                {collection.connections.some(row => row.gateway) ? (
                    <CollectionListGroupLabel
                        title={t('settingsProvidersCollection.gateway.railGroup')}
                        count={collection.connections.filter(row => row.gateway).length}
                        first={!draftOpen && collection.connections.every(row => row.gateway)}
                    />
                ) : null}
                {collection.connections.filter(row => row.gateway).map(renderConnectionRow)}
                {collection.found.length > 0 ? (
                    <CollectionListGroupLabel title={foundTitle} count={collection.found.length} first={collection.connections.length === 0} />
                ) : null}
                {collection.found.map(renderFoundRow)}
                {machineError ? <ProviderErrorItems size="line" error={machineError} retry={refreshConnections} /> : null}
                {localScopeShown && machineState.kind !== 'online' ? (
                    <ProviderRailLocalScope
                        selection={providerTarget.selection}
                        first={collection.connections.length === 0 && !draftOpen}
                    />
                ) : null}
                <TeamCredentialCatalogSettingsGroup
                    variant="rail"
                    title={t('teams.credentials.providedByTeams')}
                    sourceKind="provider"
                    catalog={teamCredentialCatalog}
                    onRetry={teamCredentialCatalog.reload}
                    onOpen={openTeamResource}
                />
                {failure}
            </CollectionList>
        );
    }

    const teamResources = (
        <TeamCredentialCatalogSettingsGroup
            title={t('teams.credentials.providedByTeams')}
            sourceKind="provider"
            catalog={teamCredentialCatalog}
            onRetry={teamCredentialCatalog.reload}
            onOpen={openTeamResource}
        />
    );

    // Nothing to list: the same invitation as beside the rail (lab PI1p), owning the page.
    if (empty) {
        return (
            <ItemList testID="settings-providers-screen" containerStyle={styles.centeredPane}>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections}
                    answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                    <ProviderCollectionInvitation available={data?.available ?? []} onAdd={navigate} />
                </SettingSection>
                {teamResources}
                {failure ? <ItemGroup>{failure}</ItemGroup> : null}
            </ItemList>
        );
    }

    return (
        <ItemList testID="settings-providers-screen">
            <SettingsPageHeader
                testID="settings-providers-header"
                description={t('settingsProvidersCollection.description')}
                actions={(
                    <View style={styles.headerActions}>
                        {/* Without a section that carries the machine scope, it stays reachable here. */}
                        {localScopeShown || machineState.kind !== 'online' ? null : (
                            <MachineAdministrationTargetSelector
                                selection={providerTarget.selection}
                                presentation="chip"
                                testIDPrefix="settings.providers.administration.target"
                            />
                        )}
                        {addMenu}
                    </View>
                )}
            />
            {searchable ? (
                <CompactSearchField
                    testID={search.testID}
                    value={search.value}
                    onChangeText={search.onChangeText}
                    placeholder={search.placeholder}
                    placement="page"
                />
            ) : null}
            <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections}
                answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
            {notice ? <ItemGroup>{notice}</ItemGroup> : null}
            {firstLoad ? <ItemGroup><ProviderRailSkeleton /></ItemGroup> : null}
            {noMatches ? <ItemGroup><Item mode="info" title={t('settingsProviders.searchEmptyTitle')} subtitle={t('settingsProviders.searchEmptyDescription')} /></ItemGroup> : null}
            {collection.connections.some(row => !row.gateway) ? (
                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.connections}>
                {/* The page header already says what the list is (lab PI2p): the list follows it untitled. */}
                <ItemGroup>
                    {collection.connections.filter(row => !row.gateway).map(renderConnectionRow)}
                </ItemGroup>
                </SettingAnchor>
            ) : null}
            {/* Gateways keep their own titled group, as in the rail (lab PI2p). */}
            {collection.connections.some(row => row.gateway) ? (
                <ItemGroup title={t('settingsProvidersCollection.gateway.railGroup')}>
                    {collection.connections.filter(row => row.gateway).map(renderConnectionRow)}
                </ItemGroup>
            ) : null}
            </SettingSection>
            {!localScopeShown && !availabilityPresentation && machineState.kind !== 'online' ? (
                // Only runtime augmentation needs a computer; Account catalog controls remain above.
                <MachineScopedSection
                    title={t('settingsProvidersCollection.onThisComputerTitle')}
                    selection={providerTarget.selection}
                    unselectedInvitation={t('settingsProviders.noMachineDescription')}
                    testIDPrefix="settings.providers.administration.target"
                >
                    {null}
                </MachineScopedSection>
            ) : null}
            {localScopeShown ? (
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.local}>
                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.local}>
                <MachineScopedSection
                    title={presentLocalScopeTitle(machineState)}
                    description={machineState.kind === 'online' && collection.found.length > 0
                        ? t('settingsProviders.local.footer')
                        : undefined}
                    selection={providerTarget.selection}
                    unselectedInvitation={t('settingsProvidersCollection.localNoComputer')}
                    offlineDetail={t('settingsProvidersCollection.localOfflineDetail')}
                    testIDPrefix="settings.providers.administration.target"
                >
                    {machineError ? <ProviderErrorItems error={machineError} retry={refreshConnections} />
                        : collection.found.length > 0 ? collection.found.map(renderFoundRow) : (
                        <EmptyState
                            testID="settings-providers-local-none"
                            layout="line"
                            title={t('settingsProvidersCollection.localNoneFound')}
                        />
                    )}
                </MachineScopedSection>
                </SettingAnchor>
                </SettingSection>
            ) : null}
            {teamResources}
            {failure ? <ItemGroup>{failure}</ItemGroup> : null}
        </ItemList>
    );
});

/** "On MacBook Pro" for the chosen computer, whatever its state; "On a computer" before one is chosen. */
function presentLocalScopeTitle(state: ReturnType<typeof useProviderSettingsTarget>['selection']['state']): string {
    return state.kind === 'unselected'
        ? t('settingsProvidersCollection.onAComputerTitle')
        : t('settingsProvidersCollection.onMachine', { machine: presentMachineAdministrationTargetState(state).title });
}

/**
 * The rail's local-servers group when no online machine can be asked: what a machine is needed
 * for, or that the chosen one is offline. It is a summary only: the rail always sits beside a
 * detail whose "On this machine" section carries the one machine control for this page (both
 * read and write the same Providers target selection).
 */
const ProviderRailLocalScope = React.memo(function ProviderRailLocalScope(props: Readonly<{
    selection: ReturnType<typeof useProviderSettingsTarget>['selection'];
    first: boolean;
}>) {
    const state = props.selection.state;
    const sentence = state.kind === 'unselected'
        ? t('settingsProvidersCollection.localNoComputer')
        : state.kind === 'offline'
            ? `${t('settingsMachines.scopeOffline', { machine: presentMachineAdministrationTargetState(state).title })} ${t('settingsProvidersCollection.localOfflineDetail')}`
            : [presentMachineAdministrationTargetState(state).title, presentMachineAdministrationTargetState(state).detail].filter(Boolean).join(' · ');
    return (
        <>
            <CollectionListGroupLabel title={presentLocalScopeTitle(state)} first={props.first} />
            <Item
                testID="settings-providers-local-scope"
                mode="info"
                title={sentence}
                titleStyle={styles.railScopeText}
                titleLines={0}
                density="compact"
                pressableStyle={collectionListStyles.row}
                showChevron={false}
            />
        </>
    );
});

/** The provider being added in the detail pane, at the top of the rail, titled as it is typed. */
const ProviderDraftRow = React.memo(function ProviderDraftRow() {
    const providerDraftTitle = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings-providers-draft"
            titles={providerDraftTitle}
            placeholder={t('settingsProvidersCollection.newTitle')}
            mark={<HappierCollectionListMark><ProviderIcon icon={null} size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
        />
    );
});

/** First load: rows the size of the real ones, so nothing moves when they arrive. */
function ProviderRailSkeleton() {
    return (
        <View testID="settings-providers-skeleton" style={styles.skeleton}>
            {[0, 1, 2].map((index) => (
                <ShimmerView key={index} style={styles.skeletonRow}>
                    <View style={styles.skeletonFill} />
                </ShimmerView>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    centeredPane: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    railScopeText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    skeleton: {
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s6,
    },
    skeletonRow: {
        borderRadius: 8,
    },
    skeletonFill: {
        height: 44,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.elevated,
    },
}));
