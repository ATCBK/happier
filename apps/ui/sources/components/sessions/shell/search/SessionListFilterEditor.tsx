import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    SelectionList,
    type SelectionListPagination,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { SelectionListBackChip } from '@/components/ui/selectionList/SelectionListBackChip';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { getTeamGroupsSnapshot } from '@/sync/store/teams/teamsSnapshots';
import { teamGroupsQueryKeyV1 } from '@happier-dev/protocol/teams';

import {
    buildSessionListFilterEditorModel,
    readSessionListAudienceTeamStepAddress,
    SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID,
    resolveSessionListFilterEditorSelectionChange,
    resolveSessionListFilterScopeAvailability,
    type SessionListFilterAudienceOption,
    type SessionListFilterEditorLabels,
    type SessionListFilterHomeOption,
    type SessionListFilterTagOption,
} from './sessionListFilterEditorModel';
import {
    buildQualifiedAudienceSelectionKey,
    type SessionListFilterDeletedSelections,
    type SessionListViewContext,
    type SessionListViewFilters,
} from './sessionListViewFilters';
import {
    SessionListFilterPanel,
    type SessionListFilterDrillSection,
    type SessionListFilterPanelCopy,
} from './SessionListFilterPanel';
/*
 * Audience identity belongs to the filter state owner. This component consumes its
 * qualified JSON key rather than maintaining a parallel Team-only syntax.
 */
function teamAudienceIdentity(serverId: string, teamId: string): string {
    return buildQualifiedAudienceSelectionKey({ serverId, kind: 'team', teamId });
}

export type SessionListFilterEditorCopy = SessionListFilterEditorLabels & Omit<SessionListFilterPanelCopy, keyof SessionListFilterEditorLabels> & Readonly<{
    title: string;
    /** The Archived destination's label; shown only when the host passes `onOpenArchived`. */
    archived?: string;
    catalogLoading?: string;
    catalogMore?: string;
    catalogRetry?: string;
    catalogError?: string;
    catalogPartial?: string;
    catalogEnd?: string;
}>;

export type SessionListFilterEditorProps = Readonly<{
    filters: SessionListViewFilters;
    includeInactive: boolean;
    inactiveVisibilityAvailable?: boolean;
    queryEnabled: boolean;
    followingAvailable: boolean;
    sourceAvailable: boolean;
    homes: readonly SessionListFilterHomeOption[];
    audiences: readonly SessionListFilterAudienceOption[];
    tags: readonly SessionListFilterTagOption[];
    /** Enables the canonical Teams directory and lazy per-Team Group producer. */
    teamAudienceContext?: SessionListViewContext;
    labels: SessionListFilterEditorCopy;
    fixedHomeServerIds?: ReadonlySet<string>;
    fixedAudienceKeys?: ReadonlySet<string>;
    /** Fixed destination semantics, for the Workflows Runs sidebar. */
    fixedShow?: SessionListViewFilters['show'];
    updateFilters(filters: SessionListViewFilters): void;
    removeAuthoritativelyDeletedSelections(deleted: SessionListFilterDeletedSelections): void;
    setIncludeInactive(includeInactive: boolean): void;
    /** Source is a persisted device preference, so it is written through its own owner. */
    setSource(source: SessionListViewFilters['source']): void;
    resetFilters(): void;
    /** Opens the archived list from the scope menu. Omitted on the archived corpus itself. */
    onOpenArchived?: () => void;
    /** Sessions the list currently shows for these choices, from the list's own derivation. */
    resultCount?: number;
    /** Worded result for a host whose result is a live preview rather than the list's count. */
    resultSummary?: string;
    onDone?: () => void;
    doneDisabled?: boolean;
    maxHeight?: number;
    disableTransitions?: boolean;
}>;

/** Everything the drill view needs above its list: the way back to the panel. */
const DRILL_HEADER_HEIGHT = 44;

const stylesheet = StyleSheet.create({
    root: {
        minWidth: 280,
        flexShrink: 1,
    },
    drillHeader: {
        minHeight: DRILL_HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
    },
});

export const SessionListFilterEditor = React.memo(function SessionListFilterEditor(
    props: SessionListFilterEditorProps,
) {
    const styles = stylesheet;
    const audienceServerIds = React.useMemo(
        () => props.homes.map((home) => home.serverId),
        [props.homes],
    );
    const teamAudienceEnabled = props.queryEnabled && props.teamAudienceContext !== undefined;
    const directory = useTeamsDirectory({
        enabled: teamAudienceEnabled,
        serverIds: audienceServerIds,
        scope: 'member',
        archived: 'active',
    });
    const audienceContextKey = props.teamAudienceContext?.kind === 'team'
        ? `team:${props.teamAudienceContext.team.serverId}:${props.teamAudienceContext.team.teamId}`
        : props.teamAudienceContext?.kind ?? 'none';
    const [drilledTeamState, setDrilledTeamState] = React.useState<Readonly<{
        contextKey: string;
        address: TeamAddress;
    }> | null>(null);
    const drilledTeam = drilledTeamState?.contextKey === audienceContextKey
        ? drilledTeamState.address
        : null;
    const selectedGroupTeam = React.useMemo<TeamAddress | null>(() => {
        const selected = props.filters.audiences.find((audience) => (
            audience.kind === 'group' && audienceServerIds.includes(audience.serverId)
        ));
        return selected?.kind === 'group'
            ? { serverId: selected.serverId, teamId: selected.teamId }
            : null;
    }, [audienceServerIds, props.filters.audiences]);
    const activeTeam = React.useMemo<TeamAddress | null>(() => {
        const context = props.teamAudienceContext;
        if (!context) return null;
        if (context.kind === 'team') return context.team;
        if (drilledTeam && audienceServerIds.includes(drilledTeam.serverId)) return drilledTeam;
        // A retained Group filter still needs its canonical Group catalog checked
        // even before the editor drills into that Team. This reuses the editor's
        // one incumbent Group observer and does not create another filter-lifetime
        // subscription or catalog.
        return selectedGroupTeam;
    }, [audienceServerIds, drilledTeam, props.teamAudienceContext, selectedGroupTeam]);
    const activeTeamScope = activeTeam
        ? directory.scopes.find((scope) => scope.serverId === activeTeam.serverId) ?? null
        : null;
    const groups = useTeamGroups({
        scope: activeTeamScope,
        address: activeTeam,
        archived: 'active',
        enabled: teamAudienceEnabled && activeTeam !== null,
    });
    const directoryComplete = teamAudienceEnabled
        && directory.kind !== 'loading'
        && !directory.partial
        && !directory.hasMore;
    const activeGroupsComplete = teamAudienceEnabled
        && activeTeam !== null
        && groups.status === 'ready'
        && groups.isCurrent
        && !groups.hasMore;

    const audiences = React.useMemo<readonly SessionListFilterAudienceOption[]>(() => {
        const context = props.teamAudienceContext;
        if (!context) return props.audiences;

        const homeLabels = new Map(props.homes.map((home) => [home.serverId, home.label]));
        const qualifyTeamLabel = (name: string, serverId: string) => props.homes.length <= 1
            ? name
            : `${name} · ${homeLabels.get(serverId) ?? serverId}`;
        const options: SessionListFilterAudienceOption[] = [...props.audiences];
        const rows = context.kind === 'team'
            ? directory.rows.filter((row) => (
                row.address.serverId === context.team.serverId
                && row.address.teamId === context.team.teamId
            ))
            : directory.rows;
        for (const row of rows) {
            options.push({
                serverId: row.address.serverId,
                kind: 'team',
                teamId: row.address.teamId,
                label: qualifyTeamLabel(row.team.name, row.address.serverId),
            });
        }
        const representedTeams = new Set(options.flatMap((option) => option.kind === 'team'
            ? [teamAudienceIdentity(option.serverId, option.teamId)]
            : []));
        if (context.kind === 'global' && !directoryComplete) {
            // These rows reify retained filter IDs only. They never claim to be
            // directory results and disappear once the current directory can
            // authoritatively prove that the Team no longer exists.
            for (const selected of props.filters.audiences) {
                if (selected.kind === 'outside_teams' || !audienceServerIds.includes(selected.serverId)) continue;
                const key = teamAudienceIdentity(selected.serverId, selected.teamId);
                if (representedTeams.has(key)) continue;
                representedTeams.add(key);
                options.push({
                    serverId: selected.serverId,
                    kind: 'team',
                    teamId: selected.teamId,
                    label: qualifyTeamLabel(selected.teamId, selected.serverId),
                });
            }
        }
        if (context.kind === 'team' && rows.length === 0) {
            options.push({
                serverId: context.team.serverId,
                kind: 'team',
                teamId: context.team.teamId,
                label: context.team.teamId,
            });
        }
        if (activeTeam) {
            for (const group of groups.rows) {
                options.push({
                    serverId: activeTeam.serverId,
                    kind: 'group',
                    teamId: activeTeam.teamId,
                    groupId: group.id,
                    label: group.name,
                });
            }
            if (!activeGroupsComplete) {
                const representedGroups = new Set(groups.rows.map((group) => group.id));
                for (const selected of props.filters.audiences) {
                    if (selected.kind !== 'group'
                        || selected.serverId !== activeTeam.serverId
                        || selected.teamId !== activeTeam.teamId
                        || representedGroups.has(selected.groupId)) continue;
                    representedGroups.add(selected.groupId);
                    options.push({
                        serverId: activeTeam.serverId,
                        kind: 'group',
                        teamId: activeTeam.teamId,
                        groupId: selected.groupId,
                        label: selected.groupId,
                    });
                }
            }
        }
        return options;
    }, [
        activeGroupsComplete,
        activeTeam,
        audienceServerIds,
        directory.rows,
        directoryComplete,
        groups.rows,
        props.audiences,
        props.filters.audiences,
        props.homes,
        props.teamAudienceContext,
    ]);

    // A complete current owner answer is the only evidence that can remove a
    // retained ID. Partial, stale, offline and still-paginating reads keep the
    // selection intact, matching the filter-state lifetime contract.
    React.useEffect(() => {
        const context = props.teamAudienceContext;
        if (!context) return;
        const currentTeams = directoryComplete
            ? new Set(directory.rows.map((row) => teamAudienceIdentity(row.address.serverId, row.address.teamId)))
            : null;
        const currentGroups = activeGroupsComplete && activeTeam
            ? new Set(groups.rows.map((group) => group.id))
            : null;
        const deletedAudiences = props.filters.audiences.filter((audience) => {
            if (audience.kind === 'outside_teams') return false;
            if (currentTeams && context.kind === 'global'
                && !currentTeams.has(teamAudienceIdentity(audience.serverId, audience.teamId))) return true;
            if (audience.kind === 'group') {
                const address = { serverId: audience.serverId, teamId: audience.teamId };
                const scope = directory.scopes.find((candidate) => candidate.serverId === audience.serverId) ?? null;
                const snapshot = getTeamGroupsSnapshot(
                    scope,
                    address,
                    teamGroupsQueryKeyV1({ v: 1, teamId: audience.teamId, archived: 'active' }),
                );
                if (
                    snapshot?.status === 'ready'
                    && !snapshot.stale
                    && snapshot.nextCursor === null
                    && snapshot.data !== null
                    && !snapshot.data.some((group) => group.id === audience.groupId)
                ) return true;
            }
            return audience.kind === 'group' && currentGroups !== null && activeTeam !== null
                && audience.serverId === activeTeam.serverId
                && audience.teamId === activeTeam.teamId
                && !currentGroups.has(audience.groupId);
        });
        if (deletedAudiences.length > 0) {
            props.removeAuthoritativelyDeletedSelections({ deletedAudiences });
        }
    }, [
        activeGroupsComplete,
        activeTeam,
        directory.rows,
        directory.scopes,
        directoryComplete,
        groups.rows,
        props.filters,
        props.removeAuthoritativelyDeletedSelections,
        props.teamAudienceContext,
    ]);
    const model = React.useMemo(() => buildSessionListFilterEditorModel({
        filters: props.filters,
        includeInactive: props.includeInactive,
        inactiveVisibilityAvailable: props.inactiveVisibilityAvailable,
        attentionAvailable: props.queryEnabled,
        labels: props.labels,
        scopesAvailable: resolveSessionListFilterScopeAvailability(props),
        homes: props.homes,
        audiences,
        audiencePresentation: props.teamAudienceContext?.kind === 'global' ? 'team_drilldown' : 'flat',
        tags: props.tags,
        sourceAvailable: props.sourceAvailable,
        fixedHomeServerIds: props.fixedHomeServerIds,
        fixedAudienceKeys: props.fixedAudienceKeys,
        fixedShow: props.fixedShow,
        archivedLabel: props.onOpenArchived ? props.labels.archived : undefined,
    }), [
        audiences,
        props.filters,
        props.fixedAudienceKeys,
        props.fixedHomeServerIds,
        props.fixedShow,
        props.followingAvailable,
        props.homes,
        props.includeInactive,
        props.inactiveVisibilityAvailable,
        props.labels,
        props.queryEnabled,
        props.sourceAvailable,
        props.tags,
        props.teamAudienceContext,
        props.onOpenArchived,
    ]);
    const handleActiveStepChange = React.useCallback((step: SelectionListStep) => {
        if (props.teamAudienceContext?.kind !== 'global') return;
        const address = readSessionListAudienceTeamStepAddress(step.id);
        setDrilledTeamState(address ? {
            contextKey: audienceContextKey,
            address: { serverId: address.serverId, teamId: address.teamId },
        } : null);
    }, [audienceContextKey, props.teamAudienceContext]);
    const syncedAudienceStep = React.useMemo(() => {
        if (props.teamAudienceContext?.kind !== 'global' || !drilledTeam) return null;
        for (const section of model.rootStep.sections) {
            if (section.kind !== 'static') continue;
            for (const option of section.options) {
                const address = option.openStep
                    ? readSessionListAudienceTeamStepAddress(option.openStep.id)
                    : null;
                if (address?.serverId === drilledTeam.serverId && address.teamId === drilledTeam.teamId) {
                    return option.openStep ?? null;
                }
            }
        }
        return null;
    }, [drilledTeam, model.rootStep.sections, props.teamAudienceContext]);
    const handleSelect = React.useCallback((optionId: string) => {
        if (optionId === SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID) {
            props.onOpenArchived?.();
            return;
        }
        if (props.inactiveVisibilityAvailable === false && optionId.startsWith('inactive:')) return;
        if (!props.queryEnabled && optionId.startsWith('attention:')) return;
        if (props.fixedShow && optionId.startsWith('show:')) return;
        const next = resolveSessionListFilterEditorSelectionChange(
            props.filters,
            props.includeInactive,
            optionId,
            { fixedAudienceKeys: props.fixedAudienceKeys },
        );
        // Source has a persisted owner; every other facet is this surface's retained
        // view state. One option id only ever moves one facet, so the write goes to
        // exactly one writer.
        if (next.filters.source !== props.filters.source) {
            props.setSource(next.filters.source);
        } else if (next.filters !== props.filters) {
            props.updateFilters(next.filters);
        }
        if (next.includeInactive !== props.includeInactive) {
            props.setIncludeInactive(next.includeInactive);
        }
    }, [props]);
    const pagination = React.useMemo<SelectionListPagination | undefined>(() => {
        if (!teamAudienceEnabled) return undefined;
        const loadingLabel = props.labels.catalogLoading ?? props.labels.noOptions;
        const moreLabel = props.labels.catalogMore ?? props.labels.noOptions;
        const retryLabel = props.labels.catalogRetry ?? props.labels.noOptions;
        const endReachedLabel = props.labels.catalogEnd ?? props.labels.noOptions;
        const showGroups = activeTeam !== null && activeTeamScope !== null && (
            props.teamAudienceContext?.kind === 'team' || drilledTeam !== null
        );
        if (showGroups) {
            const retryable = groups.error?.retryable === true;
            return {
                hasMore: groups.hasMore,
                loadingMore: groups.status === 'loading'
                    || groups.status === 'loading_more'
                    || (groups.status === 'ready' && !groups.isCurrent && groups.error === null),
                requestKey: JSON.stringify([
                    activeTeam.serverId,
                    activeTeam.teamId,
                    groups.rows.map((row) => row.id),
                    groups.hasMore,
                ]),
                error: groups.status === 'error'
                    ? (props.labels.catalogError ?? props.labels.noOptions)
                    : null,
                onEndReached: () => { void groups.loadMore(); },
                ...(retryable ? { onRetry: () => { void groups.reload(); } } : {}),
                loadingLabel,
                moreLabel,
                retryLabel,
                endReachedLabel: groups.rows.length === 0 ? props.labels.noOptions : endReachedLabel,
            };
        }
        const unavailable = directory.unavailableHomes.filter((home) => home.reason !== 'loading');
        const retryable = directory.stale || unavailable.some((home) => home.retryable);
        return {
            hasMore: directory.hasMore,
            loadingMore: directory.unavailableHomes.some((home) => home.reason === 'loading')
                || (directory.kind === 'loading' && unavailable.length === 0),
            requestKey: JSON.stringify([
                directory.rows.map((row) => [row.address.serverId, row.address.teamId]),
                directory.hasMore,
            ]),
            error: unavailable.length > 0 || directory.stale
                ? (directory.rows.length > 0
                    ? props.labels.catalogPartial ?? props.labels.catalogError ?? props.labels.noOptions
                    : props.labels.catalogError ?? props.labels.noOptions)
                : null,
            onEndReached: directory.loadMore,
            ...(retryable ? { onRetry: directory.refresh } : {}),
            loadingLabel,
            moreLabel,
            retryLabel,
            endReachedLabel: directory.rows.length === 0 ? props.labels.noOptions : endReachedLabel,
        };
    }, [
        activeTeam,
        activeTeamScope,
        directory,
        drilledTeam,
        groups,
        props.labels,
        props.teamAudienceContext,
        teamAudienceEnabled,
    ]);

    const [drill, setDrill] = React.useState<SessionListFilterDrillSection | null>(null);
    const closeDrill = React.useCallback(() => setDrill(null), []);
    // The drill view lists one facet of the SAME model step (same step id, same option ids), so the
    // SelectionList's search, pagination and Team drill-down behave exactly as they always have.
    const drillStep = React.useMemo<SelectionListStep | null>(() => {
        if (!drill) return null;
        const section = model.rootStep.sections.find((candidate) => candidate.id === drill)
            // While the Teams directory is still answering there are no audience rows yet; the list
            // opens empty and its pagination footer says it is loading.
            ?? (drill === 'audiences' && teamAudienceEnabled
                ? { kind: 'static' as const, id: 'audiences', title: props.labels.sharedWith, options: [] }
                : null);
        if (!section) return null;
        return { ...model.rootStep, sections: [section] };
    }, [drill, model.rootStep, props.labels.sharedWith, teamAudienceEnabled]);

    return (
        <View testID="session-list-filter-editor-surface" style={styles.root}>
            {drillStep ? (
                <>
                    <View style={styles.drillHeader}>
                        <SelectionListBackChip
                            testID="session-list-filter-drill-back"
                            label={props.labels.title}
                            onPress={closeDrill}
                        />
                    </View>
                    <SelectionList
                        rootStep={drillStep}
                        selection={model.selection}
                        syncActiveStep={drill === 'audiences' && props.teamAudienceContext?.kind === 'global'
                            ? syncedAudienceStep
                            : undefined}
                        onActiveStepChange={handleActiveStepChange}
                        listAccessibilityLabel={drill === 'tags' ? props.labels.tags : props.labels.sharedWith}
                        onSelect={handleSelect}
                        pagination={drill === 'audiences' ? pagination : undefined}
                        onRequestClose={closeDrill}
                        autoFocusInputOnWeb
                        autoFocusInputOnNative={false}
                        maxHeight={props.maxHeight === undefined
                            ? undefined
                            : Math.max(0, props.maxHeight - DRILL_HEADER_HEIGHT)}
                        heightBehavior="content"
                        showsVerticalScrollIndicator
                        disableTransitions={props.disableTransitions}
                        testID="session-list-filter-editor"
                    />
                </>
            ) : (
                <SessionListFilterPanel
                    rootStep={model.rootStep}
                    selectedIds={model.selection.selectedIds}
                    labels={props.labels}
                    resultCount={props.resultCount}
                    resultSummary={props.resultSummary}
                    maxHeight={props.maxHeight}
                    onSelect={handleSelect}
                    onOpenDrill={setDrill}
                    audiencesAvailable={teamAudienceEnabled}
                    onReset={props.resetFilters}
                    onDone={props.onDone}
                    doneDisabled={props.doneDisabled}
                />
            )}
        </View>
    );
});
