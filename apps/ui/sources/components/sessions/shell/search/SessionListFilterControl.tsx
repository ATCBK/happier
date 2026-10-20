import * as React from 'react';
import type { SessionListScopeV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import type { SelectionListFilter } from '@/components/ui/selectionList';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';

import {
    buildSessionListFilterTagOptions,
    qualifySessionListFilterOptionLabel,
} from './sessionListFilterTagOptions';
import { SessionListFilterEditorControl } from './SessionListFilterEditorControl';
import type { SessionListFilterEditorProps } from './SessionListFilterEditor';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';
import { registerSessionListScopeActionOwner } from '@/sync/ops/actions/scopeActionFamily';

/** The collapsed control's name for a scope ("My work"). Shared with any surface that edits a Sessions filter. */
export function readSessionListScopeLabel(scope: SessionListScopeV1): string {
    switch (scope) {
        case 'my_work': return t('sessionsList.filtersMyWork');
        case 'assigned_to_me': return t('sessionsList.filtersAssignedToMe');
        case 'following': return t('sessionsList.filtersFollowing');
        case 'involving_me': return t('sessionsList.filtersInvolvingMe');
        case 'all_accessible': return t('sessionsList.filtersAllAccessible');
    }
}

/** Outside-Teams audience options, one per Home, for a global (not Team) view. */
export function buildSessionListFilterAudienceOptions(
    homeOptions: SessionListViewFilterController['homeOptions'],
    viewContext: SessionListViewFilterController['viewContext'],
): SessionListFilterEditorProps['audiences'] {
    if (viewContext.kind !== 'global') return [];
    const outsideTeamsLabel = t('sessionsList.filtersOutsideTeams');
    return homeOptions.map((home) => ({
        serverId: home.serverId,
        kind: 'outside_teams' as const,
        label: qualifySessionListFilterOptionLabel({ label: outsideTeamsLabel, serverId: home.serverId, homeOptions }),
    }));
}

/** The editor's copy: one set for every surface that edits a Sessions filter. */
export function buildSessionListFilterEditorLabels(): SessionListFilterEditorProps['labels'] {
    return {
        title: t('sessionsList.filtersTitle'),
        search: t('sessionsList.filtersSearch'),
        show: t('sessionsList.filtersShow'),
        scope: t('sessionsList.filtersScope'),
        sessions: t('sessionsList.filtersShowSessions'),
        runs: t('sessionsList.filtersShowRuns'),
        both: t('sessionsList.filtersShowBoth'),
        startedBy: t('sessionsList.filtersStartedBy'),
        startedByYou: t('sessionsList.filtersStartedByYou'),
        startedByTriggers: t('sessionsList.filtersStartedByTriggers'),
        startedByAgents: t('sessionsList.filtersStartedByAgents'),
        runsNeedingYouAlwaysShow: t('sessionsList.filtersRunsNeedingYouAlwaysShow'),
        myWork: t('sessionsList.filtersMyWork'),
        assignedToMe: t('sessionsList.filtersAssignedToMe'),
        following: t('sessionsList.filtersFollowing'),
        involvingMe: t('sessionsList.filtersInvolvingMe'),
        allAccessible: t('sessionsList.filtersAllAccessible'),
        attention: t('sessionsList.filtersAttention'),
        anyAttention: t('sessionsList.filtersAttentionAny'),
        needsMyAttention: t('sessionsList.filtersAttentionNeedsMe'),
        needsMeOnly: t('sessionsList.filtersNeedsMeOnly'),
        needsMeOnlyDescription: t('sessionsList.filtersNeedsMeOnlyDescription'),
        inactiveSessions: t('sessionsList.filtersInactive'),
        showInactive: t('sessionsList.filtersInactiveShow'),
        hideInactive: t('sessionsList.filtersInactiveHide'),
        homes: t('sessionsList.filtersHomes'),
        sharedWith: t('sessionsList.filtersSharedWith'),
        outsideTeams: t('sessionsList.filtersOutsideTeams'),
        tags: t('sessionsList.filtersTags'),
        source: t('sessionsList.filtersSource'),
        allSources: t('sessionsList.filtersSourceAll'),
        persistedSource: t('sessionsList.filtersSourceHappier'),
        directSource: t('sessionsList.filtersSourceDirect'),
        noOptions: t('sessionsList.filtersNoOptions'),
        onlyCoordinators: t('sessionsList.filtersOnlyCoordinators'),
        onlyCoordinatorsDescription: t('sessionsList.filtersOnlyCoordinatorsDescription'),
        clear: t('common.reset'),
        done: t('sessionsList.filtersDone'),
        catalogLoading: t('common.loading'),
        catalogMore: t('common.more'),
        catalogRetry: t('common.retry'),
        catalogError: t('common.error'),
        catalogPartial: t('common.unavailable'),
        catalogEnd: t('session.access.allLoaded'),
        archived: t('sessionsList.filtersArchived'),
        moreTags: (count: number) => t('sessionsList.filtersMoreTags', { count }),
        resultCount: (count: number) => t('sessionsList.filtersResultCount', { count }),
    };
}

/** Quiet summary of the two work-kind facets, shared by the Sessions and Runs headers. */
export function readSessionListWorkFilterSummary(
    controller: Pick<SessionListViewFilterController, 'filters' | 'defaultFilters' | 'fixedShow'>,
): string | null {
    const { filters, defaultFilters } = controller;
    const startersMatch = filters.startedBy.length === defaultFilters.startedBy.length
        && filters.startedBy.every((starter) => defaultFilters.startedBy.includes(starter));
    if (controller.fixedShow !== 'runs' && filters.show === (controller.fixedShow ?? defaultFilters.show) && startersMatch) return null;
    const labels = buildSessionListFilterEditorLabels();
    const showLabel = filters.show === 'sessions'
        ? labels.sessions
        : filters.show === 'runs' ? labels.runs : t('sessionsList.filtersShowBothSummary');
    if (filters.show === 'sessions') return showLabel;
    const starterLabels = [
        ['you', labels.startedByYou],
        ['triggers', labels.startedByTriggers],
        ['agents', labels.startedByAgents],
    ] as const;
    const selectedStarters = starterLabels
        .filter(([starter]) => filters.startedBy.includes(starter))
        .map(([, label]) => label);
    return `${showLabel} · ${selectedStarters.length > 0 ? selectedStarters.join(', ') : t('sessionsList.filtersStartedByNone')}`;
}

/**
 * Facets that narrow the list without a word in the title ("Only coordinators"): each is a chip beneath the
 * title that names it, and pressing it turns just that facet off.
 */
export function buildSessionListActiveFilterChips(
    controller: Pick<SessionListViewFilterController, 'filters' | 'updateFilters'>,
    icon: React.ReactNode,
): readonly SelectionListFilter[] {
    if (controller.filters.coordinator !== 'coordinator') return [];
    return [{
        id: 'coordinator',
        testID: 'session-list-filter-chip-coordinator',
        label: t('sessionsList.filtersOnlyCoordinators'),
        valueLabel: t('sessionsList.filtersCoordinatorsChip'),
        icon,
        onClear: () => controller.updateFilters(({ coordinator: _coordinator, ...rest }) => rest),
        clearAccessibilityLabel: t('sessionsList.filtersCoordinatorsChipClear'),
    }];
}

export const SessionListFilterControl = React.memo(function SessionListFilterControl(props: Readonly<{
    controller: SessionListViewFilterController;
    organizationProjectionsByServerId: Readonly<Record<string, SessionOrganizationProjection>>;
    /** Opens the archived list; the active corpus passes it so Archived sits in the scope menu. */
    onOpenArchived?: () => void;
    /** Sessions the list shows for the current choices, counted from the list's own rows. */
    resultCount?: number;
}>) {
    const { controller } = props;
    const controllerRef = React.useRef(controller);
    React.useLayoutEffect(() => { controllerRef.current = controller; });
    React.useEffect(() => registerSessionListScopeActionOwner(() => controllerRef.current),
        [controller.corpusStorage, controller.viewContextKey, controller.retentionScopeKey]);
    const audienceOptions = React.useMemo(
        () => buildSessionListFilterAudienceOptions(controller.homeOptions, controller.viewContext),
        [controller.homeOptions, controller.viewContext],
    );
    const tagOptions = React.useMemo(() => buildSessionListFilterTagOptions({
        homeOptions: controller.homeOptions,
        organizationProjectionsByServerId: props.organizationProjectionsByServerId,
    }), [controller.homeOptions, props.organizationProjectionsByServerId]);
    const allMountedHomesSelected = React.useMemo(() => {
        const selected = new Set(controller.filters.homeServerIds);
        return selected.size === controller.homeOptions.length
            && controller.homeOptions.every((home) => selected.has(home.serverId));
    }, [controller.filters.homeServerIds, controller.homeOptions]);
    // The trigger's label already names the scope, so "narrowed" means a facet beyond it.
    const active = controller.filters.attention !== 'any'
        || controller.filters.show !== (controller.fixedShow ?? controller.defaultFilters.show)
        || controller.filters.startedBy.length !== controller.defaultFilters.startedBy.length
        || controller.filters.startedBy.some((starter) => !controller.defaultFilters.startedBy.includes(starter))
        || !controller.includeInactive
        || !allMountedHomesSelected
        || controller.filters.audiences.length > 0
        || controller.filters.tagIds.length > 0
        || controller.filters.source !== 'all';
    const labels = buildSessionListFilterEditorLabels();

    // A Team is named for people, not addressed by them. The immutable id shows
    // only while the Home has not answered with the Team's real name yet.
    const semanticScopeLabel = readSessionListScopeLabel(controller.filters.scope);
    const corpusLabel = controller.corpusPresentation === 'legacy_owner_or_direct'
        ? t('sessionsList.filtersLegacyOwnerDirect')
        : semanticScopeLabel;
    const scopedLabel = controller.viewContext.kind === 'team'
        ? `${corpusLabel} · ${
            controller.viewContext.teamDisplayName?.trim() || controller.viewContext.team.teamId
        }`
        : corpusLabel;
    // The attention facet narrows the corpus as much as the scope does, so the
    // collapsed control has to say it is on rather than leaving the list looking
    // inexplicably short. Short form here; the editor keeps the full sentence.
    const controlLabel = controller.filters.attention === 'needs_my_attention'
        ? `${scopedLabel} · ${t('sessionsList.filtersScopeNeedsMe')}`
        : scopedLabel;

    return (
        <SessionListFilterEditorControl
            label={controller.fixedShow === 'runs' ? readSessionListWorkFilterSummary(controller) ?? labels.runs : controlLabel}
            presentation={controller.fixedShow === 'runs' ? 'summary' : 'title'}
            active={active}
            editor={{
                filters: controller.filters,
                includeInactive: controller.includeInactive,
                inactiveVisibilityAvailable: controller.corpusStorage === 'active',
                queryEnabled: controller.queryEnabled,
                followingAvailable: controller.followingAvailable,
                sourceAvailable: controller.sourceAvailable,
                homes: controller.homeOptions,
                audiences: audienceOptions,
                teamAudienceContext: controller.viewContext,
                tags: tagOptions,
                labels,
                fixedHomeServerIds: controller.fixedHomeServerIds,
                fixedAudienceKeys: controller.fixedAudienceKeys,
                fixedShow: controller.fixedShow,
                updateFilters: controller.updateFilters,
                removeAuthoritativelyDeletedSelections: controller.removeAuthoritativelyDeletedSelections,
                setIncludeInactive: controller.setIncludeInactive,
                setSource: controller.setSource,
                resetFilters: controller.resetFilters,
                onOpenArchived: props.onOpenArchived,
                resultCount: props.resultCount,
            }}
        />
    );
});
