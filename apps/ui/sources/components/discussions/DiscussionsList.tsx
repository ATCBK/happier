import * as React from 'react';
import { FlatList, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol';

import { DiscussionRow, DiscussionRowSkeleton } from '@/components/discussions/DiscussionRow';
import { useDiscussionListRows } from '@/sync/ops/discussions/useDiscussionListRows';
import { useOpenDiscussion } from './useOpenDiscussion';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { COLLECTION_LIST_SEARCH_THRESHOLD, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionRepositoryStatus } from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { useDiscussionListSearch } from '@/sync/ops/discussions/useDiscussionListSearch';
import { t } from '@/text';
import {
    buildDiscussionActivityItems,
    buildDiscussionColumnItems,
    discussionActivityItemKey,
    type DiscussionRecencyGroup,
    selectDiscussionSummariesForAnchor,
    type DiscussionActivityItem,
} from '@/components/discussions/discussionActivityItems';
import { useSessionConversationsAvailability } from '@/components/sessions/conversations/useSessionConversationsAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
const SKELETON_ROWS = [0, 1, 2] as const;

/**
 * The host's own invitation for an empty list, when it knows more than the list does (a Session
 * shared with nobody yet invites sharing before conversation).
 */
export type DiscussionsEmptyInvite = Readonly<{
    testID: string;
    title: string;
    reason: string;
    action: Readonly<{ label: string; onPress: () => void }>;
    note?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
    root: { flex: 1, minHeight: 0, minWidth: 0 },
    list: { flex: 1, minHeight: 0 },
    listContent: { flexGrow: 1, paddingBottom: theme.space.s8 },
    stateLine: { paddingHorizontal: theme.space.s8 },
    invite: { paddingTop: theme.space.s20, paddingHorizontal: theme.space.s12 },
    freshness: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s6 },
    archivedDisclosure: {
        minHeight: minimumInteractiveTargetSize,
        marginTop: theme.space.s4,
        marginHorizontal: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    archivedLabel: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    center: { minHeight: 64, alignItems: 'center', justifyContent: 'center', padding: theme.space.s16 },
    more: { minHeight: minimumInteractiveTargetSize, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
    moreText: { ...Typography.default('semiBold'), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.link },
}));

type DiscussionListItem = DiscussionActivityItem
    | Readonly<{ kind: 'archived_disclosure' }>
    | Readonly<{ kind: 'archived_discussion'; discussion: DiscussionOpenedSummaryV1 }>
    | Readonly<{ kind: 'archived_loading' | 'archived_empty' | 'archived_error' | 'archived_load_more' | 'filter_empty' | 'search_empty' | 'search_more' }>;

/** What the Discussions column shows (lab T2-A filter): everything, or only what needs you, unread or archived. */
type DiscussionColumnFilter = 'all' | 'needs_you' | 'unread' | 'archived';
const COLUMN_FILTERS: readonly DiscussionColumnFilter[] = ['all', 'needs_you', 'unread', 'archived'];
function columnFilterLabel(filter: DiscussionColumnFilter): string {
    switch (filter) {
        case 'all': return t('session.collaboration.discussion.home.filterAll');
        case 'needs_you': return t('session.collaboration.discussion.home.needsYou');
        case 'unread': return t('session.collaboration.discussion.home.filterUnread');
        case 'archived': return t('session.collaboration.discussion.archived');
    }
}

function discussionListItemKey(item: DiscussionListItem): string {
    switch (item.kind) {
        case 'archived_discussion': return `archived:${item.discussion.id}`;
        case 'archived_disclosure':
        case 'archived_loading':
        case 'archived_empty':
        case 'archived_error':
        case 'archived_load_more':
        case 'filter_empty':
        case 'search_empty':
        case 'search_more': return item.kind;
        default: return discussionActivityItemKey(item);
    }
}

/** The failures a read can end in that retain nothing new to show; the section says what failed. */
function isUnreadable(status: DiscussionRepositoryStatus): boolean {
    return status === 'error' || status === 'offline' || status === 'locked' || status === 'revoked';
}

function recencyGroupTitle(group: DiscussionRecencyGroup): string {
    switch (group) {
        case 'needs_you': return t('session.collaboration.discussion.home.needsYou');
        case 'today': return t('session.collaboration.discussion.home.today');
        case 'this_week': return t('session.collaboration.discussion.home.thisWeek');
        case 'earlier': return t('session.collaboration.discussion.home.earlier');
    }
}

/**
 * Where the list stands. `pane`: a section of the Session's People pane, under its own heading with
 * its "+" (lab collab C1). `column`: the Discussions destination's column (lab T2-A), titled by the
 * column with "+" at its header and grouped by what needs you and recency; `surface` says whether it
 * stands beside the open Discussion (`plane`) or is the destination's first screen (`page`, a phone).
 */
export type DiscussionsListPresentation = 'pane' | 'column';

/** One sentence for a list that could not be read (the archived list and the active section's line). */
function readFailureLine(status: DiscussionRepositoryStatus, errorCode: string | null | undefined): string {
    switch (status) {
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'revoked': return t('session.collaboration.pane.revokedTitle');
        case 'locked': return errorCode === 'discussion_encryption_mode_mismatch'
            ? t('session.collaboration.discussion.modeMismatch')
            : t('session.access.repairBody');
        default: return t('session.collaboration.discussion.loadError');
    }
}

/**
 * The canonical Home list, also consumed by the Session People anchor adapter.
 *
 * Repository, paging, and action decisions live here exactly once; the Collaboration surface owns
 * placement (presence, Responsible and the access card around it), never list state.
 */
export function DiscussionsList(props: Readonly<{
    address: Readonly<{ serverId: string }>;
    scope: ServerAccountScope;
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>;
    emptyInvite?: DiscussionsEmptyInvite;
    presentation?: DiscussionsListPresentation;
    surface?: 'plane' | 'page';
    /**
     * What the host draws after the conversations, inside the list's one scroller (a Session's People
     * pane: Followers and Following). Placement only; it holds no list state.
     */
    footer?: React.ReactElement | null;
}>): React.ReactElement {
    const requestedServerIds = React.useMemo(() => [props.address.serverId], [props.address.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const available = useSessionConversationsAvailability(props.address.serverId);
    const unavailableReason = !available
        ? t('session.collaboration.discussion.featureUnavailable')
        : !binding
            ? t('session.collaboration.discussion.bindingUnavailable')
            : !areServerAccountScopesEqual(binding.scope, props.scope)
                ? t('session.collaboration.discussion.scopeMismatch')
                : null;
    if (unavailableReason || !binding) return <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
        testID="session-conversations-unavailable"
        kind="unavailable"
        title={t('session.collaboration.discussion.unavailable')}
        reason={unavailableReason ?? t('session.collaboration.discussion.bindingUnavailable')}
    /></DiscussionsListPaneState>;
    return <DiscussionsListReady address={props.address} scope={props.scope} anchor={props.anchor} accountLifetime={binding} emptyInvite={props.emptyInvite} presentation={props.presentation ?? 'pane'} surface={props.surface ?? 'plane'} footer={props.footer ?? null} />;
}

/** A whole-list state in the pane: the state, and the host's footer still in reach below it. */
function DiscussionsListPaneState(props: Readonly<{ footer?: React.ReactElement | null; children: React.ReactElement }>) {
    if (!props.footer) return props.children;
    return <ScrollView style={paneStateStyles.scroll} testID="session-conversations-state-scroll">{props.children}{props.footer}</ScrollView>;
}

/**
 * The Conversations list (lab `collab` C1): one virtualized list whose heading, rows, reserved
 * first-load rows, invitation and archived disclosure are all list items, so exactly one scroller and
 * virtualization owner sits under the surface's flex body.
 *
 * Whole-list failures that leave nothing to read — locked encryption, removed access — replace the
 * list with one pane state. A failure with conversations retained keeps them at full strength under
 * one freshness line.
 */
function DiscussionsListReady(props: Readonly<{
    address: Readonly<{ serverId: string }>;
    scope: ServerAccountScope;
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>;
    accountLifetime: ServerCredentialAccountScopeBinding;
    emptyInvite?: DiscussionsEmptyInvite;
    presentation: DiscussionsListPresentation;
    surface: 'plane' | 'page';
    footer: React.ReactElement | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const column = props.presentation === 'column';
    const homeProfile = React.useMemo(() => getServerProfileById(props.address.serverId), [props.address.serverId]);
    const homeLabel = useHomeDisplayLabel(homeProfile);
    const client = React.useMemo(() => createDiscussionClient({ scope: props.scope, availability: 'available' }), [props.scope]);
    const repository = React.useMemo(() => getDiscussionRepository({
        scope: props.scope,
        address: props.address,
        client,
        accountLifetime: props.accountLifetime,
    }), [client, props.accountLifetime, props.address, props.scope]);
    useDiscussionRepositorySnapshot(repository);
    const anchorSessionId = props.anchor?.sessionId;
    const collection = repository.getListSnapshot(anchorSessionId);
    const refreshList = React.useCallback((state: 'active' | 'archived') => anchorSessionId
        ? repository.refreshAnchoredList(anchorSessionId, state)
        : repository.refreshList(state), [anchorSessionId, repository]);
    const loadMoreList = React.useCallback((state: 'active' | 'archived') => anchorSessionId
        ? repository.loadMoreAnchoredList(anchorSessionId, state)
        : repository.loadMoreList(state), [anchorSessionId, repository]);
    const { openDiscussion, openNewDiscussion, activeDiscussionKey } = useOpenDiscussion({ address: props.address, anchor: props.anchor, sourceSurface: props.anchor ? 'collaboration' : 'discussions' });
    const [archivedExpanded, setArchivedExpanded] = React.useState(false);
    const [filter, setFilter] = React.useState<DiscussionColumnFilter>('all');
    const [filterOpen, setFilterOpen] = React.useState(false);
    // The column's search (R6): what this device already opened for each Discussion (its title, the people
    // in it, its source), across the whole list; the list pages to its end while a query is typed.
    const [query, setQuery] = React.useState('');
    const searching = column && query.trim().length > 0;
    const searched = useDiscussionListSearch({ repository, scope: props.scope, accountLifetime: props.accountLifetime,
        query: column ? query : '', state: filter === 'archived' ? 'archived' : 'active', ...(anchorSessionId ? { anchorSessionId } : {}) });
    const active = React.useMemo(() => ({ ...collection.lists.active, items: selectDiscussionSummariesForAnchor(collection.lists.active.items, props.anchor) }), [props.anchor, collection.lists.active]);
    const archived = React.useMemo(() => ({ ...collection.lists.archived, items: selectDiscussionSummariesForAnchor(collection.lists.archived.items, props.anchor) }), [props.anchor, collection.lists.archived]);
    const viewerAccountId = props.scope.accountId;
    const emptyInvite = props.emptyInvite;
    // What needs the viewer (approval, a private draft, a mention) leads the column's Needs you group.
    const activeRows = useDiscussionListRows(props.scope, active.items);
    const attention = React.useMemo(() => new Map(activeRows.map(row => [row.id, row.attentionReason] as const)), [activeRows]);

    React.useEffect(() => {
        const unmount = repository.mount(anchorSessionId ? { anchorSessionId } : undefined);
        if (repository.getListSnapshot(anchorSessionId).lists.active.status === 'idle') void refreshList('active');
        return unmount;
    }, [anchorSessionId, refreshList, repository]);

    React.useEffect(() => {
        if ((archivedExpanded || filter === 'archived') && repository.getListSnapshot(anchorSessionId).lists.archived.status === 'idle') {
            void refreshList('archived');
        }
    }, [anchorSessionId, archivedExpanded, filter, refreshList, repository]);

    const toggleArchived = React.useCallback(() => {
        setArchivedExpanded((current) => !current);
    }, []);
    const retryActive = React.useCallback(() => { void refreshList('active'); }, [refreshList]);

    const items = React.useMemo<readonly DiscussionListItem[]>(() => {
        const humanListPending = active.status === 'idle' || (active.status === 'loading' && active.items.length === 0);
        if (searching) {
            // Matches keep the column's grouping and the chosen filter; a whole-list answer still on its way
            // says so under the matches rather than claiming there are no more.
            const kept = searched.items.filter((discussion) => filter === 'unread'
                ? discussion.unreadCount > 0
                : filter === 'needs_you'
                    ? attention.get(discussion.id) != null || (discussion.unreadCount > 0 && discussion.unreadMentionCount > 0)
                    : true);
            const rows: DiscussionListItem[] = kept.length === 0 ? []
                : filter === 'archived'
                    ? kept.map((discussion) => ({ kind: 'archived_discussion' as const, discussion }))
                    : [...buildDiscussionColumnItems({ discussions: kept, humanListPending: false, now: new Date(), attention })];
            if (searched.incomplete && !isUnreadable(searched.status)) rows.push({ kind: 'search_more' });
            else if (kept.length === 0) rows.push({ kind: 'search_empty' });
            return rows;
        }
        if (column && filter === 'archived') {
            if (archived.status === 'loading' && archived.items.length === 0) return [{ kind: 'archived_loading' }];
            if (isUnreadable(archived.status) && archived.items.length === 0) return [{ kind: 'archived_error' }];
            if (archived.items.length === 0) return [{ kind: 'archived_empty' }];
            return [...archived.items.map((discussion) => ({ kind: 'archived_discussion' as const, discussion })),
                ...(archived.nextCursor ? [{ kind: 'archived_load_more' as const }] : [])];
        }
        if (column && filter !== 'all') {
            // Filtering narrows the loaded rows; reaching the end keeps loading pages until the list is whole.
            const kept = active.items.filter((discussion) => filter === 'unread'
                ? discussion.unreadCount > 0
                : attention.get(discussion.id) != null || (discussion.unreadCount > 0 && discussion.unreadMentionCount > 0));
            if (kept.length === 0 && !humanListPending) return [{ kind: 'filter_empty' }];
            return [...buildDiscussionColumnItems({ discussions: kept, humanListPending, now: new Date(), attention })];
        }
        const primary: DiscussionListItem[] = column
            ? [...buildDiscussionColumnItems({ discussions: active.items, humanListPending, now: new Date(), attention })]
            : [...buildDiscussionActivityItems({ discussions: active.items, humanListPending })];
        // The disclosure is a claim that there is something archived to open.
        // Only a proven-empty answer withdraws it; `unknown` keeps offering it,
        // because refusing to show it on an unanswered read would state an
        // emptiness this surface does not know.
        if (!archivedExpanded) {
            return collection.archivedExistence === 'empty'
                ? primary
                : [...primary, { kind: 'archived_disclosure' }];
        }
        const archivedItems: DiscussionListItem[] = [{ kind: 'archived_disclosure' }];
        if (archived.status === 'loading' && archived.items.length === 0) archivedItems.push({ kind: 'archived_loading' });
        else if (isUnreadable(archived.status) && archived.items.length === 0) archivedItems.push({ kind: 'archived_error' });
        else if (archived.items.length === 0) archivedItems.push({ kind: 'archived_empty' });
        else {
            archivedItems.push(...archived.items.map((discussion) => ({ kind: 'archived_discussion' as const, discussion })));
            if (archived.nextCursor) archivedItems.push({ kind: 'archived_load_more' });
        }
        return [...primary, ...archivedItems];
    }, [active.items, active.status, archived.items, archived.nextCursor, archived.status, archivedExpanded, attention, collection.archivedExistence, column, filter, searched, searching]);

    const activeCount = active.nextCursor === null && active.items.length > 0 ? active.items.length : undefined;
    const renderItem = React.useCallback(({ item }: Readonly<{ item: DiscussionListItem }>) => {
        switch (item.kind) {
            case 'human_section':
                return (
                    <PaneSectionHeader testID="session-human-conversations-section" title={t('session.collaboration.conversations')}
                        count={activeCount} action={<>
                        {active.status === 'loading' && active.items.length > 0 ? <ActivitySpinner size="small" /> : null}
                        <IconButton
                                testID="session-discussion-new"
                                iconName="plus"
                                size={28}
                                iconSize={15}
                                variant="plain"
                                minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                                accessibilityLabel={t('session.collaboration.discussion.newDiscussion')}
                                tooltip={t('session.collaboration.discussion.newDiscussion')}
                                onPress={openNewDiscussion}
                        />
                    </>} />
                );
            case 'recency_group':
                return <CollectionListGroupLabel testID={`discussions-column-group-${item.group}`} title={recencyGroupTitle(item.group)} />;
            case 'human_discussion':
                return (
                    <DiscussionRow
                        discussion={item.discussion}
                        viewerAccountId={viewerAccountId}
                        geometry={column ? 'column' : 'pane'}
                        attentionReason={attention.get(item.discussion.id) ?? null}
                        selected={activeDiscussionKey === item.discussion.id}
                        onPress={() => openDiscussion(item.discussion.id, item.discussion.title)}
                    />
                );
            case 'human_pending':
                return (
                    <View testID="session-conversations-loading" accessibilityRole="progressbar" accessibilityLabel={t('session.collaboration.discussion.loading')}>
                        {SKELETON_ROWS.map((index) => <DiscussionRowSkeleton key={index} index={index} />)}
                    </View>
                );
            case 'human_empty':
                if (isUnreadable(active.status)) {
                    return (
                        <View style={styles.stateLine}>
                            <SurfaceStateCard
                                testID="session-conversations-error"
                                size="line"
                                kind="error"
                                title={readFailureLine(active.status, active.errorCode)}
                                action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                            />
                        </View>
                    );
                }
                if (column) {
                    // Beside the main page the invitation is the page's (lab T2-E); the column only says
                    // what will appear here. As the destination's first screen it invites itself.
                    return props.surface === 'plane' ? (
                        <EmptyState testID="discussions-column-empty" layout="line" title={t('session.collaboration.discussion.home.columnEmpty')} />
                    ) : (
                        <View style={styles.invite}>
                            <EmptyState
                                testID="discussions-column-invite"
                                layout="centered"
                                title={t('session.collaboration.discussion.home.inviteTitle')}
                                subtitle={t('session.collaboration.discussion.home.inviteBody')}
                                primaryAction={{ label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
                            />
                        </View>
                    );
                }
                if (emptyInvite) {
                    return (
                        <View style={styles.invite}>
                            <SurfaceStateCard
                                testID={emptyInvite.testID}
                                kind="empty"
                                iconName="users"
                                title={emptyInvite.title}
                                reason={emptyInvite.reason}
                                action={emptyInvite.action}
                                note={emptyInvite.note}
                            />
                        </View>
                    );
                }
                return (
                    <View style={styles.invite}>
                        <SurfaceStateCard
                            testID="session-conversations-empty"
                            kind="empty"
                            iconName="chat-circle"
                            title={t('session.collaboration.pane.inviteTitle')}
                            reason={t('session.collaboration.pane.inviteBody')}
                            action={{ label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
                        />
                    </View>
                );
            case 'archived_disclosure':
                return (
                    <Pressable
                        testID="session-discussion-archived-disclosure"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: archivedExpanded }}
                        accessibilityLabel={t('session.collaboration.discussion.archivedDisclosure')}
                        onPress={toggleArchived}
                        style={({ pressed }) => [styles.archivedDisclosure, pressed ? { opacity: motionTokens.press.opacity } : null]}
                    >
                        <Icon name={archivedExpanded ? 'caret-down' : 'caret-right'} size={13} color={theme.colors.text.tertiary} />
                        <Text style={styles.archivedLabel}>{t('session.collaboration.discussion.archived')}</Text>
                    </Pressable>
                );
            case 'archived_discussion':
                return <DiscussionRow discussion={item.discussion} viewerAccountId={viewerAccountId} geometry={column ? 'column' : 'pane'} attentionReason={attention.get(item.discussion.id) ?? null} selected={activeDiscussionKey === item.discussion.id} onPress={() => openDiscussion(item.discussion.id, item.discussion.title)} />;
            case 'archived_loading':
                return <View style={styles.center}><ActivitySpinner size="small" /></View>;
            case 'search_more':
                return <View style={styles.center}><ActivitySpinner size="small" accessibilityLabel={t('session.collaboration.discussion.loading')} /></View>;
            // A narrowed column says so on the column's own quiet line, at the rows' text edge.
            case 'search_empty':
                return <EmptyState testID="discussions-column-search-empty" layout="line" title={t('common.noMatches')} />;
            case 'filter_empty':
                return <EmptyState testID="discussions-column-filter-empty" layout="line" title={t('session.collaboration.discussion.home.filterEmpty')} />;
            case 'archived_empty':
                return (
                    <View style={styles.stateLine}>
                        <SurfaceStateCard size="line" kind="empty" title={t('session.collaboration.discussion.emptyArchived')} />
                    </View>
                );
            case 'archived_error':
                return (
                    <View style={styles.stateLine}>
                        <SurfaceStateCard
                            testID="session-conversations-archived-error"
                            size="line"
                            kind="error"
                            title={readFailureLine(archived.status, archived.errorCode)}
                            action={{ label: t('session.collaboration.discussion.retry'), onPress: () => { void refreshList('archived'); } }}
                        />
                    </View>
                );
            case 'archived_load_more':
                return <Pressable testID="session-discussion-archived-load-more" style={styles.more} accessibilityRole="button" onPress={() => void loadMoreList('archived')}><Text style={styles.moreText}>{t('session.collaboration.discussion.loadMore')}</Text></Pressable>;
        }
    }, [active.errorCode, active.items.length, active.status, activeCount, activeDiscussionKey, archived.errorCode, attention, archived.status, archivedExpanded, column, emptyInvite, loadMoreList, openDiscussion, openNewDiscussion, props.surface, refreshList, retryActive, theme.colors.text.tertiary, toggleArchived, viewerAccountId]);

    // Nothing retained and nothing readable: the whole list is one pane state.
    if (!column && active.items.length === 0 && active.status === 'locked') {
        return (
            <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
                testID="session-conversations-locked"
                kind="error"
                iconName="lock"
                title={t('session.collaboration.pane.lockedTitle')}
                reason={active.errorCode === 'discussion_encryption_mode_mismatch'
                    ? t('session.collaboration.pane.lockedBody')
                    : t('session.access.repairBody')}
                diagnosticCode={active.errorCode}
                action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                accessibilitySemantics="status"
            /></DiscussionsListPaneState>
        );
    }
    if (!column && active.status === 'revoked') {
        return (
            <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
                testID="session-conversations-revoked"
                kind="denied"
                title={t('session.collaboration.pane.revokedTitle')}
                reason={t('session.collaboration.pane.revokedBody')}
                accessibilitySemantics="status"
            /></DiscussionsListPaneState>
        );
    }
    if (column) {
        const searchable = query.length > 0 || active.nextCursor !== null || active.items.length > COLLECTION_LIST_SEARCH_THRESHOLD;
        const narrowedRows = items.filter((item) => item.kind === 'human_discussion' || item.kind === 'archived_discussion').length;
        const narrowedComplete = searching ? !searched.incomplete
            : filter === 'archived' ? archived.nextCursor === null && archived.status === 'ready' : active.nextCursor === null && active.status === 'ready';
        const narrowedCount = narrowedComplete && narrowedRows > 0 ? narrowedRows : null;
        const whole = active.items.length === 0 && active.status === 'locked'
            ? <SurfaceStateCard testID="session-conversations-locked" size="line" kind="error" iconName="lock" title={t('session.collaboration.pane.lockedTitle')} action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }} />
            : active.status === 'revoked'
                ? <SurfaceStateCard testID="session-conversations-revoked" size="line" kind="denied" title={t('session.collaboration.pane.revokedTitle')} />
                : null;
        const stale = active.items.length > 0 && isUnreadable(active.status);
        return (
            <CollectionList
                testID="discussions-column"
                surface={props.surface}
                title={t('session.collaboration.discussion.title')}
                // A narrowed column counts what it shows, once that answer is whole.
                count={searching || filter !== 'all' ? narrowedCount : activeCount ?? null}
                search={searchable ? {
                    testID: 'discussions-column-search',
                    value: query,
                    onChangeText: setQuery,
                    placeholder: t('session.collaboration.discussion.home.search'),
                } : null}
                // Whose Discussions these are, and who reads them (lab T2-A).
                subtitle={{
                    testID: 'discussions-column-home',
                    text: `${homeLabel} · ${t('session.collaboration.discussion.home.audience')}`,
                    leading: <Icon name="house" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />,
                }}
                headerAction={<View style={styles.headerActions}>
                    {/* Narrow the column to what needs you, unread or archived (lab T2-A). */}
                    <DropdownMenu
                        testID="discussions-column-filter"
                        open={filterOpen}
                        onOpenChange={setFilterOpen}
                        items={COLUMN_FILTERS.map((value) => ({ id: value, title: columnFilterLabel(value), checked: value === filter,
                            testID: `discussions-column-filter:${value}` }))}
                        selectedId={filter}
                        placement="bottom"
                        popoverAnchorAlign="end"
                        variant="slim"
                        matchTriggerWidth={false}
                        maxWidthCap={240}
                        onSelect={(id) => {
                            setFilterOpen(false);
                            const next = COLUMN_FILTERS.find((value) => value === id);
                            if (next) setFilter(next);
                        }}
                        trigger={({ toggle }) => (
                            <IconButton
                                testID="discussions-column-filter.trigger"
                                iconName="funnel-simple"
                                variant="plain"
                                selected={filter !== 'all'}
                                expanded={filterOpen}
                                hasPopup="menu"
                                minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                                accessibilityLabel={filter === 'all'
                                    ? t('session.collaboration.discussion.home.filter')
                                    : `${t('session.collaboration.discussion.home.filter')}: ${columnFilterLabel(filter)}`}
                                tooltip={t('session.collaboration.discussion.home.filter')}
                                tooltipHidden={filterOpen}
                                onPress={toggle}
                            />
                        )}
                    />
                    <IconButton
                        testID="session-discussion-new"
                        iconName="plus"
                        variant="plain"
                        minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                        accessibilityLabel={t('session.collaboration.discussion.newDiscussion')}
                        tooltip={t('session.collaboration.discussion.newDiscussion')}
                        onPress={openNewDiscussion}
                    />
                </View>}
                scrollContent={whole ? <View style={collectionListStyles.stateLine}>{whole}</View> : (
                    <View style={styles.root} testID="session-discussion-activity-list">
                        {stale ? (
                            <View style={collectionListStyles.stateLine}>
                                <SurfaceFreshnessLine
                                    testID="session-conversations-freshness"
                                    reason={active.status === 'offline' ? t('session.collaboration.pane.offline') : readFailureLine(active.status, active.errorCode)}
                                    tone={active.status === 'offline' ? 'neutral' : 'warning'}
                                    action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                                />
                            </View>
                        ) : null}
                        <FlatList
                            style={styles.list}
                            contentContainerStyle={styles.listContent}
                            accessibilityRole="list"
                            accessibilityLabel={t('session.collaboration.discussion.title')}
                            data={items}
                            keyExtractor={discussionListItemKey}
                            renderItem={renderItem}
                            onEndReachedThreshold={0.35}
                            onEndReached={() => { if (active.nextCursor && active.status !== 'loading') void loadMoreList('active'); }}
                        />
                    </View>
                )}
            />
        );
    }
    const staleReason = active.items.length > 0 && isUnreadable(active.status)
        ? active.status === 'offline' ? t('session.collaboration.pane.offline') : readFailureLine(active.status, active.errorCode)
        : null;
    return (
        <View style={styles.root} testID="session-discussion-activity-list">
            {staleReason ? (
                <View style={styles.freshness}>
                    <SurfaceFreshnessLine
                        testID="session-conversations-freshness"
                        reason={staleReason}
                        tone={active.status === 'offline' ? 'neutral' : 'warning'}
                        action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                    />
                </View>
            ) : null}
            <FlatList
                style={styles.list}
                contentContainerStyle={styles.listContent}
                accessibilityRole="list"
                accessibilityLabel={t('session.collaboration.conversations')}
                data={items}
                keyExtractor={discussionListItemKey}
                renderItem={renderItem}
                onEndReachedThreshold={0.35}
                onEndReached={() => { if (active.nextCursor && active.status !== 'loading') void loadMoreList('active'); }}
                ListFooterComponent={props.footer}
            />
        </View>
    );
}

const paneStateStyles = StyleSheet.create({
    scroll: { flex: 1, minHeight: 0 },
});
