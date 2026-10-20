import type { SessionListScopeV1 } from '@happier-dev/protocol';
import type {
    SelectionListOption,
    SelectionListSelection,
    SelectionListStep,
} from '@/components/ui/selectionList';

import {
    buildQualifiedAudienceSelectionKey,
    buildQualifiedTagAddressKey,
    normalizeSessionListViewFilters,
    removeHomeFromSessionListViewFilters,
    type QualifiedAudienceSelection,
    type QualifiedTagAddress,
    type SessionListViewFilters,
} from './sessionListViewFilters';

export type SessionListFilterEditorLabels = Readonly<{
    search: string;
    show: string;
    scope: string;
    sessions: string;
    runs: string;
    both: string;
    startedBy: string;
    startedByYou: string;
    startedByTriggers: string;
    startedByAgents: string;
    myWork: string;
    assignedToMe: string;
    following: string;
    involvingMe: string;
    allAccessible: string;
    attention: string;
    anyAttention: string;
    needsMyAttention: string;
    inactiveSessions: string;
    showInactive: string;
    hideInactive: string;
    homes: string;
    sharedWith: string;
    outsideTeams: string;
    tags: string;
    source: string;
    allSources: string;
    persistedSource: string;
    directSource: string;
    noOptions: string;
    onlyCoordinators: string;
    onlyCoordinatorsDescription: string;
}>;

export type SessionListFilterHomeOption = Readonly<{
    serverId: string;
    label: string;
    disabled?: boolean;
}>;

export type SessionListFilterAudienceOption = QualifiedAudienceSelection & Readonly<{
    label: string;
    disabled?: boolean;
}>;

export type SessionListFilterAudiencePresentation = 'flat' | 'team_drilldown';

export type SessionListFilterTagOption = QualifiedTagAddress & Readonly<{
    label: string;
    disabled?: boolean;
}>;

export type SessionListFilterEditorModel = Readonly<{
    rootStep: SelectionListStep;
    selection: Extract<SelectionListSelection, { kind: 'multiple' }>;
}>;

const SCOPES: readonly SessionListScopeV1[] = [
    'my_work',
    'assigned_to_me',
    'following',
    'involving_me',
    'all_accessible',
];

/** Scope availability shared by the panel and its client Actions. */
export function resolveSessionListFilterScopeAvailability(input: Readonly<{
    queryEnabled: boolean;
    followingAvailable: boolean;
}>): Readonly<Record<SessionListScopeV1, boolean>> {
    return {
        my_work: input.queryEnabled,
        assigned_to_me: input.queryEnabled,
        following: input.queryEnabled && input.followingAvailable,
        involving_me: input.queryEnabled,
        all_accessible: input.queryEnabled,
    };
}

function encodeId(prefix: 'audience' | 'tag', key: string): string {
    return `${prefix}:${key}`;
}

/**
 * The option id one qualified tag selection is toggled by.
 *
 * The editor and the compact shortcut mint it from the same qualified address and
 * both hand it back to `reduceSessionListFilterEditorSelection`, so there is one
 * tag writer and no host can invent an identity from a display label.
 */
export function buildSessionListFilterTagOptionId(tag: QualifiedTagAddress): string {
    return encodeId('tag', buildQualifiedTagAddressKey(tag));
}

function audienceSelectionOption(
    audience: SessionListFilterAudienceOption,
    fixedAudienceKeys: ReadonlySet<string> | undefined,
): SelectionListOption {
    const key = buildQualifiedAudienceSelectionKey(audience);
    return {
        id: encodeId('audience', key),
        label: audience.label,
        disabled: audience.disabled === true || fixedAudienceKeys?.has(key) === true,
    };
}

function audienceTeamStepId(audience: Extract<QualifiedAudienceSelection, { kind: 'team' }>): string {
    return `session-list-audience-team:${buildQualifiedAudienceSelectionKey(audience)}`;
}

export function readSessionListAudienceTeamStepAddress(
    stepId: string,
): Extract<QualifiedAudienceSelection, { kind: 'team' }> | null {
    const prefix = 'session-list-audience-team:';
    if (!stepId.startsWith(prefix)) return null;
    const parts = parseQualifiedKey(stepId.slice(prefix.length));
    if (!parts || parts.length !== 3 || parts[1] !== 'team') return null;
    return { serverId: parts[0]!, kind: 'team', teamId: parts[2]! };
}

function scopeLabel(scope: SessionListScopeV1, labels: SessionListFilterEditorLabels): string {
    switch (scope) {
        case 'my_work': return labels.myWork;
        case 'assigned_to_me': return labels.assignedToMe;
        case 'following': return labels.following;
        case 'involving_me': return labels.involvingMe;
        case 'all_accessible': return labels.allAccessible;
    }
}

function selectedIds(
    filters: SessionListViewFilters,
    includeInactive: boolean,
    inactiveVisibilityAvailable: boolean,
    attentionAvailable: boolean,
): ReadonlySet<string> {
    const selected = new Set<string>([
        `show:${filters.show}`,
        `scope:${filters.scope}`,
        `source:${filters.source}`,
    ]);
    for (const starter of filters.startedBy) selected.add(`started-by:${starter}`);
    if (attentionAvailable) {
        selected.add(`attention:${filters.attention}`);
        if (filters.coordinator === 'coordinator') selected.add('coordinator:only');
    }
    if (inactiveVisibilityAvailable) {
        selected.add(`inactive:${includeInactive ? 'show' : 'hide'}`);
    }
    for (const serverId of filters.homeServerIds) selected.add(`home:${serverId}`);
    for (const audience of filters.audiences) {
        selected.add(encodeId('audience', buildQualifiedAudienceSelectionKey(audience)));
    }
    for (const tag of filters.tagIds) {
        selected.add(buildSessionListFilterTagOptionId(tag));
    }
    return selected;
}

/** The scope menu's one destination: it navigates to the archived list instead of writing a facet. */
export const SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID = 'destination:archived';

export function buildSessionListFilterEditorModel(input: Readonly<{
    filters: SessionListViewFilters;
    includeInactive: boolean;
    inactiveVisibilityAvailable?: boolean;
    /**
     * `needs_my_attention` can only be answered by a Home that serves filtered
     * listing; selecting it on a corpus served by the released GET adapter denies
     * every page and leaves an empty list. Availability is a per-facet fact here,
     * exactly like `scopesAvailable`, so the facet disappears instead of dead-ending.
     */
    attentionAvailable?: boolean;
    labels: SessionListFilterEditorLabels;
    scopesAvailable: Readonly<Record<SessionListScopeV1, boolean>>;
    homes: readonly SessionListFilterHomeOption[];
    audiences: readonly SessionListFilterAudienceOption[];
    tags: readonly SessionListFilterTagOption[];
    sourceAvailable: boolean;
    audiencePresentation?: SessionListFilterAudiencePresentation;
    fixedHomeServerIds?: ReadonlySet<string>;
    fixedAudienceKeys?: ReadonlySet<string>;
    fixedShow?: SessionListViewFilters['show'];
    /**
     * The Archived destination, offered after the scope choices on the active corpus only. It opens
     * the archived list; it is never a facet and never part of the selection.
     */
    archivedLabel?: string;
}>): SessionListFilterEditorModel {
    const homeSet = new Set(input.filters.homeServerIds);
    const showOptions: SelectionListOption[] = SCOPES.map((scope) => ({
        id: `scope:${scope}`,
        label: scopeLabel(scope, input.labels),
        disabled: input.scopesAvailable[scope] !== true,
    }));
    const homeOptions: SelectionListOption[] = input.homes.map((home) => ({
        id: `home:${home.serverId}`,
        label: home.label,
        disabled: home.disabled === true || input.fixedHomeServerIds?.has(home.serverId) === true,
    }));
    const visibleAudiences = input.audiences.filter((audience) => homeSet.has(audience.serverId));
    const audienceOptions: SelectionListOption[] = input.audiencePresentation !== 'team_drilldown'
        ? visibleAudiences.map((audience) => audienceSelectionOption(audience, input.fixedAudienceKeys))
        : visibleAudiences.flatMap((audience) => {
            if (audience.kind === 'group') return [];
            if (audience.kind === 'outside_teams') {
                return [audienceSelectionOption(audience, input.fixedAudienceKeys)];
            }
            const groups = visibleAudiences.filter((candidate) => (
                candidate.kind === 'group'
                && candidate.serverId === audience.serverId
                && candidate.teamId === audience.teamId
            ));
            return [{
                id: audienceTeamStepId(audience),
                label: audience.label,
                openStep: {
                    id: audienceTeamStepId(audience),
                    title: audience.label,
                    inputPlaceholder: input.labels.search,
                    emptyStateLabel: input.labels.noOptions,
                    sections: [{
                        kind: 'static' as const,
                        id: 'audiences',
                        title: input.labels.sharedWith,
                        options: [
                            audienceSelectionOption(audience, input.fixedAudienceKeys),
                            ...groups.map((group) => audienceSelectionOption(group, input.fixedAudienceKeys)),
                        ],
                    }],
                },
            }];
        });
    const tagOptions: SelectionListOption[] = input.tags
        .filter((tag) => homeSet.has(tag.serverId))
        .map((tag) => ({
            id: buildSessionListFilterTagOptionId(tag),
            label: tag.label,
            disabled: tag.disabled,
        }));
    const showOptionsAvailable = showOptions.some((option) => option.disabled !== true);
    const archivedOptions: SelectionListOption[] = input.archivedLabel
        ? [{ id: SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID, label: input.archivedLabel }]
        : [];
    return {
        rootStep: {
            id: 'session-list-filters',
            inputPlaceholder: input.labels.search,
            emptyStateLabel: input.labels.noOptions,
            sections: [
                ...(!input.fixedShow ? [{
                    kind: 'static' as const,
                    id: 'work-kind',
                    title: input.labels.show,
                    options: [
                        { id: 'show:sessions', label: input.labels.sessions },
                        { id: 'show:runs', label: input.labels.runs },
                        { id: 'show:both', label: input.labels.both },
                    ],
                }] : []),
                ...(input.filters.show !== 'sessions' ? [{
                    kind: 'static' as const,
                    id: 'started-by',
                    title: input.labels.startedBy,
                    options: [
                        { id: 'started-by:you', label: input.labels.startedByYou },
                        { id: 'started-by:triggers', label: input.labels.startedByTriggers },
                        { id: 'started-by:agents', label: input.labels.startedByAgents },
                    ],
                }] : []),
                ...(showOptionsAvailable || archivedOptions.length > 0 ? [{
                    kind: 'static' as const,
                    id: 'show',
                    title: input.labels.scope,
                    options: [...(showOptionsAvailable ? showOptions : []), ...archivedOptions],
                }] : []),
                ...(input.attentionAvailable !== false ? [{
                    kind: 'static' as const,
                    id: 'attention',
                    title: input.labels.attention,
                    options: [
                        { id: 'attention:any', label: input.labels.anyAttention },
                        { id: 'attention:needs_my_attention', label: input.labels.needsMyAttention },
                    ],
                }, {
                    // Coordinator is derived from the Follow relation on the Home that filters the listing,
                    // so it is offered exactly where that filtered listing (like attention) is available.
                    kind: 'static' as const,
                    id: 'coordinator',
                    options: [
                        { id: 'coordinator:only', label: input.labels.onlyCoordinators, subtitle: input.labels.onlyCoordinatorsDescription },
                    ],
                }] : []),
                ...(input.inactiveVisibilityAvailable !== false ? [{
                    kind: 'static' as const,
                    id: 'inactive',
                    title: input.labels.inactiveSessions,
                    options: [
                        { id: 'inactive:show', label: input.labels.showInactive },
                        { id: 'inactive:hide', label: input.labels.hideInactive },
                    ],
                }] : []),
                // Choosing among Homes needs at least two; one Home is the whole corpus, not a choice.
                ...(homeOptions.length > 1 ? [{
                    kind: 'static' as const,
                    id: 'homes',
                    title: input.labels.homes,
                    options: homeOptions,
                }] : []),
                ...(audienceOptions.length > 0 ? [{
                    kind: 'static' as const,
                    id: 'audiences',
                    title: input.labels.sharedWith,
                    options: audienceOptions,
                }] : []),
                ...(tagOptions.length > 0 ? [{
                    kind: 'static' as const,
                    id: 'tags',
                    title: input.labels.tags,
                    options: tagOptions,
                }] : []),
                ...(input.sourceAvailable ? [{
                    kind: 'static' as const,
                    id: 'source',
                    title: input.labels.source,
                    options: [
                        { id: 'source:all', label: input.labels.allSources },
                        { id: 'source:persisted', label: input.labels.persistedSource },
                        { id: 'source:direct', label: input.labels.directSource },
                    ],
                }] : []),
            ],
        },
        selection: {
            kind: 'multiple',
            selectedIds: selectedIds(
                input.filters,
                input.includeInactive,
                input.inactiveVisibilityAvailable !== false,
                input.attentionAvailable !== false,
            ),
        },
    };
}

function parseQualifiedKey(value: string): readonly string[] | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== 'string')) return null;
        return parsed;
    } catch {
        return null;
    }
}

export type SessionListFilterEditorSelectionContext = Readonly<{
    /**
     * Audience selectors this host pins (the parent Team inside Team Sessions).
     * A pinned Team is the corpus the person is browsing, so choosing one of its
     * Groups narrows that corpus instead of adding a selector the wire contract
     * would immediately drop as subsumed.
     */
    fixedAudienceKeys?: ReadonlySet<string>;
}>;

function reduceAudienceSelection(
    filters: SessionListViewFilters,
    audience: QualifiedAudienceSelection,
    context: SessionListFilterEditorSelectionContext | undefined,
): SessionListViewFilters {
    const key = buildQualifiedAudienceSelectionKey(audience);
    const exists = filters.audiences.some((candidate) => buildQualifiedAudienceSelectionKey(candidate) === key);
    const pinnedTeamKey = audience.kind === 'group'
        ? buildQualifiedAudienceSelectionKey({
            serverId: audience.serverId,
            kind: 'team',
            teamId: audience.teamId,
          })
        : null;
    const narrowsPinnedTeam = pinnedTeamKey !== null
        && context?.fixedAudienceKeys?.has(pinnedTeamKey) === true;
    const viewContext = narrowsPinnedTeam && audience.kind === 'group'
        ? { kind: 'team' as const, team: { serverId: audience.serverId, teamId: audience.teamId } }
        : undefined;

    if (!exists && narrowsPinnedTeam) {
        return normalizeSessionListViewFilters({
            ...filters,
            audiences: [
                ...filters.audiences.filter(
                    (candidate) => buildQualifiedAudienceSelectionKey(candidate) !== pinnedTeamKey,
                ),
                audience,
            ],
        }, viewContext);
    }

    const remaining = filters.audiences.filter(
        (candidate) => buildQualifiedAudienceSelectionKey(candidate) !== key,
    );
    return normalizeSessionListViewFilters({
        ...filters,
        audiences: exists ? remaining : [...filters.audiences, audience],
    }, viewContext);
}

export function reduceSessionListFilterEditorSelection(
    filters: SessionListViewFilters,
    optionId: string,
    context?: SessionListFilterEditorSelectionContext,
): SessionListViewFilters {
    if (optionId === 'show:sessions') return { ...filters, show: 'sessions' };
    if (optionId === 'show:runs') return { ...filters, show: 'runs' };
    if (optionId === 'show:both') return { ...filters, show: 'both' };
    if (optionId.startsWith('started-by:')) {
        const starter = optionId.slice('started-by:'.length);
        if (starter !== 'you' && starter !== 'triggers' && starter !== 'agents') return filters;
        return {
            ...filters,
            startedBy: filters.startedBy.includes(starter)
                ? filters.startedBy.filter((value) => value !== starter)
                : [...filters.startedBy, starter],
        };
    }
    if (optionId.startsWith('scope:')) {
        const scope = optionId.slice('scope:'.length) as SessionListScopeV1;
        return SCOPES.includes(scope) ? { ...filters, scope } : filters;
    }
    if (optionId === 'attention:any') return { ...filters, attention: 'any' };
    if (optionId === 'attention:needs_my_attention') return { ...filters, attention: 'needs_my_attention' };
    if (optionId === 'coordinator:only') {
        const { coordinator, ...rest } = filters;
        return coordinator === 'coordinator' ? rest : { ...filters, coordinator: 'coordinator' };
    }
    if (optionId === 'source:all') return { ...filters, source: 'all' };
    if (optionId === 'source:persisted') return { ...filters, source: 'persisted' };
    if (optionId === 'source:direct') return { ...filters, source: 'direct' };
    if (optionId.startsWith('home:')) {
        const serverId = optionId.slice('home:'.length).trim();
        if (!serverId) return filters;
        if (filters.homeServerIds.includes(serverId)) {
            return removeHomeFromSessionListViewFilters(filters, serverId);
        }
        return normalizeSessionListViewFilters({
            ...filters,
            homeServerIds: [...filters.homeServerIds, serverId],
        });
    }
    if (optionId.startsWith('tag:')) {
        const parts = parseQualifiedKey(optionId.slice('tag:'.length));
        if (!parts || parts.length !== 2) return filters;
        const tag = { serverId: parts[0]!, tagId: parts[1]! };
        const key = buildQualifiedTagAddressKey(tag);
        const exists = filters.tagIds.some((candidate) => buildQualifiedTagAddressKey(candidate) === key);
        return normalizeSessionListViewFilters({
            ...filters,
            tagIds: exists
                ? filters.tagIds.filter((candidate) => buildQualifiedTagAddressKey(candidate) !== key)
                : [...filters.tagIds, tag],
        });
    }
    if (optionId.startsWith('audience:')) {
        const parts = parseQualifiedKey(optionId.slice('audience:'.length));
        if (!parts || parts.length < 2) return filters;
        const audience: QualifiedAudienceSelection | null = parts[1] === 'outside_teams' && parts.length === 2
            ? { serverId: parts[0]!, kind: 'outside_teams' }
            : parts[1] === 'team' && parts.length === 3
                ? { serverId: parts[0]!, kind: 'team', teamId: parts[2]! }
                : parts[1] === 'group' && parts.length === 4
                    ? { serverId: parts[0]!, kind: 'group', teamId: parts[2]!, groupId: parts[3]! }
                    : null;
        if (!audience) return filters;
        return reduceAudienceSelection(filters, audience, context);
    }
    return filters;
}

export function resolveSessionListFilterEditorSelectionChange(
    filters: SessionListViewFilters,
    includeInactive: boolean,
    optionId: string,
    context?: SessionListFilterEditorSelectionContext,
): Readonly<{ filters: SessionListViewFilters; includeInactive: boolean }> {
    if (optionId === 'inactive:show') return { filters, includeInactive: true };
    if (optionId === 'inactive:hide') return { filters, includeInactive: false };
    return {
        filters: reduceSessionListFilterEditorSelection(filters, optionId, context),
        includeInactive,
    };
}
