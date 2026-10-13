import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SessionDiscussionOpenedSummaryV1 } from '@happier-dev/protocol';

import { SessionDiscussionRow, SessionDiscussionRowSkeleton } from './SessionDiscussionRow';
import { useOpenSessionDiscussion } from './useOpenSessionDiscussion';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { isSessionWriteKnownDenied } from '@/utils/sessions/deriveTranscriptInteraction';
import { createSessionDiscussionClient } from '@/sync/api/session/sessionDiscussionActions';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionDiscussionRepositoryStatus } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepository';
import { getSessionDiscussionRepository } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry';
import { useSessionDiscussionRepositorySnapshot } from '@/sync/ops/sessionDiscussions/useSessionDiscussionRepositorySnapshot';
import { t } from '@/text';
import {
    buildSessionDiscussionActivityItems,
    sessionDiscussionActivityItemKey,
    type SessionDiscussionActivityItem,
} from './sessionDiscussionActivityItems';
import { useSessionConversationsAvailability } from './useSessionConversationsAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
const SKELETON_ROWS = [0, 1, 2] as const;

/**
 * The host's own invitation for an empty list, when it knows more than the list does (a Session
 * shared with nobody yet invites sharing before conversation).
 */
export type SessionConversationsEmptyInvite = Readonly<{
    testID: string;
    title: string;
    reason: string;
    action: Readonly<{ label: string; onPress: () => void }>;
    note?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, minWidth: 0 },
    list: { flex: 1, minHeight: 0 },
    listContent: { flexGrow: 1, paddingBottom: theme.space.s8 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, paddingLeft: theme.space.s8, paddingRight: theme.space.s8 },
    sectionLabel: { flex: 1, minWidth: 0 },
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

type SessionDiscussionListItem = SessionDiscussionActivityItem
    | Readonly<{ kind: 'read_only' }>
    | Readonly<{ kind: 'archived_disclosure' }>
    | Readonly<{ kind: 'archived_discussion'; discussion: SessionDiscussionOpenedSummaryV1 }>
    | Readonly<{ kind: 'archived_loading' | 'archived_empty' | 'archived_error' | 'archived_load_more' }>;

function sessionDiscussionListItemKey(item: SessionDiscussionListItem): string {
    switch (item.kind) {
        case 'archived_discussion': return `archived:${item.discussion.id}`;
        case 'read_only':
        case 'archived_disclosure':
        case 'archived_loading':
        case 'archived_empty':
        case 'archived_error':
        case 'archived_load_more': return item.kind;
        default: return sessionDiscussionActivityItemKey(item);
    }
}

/** The failures a read can end in that retain nothing new to show; the section says what failed. */
function isUnreadable(status: SessionDiscussionRepositoryStatus): boolean {
    return status === 'error' || status === 'offline' || status === 'locked' || status === 'revoked';
}

/** One sentence for a list that could not be read (the archived list and the active section's line). */
function readFailureLine(status: SessionDiscussionRepositoryStatus, errorCode: string | null | undefined): string {
    switch (status) {
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'revoked': return t('session.collaboration.pane.revokedTitle');
        case 'locked': return errorCode === 'session_discussion_encryption_mode_mismatch'
            ? t('session.collaboration.discussion.modeMismatch')
            : t('session.access.repairBody');
        default: return t('session.collaboration.discussion.loadError');
    }
}

/**
 * Lane 05 canonical Conversations body: the one component the Collaboration pane mounts for its
 * conversations with people.
 *
 * Repository, paging, and action decisions live here exactly once; the Collaboration surface owns
 * placement (presence, Responsible and the access card around it), never list state.
 */
export function SessionConversationsBody(props: Readonly<{
    address: SessionAddress;
    scope: ServerAccountScope;
    emptyInvite?: SessionConversationsEmptyInvite;
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
    if (unavailableReason) return <SurfaceStateCard
        testID="session-conversations-unavailable"
        kind="unavailable"
        title={t('session.collaboration.discussion.unavailable')}
        reason={unavailableReason}
    />;
    return <SessionConversationsBodyReady address={props.address} scope={props.scope} accountLifetime={binding} emptyInvite={props.emptyInvite} />;
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
function SessionConversationsBodyReady(props: Readonly<{
    address: SessionAddress;
    scope: ServerAccountScope;
    accountLifetime: ServerCredentialAccountScopeBinding;
    emptyInvite?: SessionConversationsEmptyInvite;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const client = React.useMemo(() => createSessionDiscussionClient({ session: props.address, availability: 'available' }), [props.address]);
    const repository = React.useMemo(() => getSessionDiscussionRepository({
        scope: props.scope,
        address: props.address,
        client,
        accountLifetime: props.accountLifetime,
    }), [client, props.accountLifetime, props.address, props.scope]);
    const snapshot = useSessionDiscussionRepositorySnapshot(repository);
    const { openDiscussion, openNewDiscussion, activeDiscussionKey } = useOpenSessionDiscussion({ address: props.address, sourceSurface: 'collaboration' });
    // Only a known refusal takes the create affordance away. An unloaded Session,
    // a missing access projection or an offline Home leave it available with the
    // server as the authority, so a writer never loses the flow to a slow read.
    const session = useSessionViewShellSession(props.address.sessionId, props.address.serverId);
    const readOnly = isSessionWriteKnownDenied(session);
    const [archivedExpanded, setArchivedExpanded] = React.useState(false);
    const active = snapshot.lists.active;
    const archived = snapshot.lists.archived;
    const viewerAccountId = props.scope.accountId;
    const emptyInvite = props.emptyInvite;

    React.useEffect(() => {
        const unmount = repository.mount();
        if (repository.getSnapshot().lists.active.status === 'idle') void repository.refreshList('active');
        return unmount;
    }, [repository]);

    React.useEffect(() => {
        if (archivedExpanded && repository.getSnapshot().lists.archived.status === 'idle') {
            void repository.refreshList('archived');
        }
    }, [archivedExpanded, repository]);

    const toggleArchived = React.useCallback(() => {
        setArchivedExpanded((current) => !current);
    }, []);
    const retryActive = React.useCallback(() => { void repository.refreshList('active'); }, [repository]);

    const items = React.useMemo<readonly SessionDiscussionListItem[]>(() => {
        const primary: SessionDiscussionListItem[] = [...buildSessionDiscussionActivityItems({
            discussions: active.items,
            humanListPending: active.status === 'idle' || (active.status === 'loading' && active.items.length === 0),
        })];
        // Read only: the "+" leaves the header and one line under it says who can post.
        if (readOnly) primary.splice(1, 0, { kind: 'read_only' });
        // The disclosure is a claim that there is something archived to open.
        // Only a proven-empty answer withdraws it; `unknown` keeps offering it,
        // because refusing to show it on an unanswered read would state an
        // emptiness this surface does not know.
        if (!archivedExpanded) {
            return snapshot.archivedExistence === 'empty'
                ? primary
                : [...primary, { kind: 'archived_disclosure' }];
        }
        const archivedItems: SessionDiscussionListItem[] = [{ kind: 'archived_disclosure' }];
        if (archived.status === 'loading' && archived.items.length === 0) archivedItems.push({ kind: 'archived_loading' });
        else if (isUnreadable(archived.status) && archived.items.length === 0) archivedItems.push({ kind: 'archived_error' });
        else if (archived.items.length === 0) archivedItems.push({ kind: 'archived_empty' });
        else {
            archivedItems.push(...archived.items.map((discussion) => ({ kind: 'archived_discussion' as const, discussion })));
            if (archived.nextCursor) archivedItems.push({ kind: 'archived_load_more' });
        }
        return [...primary, ...archivedItems];
    }, [active.items, active.status, archived.items, archived.nextCursor, archived.status, archivedExpanded, readOnly, snapshot.archivedExistence]);

    const activeCount = active.nextCursor === null && active.items.length > 0 ? active.items.length : undefined;
    const renderItem = React.useCallback(({ item }: Readonly<{ item: SessionDiscussionListItem }>) => {
        switch (item.kind) {
            case 'human_section':
                return (
                    <View style={styles.sectionHeader} testID="session-human-conversations-section">
                        <View style={styles.sectionLabel}>
                            <CollectionListGroupLabel title={t('session.collaboration.conversations')} count={activeCount} />
                        </View>
                        {active.status === 'loading' && active.items.length > 0 ? <ActivitySpinner size="small" /> : null}
                        {readOnly ? null : (
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
                        )}
                    </View>
                );
            case 'read_only':
                return (
                    <View style={styles.stateLine}>
                        <SurfaceStateCard testID="session-conversations-read-only" size="line" kind="denied" title={t('session.collaboration.pane.readOnly')} />
                    </View>
                );
            case 'human_discussion':
                return (
                    <SessionDiscussionRow
                        discussion={item.discussion}
                        viewerAccountId={viewerAccountId}
                        selected={activeDiscussionKey === item.discussion.id}
                        onPress={() => openDiscussion(item.discussion.id, item.discussion.title)}
                    />
                );
            case 'human_pending':
                return (
                    <View testID="session-conversations-loading" accessibilityRole="progressbar" accessibilityLabel={t('session.collaboration.discussion.loading')}>
                        {SKELETON_ROWS.map((index) => <SessionDiscussionRowSkeleton key={index} index={index} />)}
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
                if (emptyInvite && !readOnly) {
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
                            action={readOnly ? undefined : { label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
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
                return <SessionDiscussionRow discussion={item.discussion} viewerAccountId={viewerAccountId} selected={activeDiscussionKey === item.discussion.id} onPress={() => openDiscussion(item.discussion.id, item.discussion.title)} />;
            case 'archived_loading':
                return <View style={styles.center}><ActivitySpinner size="small" /></View>;
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
                            action={{ label: t('session.collaboration.discussion.retry'), onPress: () => { void repository.refreshList('archived'); } }}
                        />
                    </View>
                );
            case 'archived_load_more':
                return <Pressable testID="session-discussion-archived-load-more" style={styles.more} accessibilityRole="button" onPress={() => void repository.loadMoreList('archived')}><Text style={styles.moreText}>{t('session.collaboration.discussion.loadMore')}</Text></Pressable>;
        }
    }, [active.errorCode, active.items.length, active.status, activeCount, activeDiscussionKey, archived.errorCode, archived.status, archivedExpanded, emptyInvite, openDiscussion, openNewDiscussion, readOnly, repository, retryActive, theme.colors.text.tertiary, toggleArchived, viewerAccountId]);

    // Nothing retained and nothing readable: the whole list is one pane state.
    if (active.items.length === 0 && active.status === 'locked') {
        return (
            <SurfaceStateCard
                testID="session-conversations-locked"
                kind="error"
                iconName="lock"
                title={t('session.collaboration.pane.lockedTitle')}
                reason={active.errorCode === 'session_discussion_encryption_mode_mismatch'
                    ? t('session.collaboration.pane.lockedBody')
                    : t('session.access.repairBody')}
                diagnosticCode={active.errorCode}
                action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                accessibilitySemantics="status"
            />
        );
    }
    if (active.status === 'revoked') {
        return (
            <SurfaceStateCard
                testID="session-conversations-revoked"
                kind="denied"
                title={t('session.collaboration.pane.revokedTitle')}
                reason={t('session.collaboration.pane.revokedBody')}
                accessibilitySemantics="status"
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
                keyExtractor={sessionDiscussionListItemKey}
                renderItem={renderItem}
                onEndReachedThreshold={0.35}
                onEndReached={() => { if (active.nextCursor && active.status !== 'loading') void repository.loadMoreList('active'); }}
            />
        </View>
    );
}
