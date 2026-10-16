import * as React from 'react';
import { Platform, Pressable, View, type ViewToken } from 'react-native';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import {
    type SessionDiscussionMessageContentV1,
    type SessionDiscussionOpenedMessageV1,
    type SessionDiscussionOpenedSummaryV1,
    type SessionDiscussionDetailsResultV1,
} from '@happier-dev/protocol';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SessionDiscussionDetailsTarget } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { requestRegisteredSessionComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { SessionDraftConflictResolution } from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { isSessionWriteKnownDenied } from '@/utils/sessions/deriveTranscriptInteraction';
import { publishInteractiveExecutionRunDraftNavigationIntent } from '@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent';
import { SelectMessageButton } from '@/components/sessions/transcript/messageSelection/SelectMessageButton';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { shouldShowTranscriptRowActions } from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { TranscriptMessageSelectionBoundary } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar, type TranscriptSelectionToolbarMessage } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbar';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveReadOnlyTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { randomUUID } from '@/platform/randomUUID';
import { createSessionDiscussionClient, type SessionDiscussionClientOutcome } from '@/sync/api/session/sessionDiscussionActions';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionSurfaceVisible, useSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createSessionDiscussionVisibleReadController } from '@/sync/domains/session/discussions/sessionDiscussionVisibleReadController';
import { useSessionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { registerSessionDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { useSetting } from '@/sync/domains/state/storage';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import type { SessionDiscussionRepository, SessionDiscussionRepositoryMutation } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepository';
import { getSessionDiscussionRepository } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepositoryRegistry';
import { useSessionDiscussionRepositorySnapshot } from '@/sync/ops/sessionDiscussions/useSessionDiscussionRepositorySnapshot';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { formatSessionPresenceViewerNames } from '@/components/sessions/collaboration/sessionPresenceNames';
import { STALE_PRESENCE_OPACITY } from '@/components/sessions/collaboration/SessionViewerFacepile';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import type { SessionHumanPresenceViewer } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';
import { useDeviceType } from '@/utils/platform/responsive';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { SessionDiscussionAgentActivityReference } from './SessionDiscussionAgentActivityReference';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useOpenSessionAgentConversation } from './useOpenSessionAgentConversation';
import { buildSessionDiscussionTimelineItems, resolveReadableVisibleDiscussionSeqs, resolveSessionDiscussionMessageAuthorLabel, type SessionDiscussionTimelineItem } from './sessionDiscussionTimelineProjection';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { isSelectableDiscussionMessage, prepareDiscussionSelectionHandoff } from './prepareDiscussionSelectionHandoff';
import { sendDiscussionSelectionToSession } from './sendDiscussionSelectionToSession';
import { SessionDiscussionComposer } from './SessionDiscussionComposer';
import { buildSessionDiscussionContent, resolveSessionDiscussionCreationTitle } from './discussionComposerDocument';
import { useSessionDiscussionDraft } from './useSessionDiscussionDraft';
import { formatSessionDiscussionPresenceLine } from './sessionDiscussionPresenceLine';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base },
    body: { flex: 1, paddingHorizontal: theme.space.s16, paddingTop: 18, gap: 14 },
    input: { minHeight: 46, borderWidth: 1, borderColor: theme.colors.border.default, borderRadius: 14, paddingHorizontal: 14, paddingVertical: theme.space.s10, backgroundColor: theme.colors.surface.inset, color: theme.colors.text.primary, fontSize: 16, fontWeight: '600' },
    presenceRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: theme.space.s8, minWidth: 0 },
    headerMeta: {  flexShrink: 1, color: theme.colors.text.secondary, ...Typography.variant('body') },
    messages: { flex: 1, minHeight: 0 },
    // Messages grouped by author (collab lab D1): the face, name and time open a group; the author's
    // next messages continue under it without repeating them. A selected message is tinted in place.
    message: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s10, marginHorizontal: theme.space.s8, paddingHorizontal: theme.space.s8, paddingTop: theme.space.s12, paddingBottom: theme.space.s2, borderRadius: 10, borderLeftWidth: 2, borderLeftColor: 'transparent' },
    messageGroupContinuation: { paddingTop: theme.space.s2 },
    messageSelected: { backgroundColor: theme.colors.state.active.background, borderLeftColor: theme.colors.state.active.foreground },
    messageFaceColumn: { width: 28, alignItems: 'center' },
    messageBody: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    messageAttribution: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space.s8 },
    messageAuthor: {  color: theme.colors.text.primary, ...Typography.variant('label', 'semiBold') },
    messageText: { ...Typography.default(), color: theme.colors.text.primary, fontSize: 15, lineHeight: 22 },
    mention: { ...Typography.default('semiBold'), color: theme.colors.state.active.foreground, backgroundColor: theme.colors.state.active.background, borderRadius: 4 },
    reference: { marginLeft: 46, marginRight: theme.space.s16, marginTop: theme.space.s6 },
    selectionToolbar: { position: 'absolute', left: 12, right: 12, bottom: 12 },
    meta: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
    timestamp: {  color: theme.colors.text.tertiary, ...Typography.variant('meta'), fontVariant: ['tabular-nums'] },
    selectAffordance: { alignSelf: 'center' },
    stateLine: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    deliveryStatus: { color: theme.colors.text.secondary, fontSize: 12 },
    error: { color: theme.colors.text.destructive, textAlign: 'center' },
    retry: { minHeight: minimumInteractiveTargetSize, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
    retryText: { color: theme.colors.accent.blue, fontWeight: '600' },
    banner: { paddingHorizontal: 14, paddingVertical: theme.space.s10, color: theme.colors.text.secondary },
    fieldHint: { color: theme.colors.text.destructive },
}));
const VIEWABILITY = Object.freeze({ itemVisiblePercentThreshold: 1 });
const NO_VIEWERS: readonly SessionHumanPresenceViewer[] = Object.freeze([]);
const PRESENCE_FACE_LIMIT = 3;
/** Retained last-known presence is quieter than live presence (the facepile's own de-emphasis). */
const STALE_PRESENCE_FACE_OPACITY = STALE_PRESENCE_OPACITY;

/**
 * One presenter for the typed refusal vocabulary the repository already
 * classifies: the reason a person can act on, not a generic "Failed".
 */
function discussionFailureLabel(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'locked': return t('session.access.preparing');
        case 'session_discussion_post_denied': return t('session.collaboration.discussion.postDenied');
        case 'session_discussion_manage_denied': return t('errors.permissionDenied');
        case 'session_discussion_invalid_mention': return t('session.collaboration.discussion.invalidMention');
        case 'session_discussion_invalid_content': return t('session.collaboration.discussion.invalidContent');
        case 'session_discussion_archived': return t('session.collaboration.discussion.archivedNotice');
        case 'session_discussion_session_archived': return t('session.collaboration.discussion.sessionArchived');
        case 'session_discussion_encryption_mode_mismatch': return t('session.collaboration.discussion.locked');
        case 'session_discussion_idempotency_conflict': return t('session.collaboration.discussion.idempotencyConflict');
        case 'session_discussions_unavailable': return t('session.collaboration.discussion.unavailable');
        default: return t('session.collaboration.discussion.sendFailed');
    }
}

function discussionLifecycleFailureLabel(
    outcome: Exclude<SessionDiscussionClientOutcome<SessionDiscussionDetailsResultV1>, { kind: 'succeeded' }>,
): string {
    return outcome.kind === 'failed' && outcome.errorCode === 'outcome_unknown'
        ? t('session.collaboration.discussion.deliveryUnknown')
        : discussionFailureLabel(outcome.kind === 'failed' ? outcome.errorCode : undefined);
}

function mutationStatusLabel(mutation: Pick<SessionDiscussionRepositoryMutation, 'status' | 'errorCode'>): string | null {
    if (mutation.status === 'observed_success') return null;
    if (mutation.status === 'outcome_unknown') return t('session.collaboration.discussion.deliveryUnknown');
    if (mutation.status === 'failed') return discussionFailureLabel(mutation.errorCode);
    if (mutation.status === 'approval_pending') return t('approvals.status.open');
    if (mutation.status === 'sending') return t('session.planOutput.sending');
    return t('session.collaboration.discussion.checking');
}

/** A dismissable refusal keeps its reason visible but no longer holds the composer. */
function mutationBlocksComposer(mutation: SessionDiscussionRepositoryMutation | null): boolean {
    return mutation !== null && !(mutation.status === 'failed' && mutation.recovery === 'dismiss');
}

function textOf(
    content: SessionDiscussionMessageContentV1 | null,
    resolveAccountLabel: (accountId: string) => string | null = () => null,
): string {
    if (!content) return t('session.collaboration.discussion.contentUnavailable');
    return content.parts.map((part) => part.t === 'text'
        ? part.text
        : `@${resolveAccountLabel(part.accountId) ?? t('session.collaboration.discussion.collaborator')}`
    ).join('');
}

/**
 * The message as the reader sees it: text as written, and each mention tinted and named. A message
 * without mentions stays one plain string.
 */
function renderDiscussionMessageContent(
    message: SessionDiscussionOpenedMessageV1,
    resolveAccountLabel: (accountId: string) => string | null,
): React.ReactNode {
    const content = message.content;
    if (!content || !content.parts.some((part) => part.t !== 'text')) return textOf(content, resolveAccountLabel);
    return content.parts.map((part, index) => part.t === 'text'
        ? part.text
        : <Text
            key={index}
            testID={`session-discussion-mention-${message.id}-${index}`}
            style={styles.mention}
        >{`@${resolveAccountLabel(part.accountId) ?? t('session.collaboration.discussion.collaborator')}`}</Text>);
}

function discussionMessageProducerClass(message: SessionDiscussionOpenedMessageV1): string {
    return message.producerV1 === null ? 'human' : `producer:${message.producerV1.kind}`;
}

function startsDiscussionMessageGroup(
    message: SessionDiscussionOpenedMessageV1,
    previous: SessionDiscussionOpenedMessageV1 | undefined,
): boolean {
    return !previous
        || message.authorAccountId === null
        || previous.authorAccountId === null
        || previous.authorAccountId !== message.authorAccountId
        || discussionMessageProducerClass(previous) !== discussionMessageProducerClass(message);
}

function useRepository(
    scope: ServerAccountScope,
    address: SessionAddress,
    accountLifetime: ServerCredentialAccountScopeBinding,
): readonly [SessionDiscussionRepository, ReturnType<SessionDiscussionRepository['getSnapshot']>] {
    const client = React.useMemo(() => createSessionDiscussionClient({ session: address, availability: 'available' }), [address]);
    const repository = React.useMemo(() => getSessionDiscussionRepository({
        scope,
        address,
        client,
        accountLifetime,
    }), [accountLifetime, address, client, scope]);
    const snapshot = useSessionDiscussionRepositorySnapshot(repository);
    React.useEffect(() => repository.mount(), [repository]);
    return [repository, snapshot];
}

export function SessionDiscussionDetailsView(props: Readonly<{
    target: SessionDiscussionDetailsTarget;
    /** True only while this Details surface is the one actually on screen (active tab, focused route). */
    active: boolean;
    /**
     * The host is itself the visible surface (the standalone mobile Discussion route),
     * so `active` alone states visibility. A Session-hosted Details pane leaves this
     * unset: it is visible only while its Session surface is.
     */
    standaloneSurface?: boolean;
    /** Leaves this conversation surface (the phone route goes back); Details closes its own tab. */
    onClose?: () => void;
    onCreated?: (discussion: SessionDiscussionOpenedSummaryV1) => void;
    onOpened?: (discussion: SessionDiscussionOpenedSummaryV1) => void;
}>): React.ReactElement {
    const requestedServerIds = React.useMemo(() => [props.target.address.serverId], [props.target.address.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const availability = useSessionCollaborationAvailability(props.target.address.serverId);
    const enabled = useFeatureEnabled('sessions.conversations', { scopeKind: 'spawn', serverId: props.target.address.serverId });
    if (!enabled || availability !== 'available' || !binding) {
        return <SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="unavailable"
            title={t('sessionConversation.discussion.unavailableTitle')}
            reason={t('session.collaboration.discussion.unavailable')}
        />;
    }
    return props.target.kind === 'new'
        ? <NewDiscussion target={props.target} scope={binding.scope} accountLifetime={binding} onCreated={props.onCreated} />
        : <Discussion target={props.target} scope={binding.scope} accountLifetime={binding} active={props.active} standaloneSurface={props.standaloneSurface === true} onClose={props.onClose} onOpened={props.onOpened} />;
}

function NewDiscussion(props: Readonly<{ target: Extract<SessionDiscussionDetailsTarget, { kind: 'new' }>; scope: ServerAccountScope; accountLifetime: ServerCredentialAccountScopeBinding; onCreated?: (discussion: SessionDiscussionOpenedSummaryV1) => void }>) {
    const draftAddress = React.useMemo(() => ({ kind: 'newDiscussion' as const, sessionId: props.target.address.sessionId }), [props.target.address.sessionId]);
    const draft = useSessionDiscussionDraft({ scope: props.scope, address: draftAddress });
    // Only a stated refusal from the exact Session's own access projection
    // annotates this flow; an unloaded Session or an absent projection keeps it
    // usable with the server as the authority. A write downgrade is not access
    // loss, so the private draft is retained rather than purged.
    const session = useSessionViewShellSession(props.target.address.sessionId, props.target.address.serverId);
    const createDenied = isSessionWriteKnownDenied(session);
    const [repository, snapshot] = useRepository(props.scope, props.target.address, props.accountLifetime);
    const restoredAttempt = draft.pendingMutationAttempt?.kind === 'create' ? draft.pendingMutationAttempt : null;
    const ids = React.useRef({
        creationLocalId: restoredAttempt?.creationLocalId ?? randomUUID(),
        messageLocalId: restoredAttempt?.messageLocalId ?? randomUUID(),
    });
    const capture = React.useRef<ReturnType<typeof draft.captureSubmittedCurrentness> | null>(null);
    const completed = React.useRef(false);
    const [titleRequired, setTitleRequired] = React.useState(false);
    const recoveredMutation = Object.values(snapshot.mutations).find((item) => item.kind === 'create') ?? null;
    const activeCreationLocalId = recoveredMutation?.localId ?? ids.current.creationLocalId;
    const mutation = snapshot.mutations[activeCreationLocalId] ?? null;
    const composerBlocked = mutationBlocksComposer(mutation);
    const accessRevoked = snapshot.lists.active.status === 'revoked' || snapshot.lists.archived.status === 'revoked';
    const draftUnavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict';
    const repositoryUnavailable = snapshot.lists.active.status === 'offline'
        || snapshot.lists.active.status === 'locked'
        || snapshot.lists.active.status === 'error';
    const createDisabled = composerBlocked || draftUnavailable || repositoryUnavailable || createDenied;
    const createUnavailableLabel = createDenied
        ? t('session.collaboration.discussion.postDenied')
        : draft.status === 'offline' || snapshot.lists.active.status === 'offline'
            ? t('session.collaboration.discussion.offline')
            : snapshot.lists.active.status === 'locked'
                ? t('session.access.preparing')
                // The draft is retained locally and the conversation still works:
                // the only lost capability is syncing this draft to other devices.
                : draft.status === 'unsupported'
                    ? t('sessionDrafts.status.unsupported')
                    : draft.status === 'error' || snapshot.lists.active.status === 'error'
                        ? t('session.collaboration.discussion.loadError')
                        : null;
    React.useEffect(() => {
        if (accessRevoked) void draft.purgePresentation();
    }, [accessRevoked, draft]);
    const finish = React.useCallback(async (discussion: SessionDiscussionOpenedSummaryV1) => {
        if (completed.current) return;
        completed.current = true;
        const submitted = repository.getSnapshot().mutations[activeCreationLocalId]?.draftSubmission ?? capture.current;
        try {
            if (submitted) await draft.clearAfterObservedSuccess(submitted);
        } catch {
            completed.current = false;
            return;
        }
        repository.acknowledgeObservedSuccess(activeCreationLocalId);
        props.onCreated?.(discussion);
    }, [activeCreationLocalId, draft, props, repository]);
    React.useEffect(() => {
        const found = [...snapshot.lists.active.items, ...snapshot.lists.archived.items].find((item) => item.creationLocalId === activeCreationLocalId);
        if (found) void finish(found);
    }, [activeCreationLocalId, finish, snapshot.lists.active.items, snapshot.lists.archived.items]);
    React.useEffect(() => {
        if (!restoredAttempt || snapshot.mutations[restoredAttempt.creationLocalId]) return;
        const title = resolveSessionDiscussionCreationTitle({ title: draft.title, text: draft.text, mentions: draft.mentions });
        if (!title) return;
        repository.adoptPendingIntent({
            kind: 'create',
            creationLocalId: restoredAttempt.creationLocalId,
            messageLocalId: restoredAttempt.messageLocalId,
            title,
            content: buildSessionDiscussionContent(draft.text, draft.mentions),
            mentionedAccountIds: [...new Set(draft.mentions.map((item) => item.accountId))],
            draftSubmission: { scope: props.scope, address: draftAddress, currentness: restoredAttempt.currentness },
        });
    }, [draft.mentions, draft.text, draft.title, draftAddress, props.scope, repository, restoredAttempt, snapshot.mutations]);
    const dismissRefusal = React.useCallback(() => {
        if (mutation?.status !== 'failed') return;
        draft.releaseSubmittedAttempt();
        repository.dismissFailure(mutation.localId);
        // A refused identity is never reused: the retained draft goes out as a fresh attempt.
        ids.current = { creationLocalId: randomUUID(), messageLocalId: randomUUID() };
    }, [draft, mutation, repository]);
    const submit = React.useCallback(async (content: SessionDiscussionMessageContentV1) => {
        if (!draft.text.trim() || composerBlocked) return;
        const title = resolveSessionDiscussionCreationTitle({
            title: draft.title,
            text: draft.text,
            mentions: draft.mentions,
        });
        if (!title) {
            setTitleRequired(true);
            return;
        }
        setTitleRequired(false);
        if (mutation) dismissRefusal();
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'create', ...ids.current });
        capture.current = draftSubmission;
        await repository.create({ ...ids.current, title, content, mentionedAccountIds: [...new Set(draft.mentions.map((item) => item.accountId))], draftSubmission });
    }, [composerBlocked, dismissRefusal, draft, mutation, repository]);
    if (accessRevoked) {
        return <SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
        />;
    }
    return <View style={styles.root} testID="session-discussion-new-details"><View style={styles.body}><TextInput testID="session-discussion-title" style={styles.input} value={draft.title} onChangeText={(title) => { draft.setTitle(title); if (title.trim()) setTitleRequired(false); }} placeholder={t('session.collaboration.discussion.titlePlaceholder')} accessibilityLabel={t('session.collaboration.discussion.titlePlaceholder')} aria-invalid={titleRequired} autoFocus />{titleRequired ? <Text testID="session-discussion-title-required" accessibilityLiveRegion="polite" style={styles.fieldHint}>{t('session.collaboration.discussion.titleRequired')}</Text> : null}{mutation?.content ? <View style={styles.message}><View style={styles.messageBody}><Text testID={`session-discussion-message-content-${mutation.messageLocalId}`}>{textOf(mutation.content)}</Text>{mutationStatusLabel(mutation) ? <Text testID={`session-discussion-message-status-${mutation.messageLocalId}`} accessibilityLiveRegion="polite" style={mutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(mutation)}</Text> : null}<MutationRecovery mutation={mutation} onRetry={() => void repository.retry(activeCreationLocalId)} onDismiss={dismissRefusal} /></View></View> : null}</View>{draft.conflict ? <SessionDraftConflictResolution scope={props.scope} address={draftAddress} conflict={draft.conflict} /> : null}{createUnavailableLabel ? <Text style={styles.banner}>{createUnavailableLabel}</Text> : null}<SessionDiscussionComposer scope={props.scope} address={props.target.address} availability="available" value={{ text: draft.text, mentions: draft.mentions }} onChange={draft.setComposer} disabled={createDisabled} onSend={(content) => void submit(content)} /></View>;
}

function Discussion(props: Readonly<{ target: Extract<SessionDiscussionDetailsTarget, { kind: 'discussion' }>; scope: ServerAccountScope; accountLifetime: ServerCredentialAccountScopeBinding; active: boolean; standaloneSurface: boolean; onClose?: () => void; onOpened?: (discussion: SessionDiscussionOpenedSummaryV1) => void }>) {
    const router = useRouter();
    const device = useDeviceType();
    const session = useSessionViewShellSession(props.target.address.sessionId, props.target.address.serverId);
    const { canLaunchExecutionRuns } = useSessionExecutionRunLaunchability(props.target.address.sessionId, session, props.target.address.serverId);
    const pane = useAppPaneScope(useDestinationPaneScopeId(createSessionPaneScopeId(props.target.address.sessionId, props.target.address.serverId)));
    const activity = useSessionAgentActivityRoster({
        sessionId: props.target.address.sessionId,
        serverId: props.target.address.serverId,
    });
    const presenceTarget = React.useMemo(() => ({
        serverId: props.target.address.serverId,
        sessionId: props.target.address.sessionId,
        discussionId: props.target.discussionId,
    }), [props.target.address.serverId, props.target.address.sessionId, props.target.discussionId]);
    const presence = useSessionHumanPresence(presenceTarget);
    // The one presence-name owner, as in the facepile and Viewing now: a retained
    // last-known observation keeps its names, says so, and makes no typing claim.
    const presenceStale = presence.status === 'stale';
    const presentViewers = presence.viewers.length === 0 || (presence.status !== 'live' && !presenceStale)
        ? NO_VIEWERS
        : presence.viewers;
    const presenceLabel = React.useMemo(
        () => formatSessionDiscussionPresenceLine(presentViewers, { stale: presenceStale }),
        [presenceStale, presentViewers],
    );
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const sendTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const draftAddress = React.useMemo(() => ({ kind: 'discussion' as const, sessionId: props.target.address.sessionId, discussionId: props.target.discussionId }), [props.target.address.sessionId, props.target.discussionId]);
    const draft = useSessionDiscussionDraft({ scope: props.scope, address: draftAddress });
    const agentConversation = useOpenSessionAgentConversation({ address: props.target.address });
    const [repository, snapshot] = useRepository(props.scope, props.target.address, props.accountLifetime);
    const thread = snapshot.threads[props.target.discussionId];
    const discussion = thread?.summary ?? null;
    // A discussion opened from a link, an Activity item or a mention carries no title yet, so
    // its Details tab shows the generic label. Report the opened summary through the same
    // channel creation uses; the tab owner replaces the tab under its existing key.
    const onOpenedRef = React.useRef(props.onOpened);
    onOpenedRef.current = props.onOpened;
    const openedTitle = discussion?.title ?? null;
    useDestinationPageTitle(props.standaloneSurface ? openedTitle : undefined);
    React.useEffect(() => {
        if (!discussion || !openedTitle) return;
        onOpenedRef.current?.(discussion);
        // The summary identity that matters here is the discussion and its current title.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [discussion?.id, openedTitle]);
    const messages = thread?.messages ?? [];
    // The viewer's own unacknowledged message is authored with their scoped profile, not "Collaborator".
    const viewerProfile = useShareViewerProfile(props.scope);
    const viewer = React.useMemo(() => ({ accountId: props.scope.accountId, profile: viewerProfile }), [props.scope.accountId, viewerProfile]);
    const historicalActorLabels = React.useMemo(() => new Map(messages.flatMap((message) => {
        const actor = message.accountActor;
        if (actor === null || actor.accountId !== message.authorAccountId) return [];
        return [[actor.accountId, resolveSessionDiscussionMessageAuthorLabel(message)] as const];
    })), [messages]);
    const resolveAccountLabel = React.useCallback((accountId: string): string | null => {
        const historicalLabel = historicalActorLabels.get(accountId);
        if (historicalLabel) return historicalLabel;
        const viewer = presence.viewers.find((item) => item.account.accountId === accountId);
        return viewer ? formatAccountDisplayName(viewer.account) ?? t('session.collaboration.unnamed') : null;
    }, [historicalActorLabels, presence.viewers]);
    const selectableMessages = React.useMemo<readonly TranscriptSelectionToolbarMessage[]>(() => messages
        .filter(isSelectableDiscussionMessage)
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
        .map((message) => ({ id: message.id, role: 'user' as const, text: textOf(message.content, resolveAccountLabel) })), [messages, resolveAccountLabel]);
    const prepareSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => prepareDiscussionSelectionHandoff({
        sessionId: props.target.address.sessionId,
        discussionId: props.target.discussionId,
        selectedMessageIds: selected.map((message) => message.id),
        messages,
        resolveAccountLabel,
        format: transcriptBulkCopyFormat,
        roleLabels: { user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') },
        agentAttributionLabel: t('session.collaboration.discussion.viaAgent'),
    }), [messages, props.target.address.sessionId, props.target.discussionId, resolveAccountLabel, transcriptBulkCopyFormat]);
    const [localId, setLocalId] = React.useState<string | null>(null);
    const clearingLocalId = React.useRef<string | null>(null);
    const recoveredPostMutation = Object.values(snapshot.mutations).find((item) => item.kind === 'post' && item.discussionId === props.target.discussionId) ?? null;
    const restoredPostAttempt = draft.pendingMutationAttempt?.kind === 'post'
        && draft.pendingMutationAttempt.discussionId === props.target.discussionId
        ? draft.pendingMutationAttempt
        : null;
    const activePostLocalId = recoveredPostMutation?.localId ?? localId;
    const mutation = activePostLocalId ? snapshot.mutations[activePostLocalId] ?? null : null;
    const composerBlocked = mutationBlocksComposer(mutation);
    const accessRevoked = snapshot.lists.active.status === 'revoked'
        || snapshot.lists.archived.status === 'revoked'
        || thread?.status === 'revoked';
    React.useEffect(() => props.active && !accessRevoked
        ? registerSessionDiscussionHumanPresence(presenceTarget)
        : undefined, [accessRevoked, presenceTarget, props.active]);
    const draftUnavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict';
    const threadUnavailable = thread?.status === 'offline' || thread?.status === 'locked' || thread?.status === 'error';
    const mutationsDisabled = draftUnavailable || threadUnavailable;
    React.useEffect(() => {
        if (accessRevoked) void draft.purgePresentation();
    }, [accessRevoked, draft]);
    const [rename, setRename] = React.useState<string | null>(null);
    const [lifecycleFailure, setLifecycleFailure] = React.useState<Readonly<{
        operation: 'rename' | 'archive' | 'restore';
        outcome: Exclude<SessionDiscussionClientOutcome<SessionDiscussionDetailsResultV1>, { kind: 'succeeded' }>;
    }> | null>(null);
    React.useEffect(() => { void repository.refreshDiscussion(props.target.discussionId); }, [props.target.discussionId, repository]);
    React.useEffect(() => {
        if (!restoredPostAttempt || snapshot.mutations[restoredPostAttempt.localId]) return;
        repository.adoptPendingIntent({
            kind: 'post',
            discussionId: props.target.discussionId,
            localId: restoredPostAttempt.localId,
            content: buildSessionDiscussionContent(draft.text, draft.mentions),
            mentionedAccountIds: [...new Set(draft.mentions.map((item) => item.accountId))],
            draftSubmission: { scope: props.scope, address: draftAddress, currentness: restoredPostAttempt.currentness },
        });
        setLocalId(restoredPostAttempt.localId);
    }, [draft.mentions, draft.text, draftAddress, props.scope, props.target.discussionId, repository, restoredPostAttempt, snapshot.mutations]);
    React.useEffect(() => {
        if (!activePostLocalId || mutation?.status !== 'observed_success' || !messages.some((item) => item.localId === activePostLocalId) || clearingLocalId.current === activePostLocalId) return;
        clearingLocalId.current = activePostLocalId;
        void (async () => {
            try {
                await draft.clearAfterObservedSuccess(mutation.draftSubmission);
                repository.acknowledgeObservedSuccess(activePostLocalId);
                setLocalId(null);
            } catch {
                // Keep the observed-success mutation so a remount can retry the
                // same V2 draft-currentness contraction without resending.
            } finally {
                if (clearingLocalId.current === activePostLocalId) clearingLocalId.current = null;
            }
        })();
    }, [activePostLocalId, draft, messages, mutation, repository]);
    const dismissRefusal = React.useCallback(() => {
        if (mutation?.status !== 'failed') return;
        draft.releaseSubmittedAttempt();
        repository.dismissFailure(mutation.localId);
        setLocalId(null);
    }, [draft, mutation, repository]);
    const send = React.useCallback(async (content: SessionDiscussionMessageContentV1) => {
        if (!discussion?.capabilities.postMessages || !draft.text.trim() || composerBlocked) return;
        if (mutation) dismissRefusal();
        const id = randomUUID();
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'post', discussionId: props.target.discussionId, localId: id });
        setLocalId(id);
        await repository.post({ discussionId: props.target.discussionId, localId: id, content, mentionedAccountIds: [...new Set(draft.mentions.map((item) => item.accountId))], draftSubmission });
    }, [composerBlocked, discussion?.capabilities.postMessages, dismissRefusal, draft, mutation, props.target.discussionId, repository]);
    const lifecycle = React.useCallback(async (kind: 'rename' | 'archive' | 'restore') => {
        if (!discussion) return; setLifecycleFailure(null);
        const result = kind === 'rename' ? await repository.rename(discussion.id, rename?.trim() ?? '') : kind === 'archive' ? await repository.archive(discussion.id) : await repository.restore(discussion.id);
        if (result.kind === 'succeeded') setRename(null); else setLifecycleFailure({ operation: kind, outcome: result });
    }, [discussion, rename, repository]);
    const lifecycleActions = React.useMemo<readonly PageHeaderMenuAction[]>(() => discussion ? [
        ...(discussion.capabilities.rename ? [{ id: 'rename', title: t('session.collaboration.discussion.rename'), disabled: mutationsDisabled, onSelect: () => setRename(discussion.title ?? '') }] : []),
        ...(discussion.capabilities.archive ? [{ id: 'archive', title: t('session.collaboration.discussion.archive'), disabled: mutationsDisabled, onSelect: () => lifecycle('archive') }] : []),
        ...(discussion.capabilities.restore ? [{ id: 'restore', title: t('session.collaboration.discussion.restore'), disabled: mutationsDisabled, onSelect: () => lifecycle('restore') }] : []),
    ] : [], [discussion, lifecycle, mutationsDisabled]);
    const displayMessages = React.useMemo<readonly SessionDiscussionOpenedMessageV1[]>(() => {
        if (!mutation?.content || mutation.status === 'observed_success' || messages.some((message) => message.localId === mutation.localId)) return messages;
        return [...messages, {
            id: mutation.localId,
            discussionId: props.target.discussionId,
            localId: mutation.localId,
            seq: (messages.at(-1)?.seq ?? thread?.messageSeq ?? 0) + 1,
            authorAccountId: props.scope.accountId,
            accountActor: null,
            producerV1: null,
            content: mutation.content,
            mentionedAccountIds: [...(mutation.mentionedAccountIds ?? [])],
            createdAt: 0,
        }];
    }, [messages, mutation, props.scope.accountId, props.target.discussionId, thread?.messageSeq]);
    const items = React.useMemo(() => buildSessionDiscussionTimelineItems({ sessionId: props.target.address.sessionId, discussionId: props.target.discussionId, messages: displayMessages, subagents: activity.subagents, readExecutionRunEntry: activity.readExecutionRunEntry }), [activity.readExecutionRunEntry, activity.subagents, displayMessages, props.target.address.sessionId, props.target.discussionId]);
    const messageGroupStarts = React.useMemo(() => new Set(items.flatMap((item, index) => {
        if (item.kind !== 'human_message') return [];
        const previous = items[index - 1];
        return previous?.kind !== 'human_message' || startsDiscussionMessageGroup(item.message, previous.message)
            ? [item.message.id]
            : [];
    })), [items]);
    const openRun = React.useCallback((item: Extract<SessionDiscussionTimelineItem, { kind: 'agent_activity_reference' }>) => {
        const runId = item.entry.runId ?? item.subagent.runRef?.runId;
        if (runId) agentConversation.openAgentConversation(runId, resolveSessionAgentActivityPresentation({ entry: item.entry, subagent: item.subagent }).title);
    }, [agentConversation]);
    const askAgentAboutSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => {
        const prepared = prepareSelection(selected);
        if (!prepared) return;
        const source = { ...prepared.source, draftCorrelationId: randomUUID() };
        if (device === 'phone') {
            const navigationIntent = publishInteractiveExecutionRunDraftNavigationIntent({
                address: props.target.address,
                source,
                initialText: prepared.text,
            });
            router.push(navigationIntent.href as Href);
            return;
        }
        pane.openDetailsTab(createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({
            source,
            initialText: prepared.text,
        }), { intent: 'preview' });
    }, [device, pane, prepareSelection, props.target.address, router]);
    type PreparedSelectionHandoff = NonNullable<ReturnType<typeof prepareSelection>>;
    const [selectionHandoffRetry, setSelectionHandoffRetry] = React.useState<PreparedSelectionHandoff | null>(null);
    const [selectionHandoffRetrying, setSelectionHandoffRetrying] = React.useState(false);
    const selectionHandoffInFlight = React.useRef<Promise<void> | null>(null);
    const performSelectionHandoff = React.useCallback(async (prepared: PreparedSelectionHandoff) => {
        if (selectionHandoffInFlight.current) {
            await selectionHandoffInFlight.current;
            return;
        }
        const operation = sendDiscussionSelectionToSession({
            sessionId: props.target.address.sessionId,
            serverId: props.target.address.serverId,
            selectedText: prepared.text,
            source: prepared.source,
            template: sendTemplate,
            sourceSessionName: null,
            nowMs: Date.now,
            writeInitialPrompt: async ({ destinationSessionId, serverId, prompt }) => {
                await sync.patchSessionMetadataWithRetry(destinationSessionId, (metadata) => writeSessionInitialPromptV1({
                    metadata,
                    text: prompt.text,
                    mode: prompt.mode,
                    createdAtMs: prompt.createdAtMs,
                    source: prompt.source,
                }), { serverId });
            },
            revealPrimaryComposer: device === 'phone'
                ? () => router.replace(buildScopedSessionRouteHref(props.target.address) as Href)
                : pane.closeDetails,
            focusPrimaryComposer: () => requestRegisteredSessionComposerFocus(props.target.address),
        }).then(() => undefined);
        selectionHandoffInFlight.current = operation;
        try {
            await operation;
        } finally {
            if (selectionHandoffInFlight.current === operation) {
                selectionHandoffInFlight.current = null;
            }
        }
    }, [device, pane.closeDetails, props.target.address, router, sendTemplate]);
    const sendSelectionToComposer = React.useCallback(async (selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => {
        const prepared = prepareSelection(selected);
        if (!prepared) return;
        try {
            await performSelectionHandoff(prepared);
            setSelectionHandoffRetry(null);
        } catch {
            setSelectionHandoffRetry(prepared);
        }
    }, [performSelectionHandoff, prepareSelection]);
    const retrySelectionHandoff = React.useCallback(async () => {
        if (!selectionHandoffRetry || selectionHandoffRetrying) return;
        setSelectionHandoffRetrying(true);
        try {
            await performSelectionHandoff(selectionHandoffRetry);
            setSelectionHandoffRetry(null);
        } catch {
            // The immutable prepared selection stays available for another explicit retry.
        } finally {
            setSelectionHandoffRetrying(false);
        }
    }, [performSelectionHandoff, selectionHandoffRetry, selectionHandoffRetrying]);
    const observation = React.useMemo(() => createWebDomScrollObservation(), []);
    const frame = React.useMemo(() => resolveReadOnlyTranscriptListShellFrame({ accessKind: 'public', bottomNoticeVisible: false, platformOS: Platform.OS }), []);
    const dataKey = React.useMemo(() => `discussion:${sessionAddressKey(props.target.address)}:${props.target.discussionId}`, [props.target.address, props.target.discussionId]);
    const hostViewed = useHostActivelyViewed(); const visibility = useSessionSurfaceVisibilitySnapshot();
    const surfaceVisible = React.useMemo(() => isSessionSurfaceVisible(props.target.address.sessionId, props.target.address.serverId), [props.target.address.serverId, props.target.address.sessionId, visibility]);
    const read = React.useMemo(() => createSessionDiscussionVisibleReadController({
        writeCursor: (seq) => repository.setReadState(props.target.discussionId, seq),
    }), [props.target.discussionId, repository]);
    React.useEffect(() => read.updateEligibility({
        activeAndVisible: props.active && hostViewed && (props.standaloneSurface || surfaceVisible),
        lastReadSeq: discussion?.lastReadSeq ?? null,
    }), [discussion?.lastReadSeq, hostViewed, props.active, props.standaloneSurface, read, surfaceVisible, thread?.status]);
    // The rows the list last reported on screen. Readability can change while a row
    // stays visible (a locked placeholder opens once the Session key arrives), which
    // produces no new viewability callback, so admission is re-evaluated from here.
    const [visibleMessageIds, setVisibleMessageIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const onVisible = React.useCallback((info: Readonly<{ viewableItems: readonly ViewToken<SessionDiscussionTimelineItem>[] }>) => {
        setVisibleMessageIds(new Set(info.viewableItems.flatMap((token) => (
            token.isViewable !== false && token.item?.kind === 'human_message' ? [token.item.message.id] : []
        ))));
    }, []);
    const readableVisibleSeqs = React.useMemo(
        () => resolveReadableVisibleDiscussionSeqs({ messages, visibleMessageIds, lastReadSeq: discussion?.lastReadSeq ?? null }),
        [discussion?.lastReadSeq, messages, visibleMessageIds],
    );
    // Also re-observed when the surface itself becomes visible: rows already on screen
    // at that moment are seen then, although the list reports no new viewability.
    React.useEffect(
        () => read.observeVisibleMessageSeqs(readableVisibleSeqs),
        [hostViewed, props.active, props.standaloneSurface, read, readableVisibleSeqs, surfaceVisible],
    );
    const closeSurface = React.useCallback(() => {
        if (props.onClose) {
            props.onClose();
            return;
        }
        pane.closeDetailsTab(createSessionDiscussionDetailsTab(props.target).key);
    }, [pane, props.onClose, props.target]);
    const retryDiscussion = React.useCallback(() => repository.refreshDiscussion(props.target.discussionId), [props.target.discussionId, repository]);
    const retryAction = React.useMemo(() => ({ label: t('session.collaboration.discussion.retry'), onPress: retryDiscussion }), [retryDiscussion]);
    if (accessRevoked) {
        return <SurfaceStateCard
            testID="session-discussion-details-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
            action={{ label: t('sessionConversation.discussion.closeTab'), onPress: closeSurface }}
        />;
    }
    if (!thread || thread.status === 'idle' || (thread.status === 'loading' && !discussion)) {
        return <SurfaceStateCard testID="session-discussion-details-state" kind="loading" title={t('sessionConversation.discussion.loadingTitle')} />;
    }
    if (!discussion) {
        const status = thread.status;
        if (status === 'offline') {
            return <SurfaceStateCard
                testID="session-discussion-details-state"
                kind="unavailable"
                title={t('sessionConversation.discussion.offlineTitle')}
                reason={t('sessionConversation.discussion.offlineReason')}
                action={retryAction}
            />;
        }
        if (status === 'locked') {
            return <SurfaceStateCard
                testID="session-discussion-details-state"
                kind="error"
                title={t('sessionConversation.discussion.lockedTitle')}
                reason={t('sessionConversation.discussion.lockedReason')}
                action={retryAction}
                diagnosticCode={thread.errorCode ?? 'locked'}
            />;
        }
        return <SurfaceStateCard
            testID="session-discussion-details-state"
            kind="error"
            title={t('sessionConversation.discussion.errorTitle')}
            reason={discussionFailureLabel(thread.errorCode ?? undefined)}
            action={retryAction}
            diagnosticCode={thread.errorCode ?? null}
        />;
    }
    // Retained content stays at full strength; a failed or offline refresh is one line under the
    // header with its Retry, never a second state over the messages.
    const threadStaleLabel = thread.status === 'offline'
        ? t('session.collaboration.discussion.offline')
        : thread.status === 'locked'
            ? t('session.access.preparing')
            : thread.status === 'error'
                ? t('session.collaboration.discussion.loadError')
                : null;
    const operationNotice = lifecycleFailure
        ? discussionLifecycleFailureLabel(lifecycleFailure.outcome)
        : threadStaleLabel === null && draft.status === 'offline'
            ? t('session.collaboration.discussion.offline')
            : draft.status === 'unsupported'
                ? t('sessionDrafts.status.unsupported')
                : draft.status === 'error'
                    ? t('session.collaboration.discussion.loadError')
                    : null;
    return <TranscriptMessageSelectionBoundary sessionId={dataKey} eligibleMessageIdsInOrder={selectableMessages.map((message) => message.id)}>
        <View style={styles.root} testID="session-discussion-details">
            <DetailsTabHeader
                testID="session-discussion-header"
                title={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
                metaLeading={presenceLabel ? <View style={styles.presenceRow}>
                            <DiscussionPresenceFaces viewers={presentViewers} stale={presenceStale} />
                            <Text testID="session-discussion-presence" accessibilityLiveRegion="polite" style={styles.headerMeta} numberOfLines={1}>{presenceLabel}</Text>
                </View> : null}
                controls={rename !== null ? <TextInput testID="session-discussion-rename-input" style={[styles.input, { flex: 1 }]} value={rename} onChangeText={setRename} accessibilityLabel={t('session.collaboration.discussion.rename')} autoFocus /> : undefined}
                buttons={rename !== null ? [{ label: t('common.save'), disabled: !rename.trim() || mutationsDisabled, onPress: () => void lifecycle('rename') }] : undefined}
                menu={rename === null && lifecycleActions.length > 0 ? <PageHeaderMenu triggerTestID="session-discussion-actions-menu" actions={lifecycleActions} /> : undefined}
            />
            {threadStaleLabel ? <SurfaceFreshnessLine
                testID="session-discussion-freshness"
                reason={threadStaleLabel}
                tone={thread.status === 'offline' ? 'neutral' : 'warning'}
                action={retryAction}
            /> : null}
            {operationNotice ? <View style={styles.stateLine}>
                <SurfaceStateCard testID="session-discussion-notice" size="line" kind={lifecycleFailure ? 'error' : 'warning'} title={operationNotice} />
            </View> : null}
            {draft.conflict ? <SessionDraftConflictResolution scope={props.scope} address={draftAddress} conflict={draft.conflict} /> : null}
            <View style={styles.messages}>
                <TranscriptListShell<SessionDiscussionTimelineItem>
                    key={dataKey}
                    dataKey={dataKey}
                    data={items}
                    frame={frame}
                    webDomObservation={observation}
                    keyExtractor={(item) => item.kind === 'human_message' ? `message:${item.message.localId ?? item.message.id}` : `run:${item.entry.runId ?? item.subagent.id}`}
                    onViewableItemsChanged={onVisible}
                    viewabilityConfig={VIEWABILITY}
                    onStartReached={thread.hasMoreOlder ? () => void repository.loadOlderMessages(props.target.discussionId) : undefined}
                    onStartReachedThreshold={0.2}
                    header={thread.hasMoreOlder ? <Pressable style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.loadOlder')} onPress={() => void repository.loadOlderMessages(props.target.discussionId)}><Text style={styles.retryText}>{t('session.collaboration.discussion.loadOlder')}</Text></Pressable> : null}
                    footer={items.length === 0 ? <SurfaceStateCard testID="session-discussion-empty" kind="empty" title={t('session.collaboration.discussion.emptyActive')} /> : null}
                    renderItem={({ item }) => {
                        if (item.kind === 'agent_activity_reference') {
                            return <View style={styles.reference}>
                                <SessionDiscussionAgentActivityReference entry={item.entry} subagent={item.subagent} onPress={() => openRun(item)} />
                            </View>;
                        }
                        const pendingMutation = item.message.localId === mutation?.localId ? mutation : null;
                        return <DiscussionMessageRow
                            message={item.message}
                            authorLabel={resolveSessionDiscussionMessageAuthorLabel(item.message, viewer)}
                            startsGroup={messageGroupStarts.has(item.message.id)}
                            selectable={isSelectableDiscussionMessage(item.message) && item.message.id !== mutation?.localId}
                            resolveAccountLabel={resolveAccountLabel}
                            footer={pendingMutation ? <>
                                {mutationStatusLabel(pendingMutation) ? <Text testID={`session-discussion-message-status-${item.message.localId}`} accessibilityLiveRegion="polite" style={pendingMutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(pendingMutation)}</Text> : null}
                                <MutationRecovery mutation={pendingMutation} onRetry={() => void repository.retry(pendingMutation.localId)} onDismiss={dismissRefusal} />
                            </> : null}
                        />;
                    }}
                />
                {/* The shared selection bar floats over the thread's foot (collab lab D1), so it never
                    reserves a band of its own while nothing is selected. */}
                <View pointerEvents="box-none" style={styles.selectionToolbar}>
                <TranscriptSelectionToolbar selectableMessagesInOrder={selectableMessages} bulkCopyFormat={transcriptBulkCopyFormat} roleLabels={{ user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') }} sendToSessionEnabled={discussion.capabilities.sendToSession} onSendToSession={sendSelectionToComposer} formatSelection={(selected) => prepareSelection(selected)?.text ?? null} selectionUnavailableText={t('session.collaboration.discussion.contentUnavailable')} additionalAction={discussion.capabilities.askAgent && canLaunchExecutionRuns ? { testID: 'session-discussion-selection-ask-agent', label: t('session.collaboration.discussion.selection.askAgent'), onPress: askAgentAboutSelection } : undefined} />
            </View>
            </View>
            {selectionHandoffRetry ? <View style={styles.stateLine}><SurfaceStateCard
                testID="session-discussion-selection-handoff-error"
                size="line"
                kind="error"
                accessibilitySemantics="status"
                title={t('session.collaboration.discussion.selection.handoffError')}
                action={{ testID: 'session-discussion-selection-handoff-retry', label: t('common.retry'), onPress: retrySelectionHandoff, disabled: selectionHandoffRetrying, busy: selectionHandoffRetrying }}
            /></View> : null}
            {discussion.archivedAt !== null
                ? <View style={styles.stateLine}><SurfaceStateCard testID="session-discussion-archived" size="line" kind="unavailable" iconName="archive" title={t('session.collaboration.discussion.archivedNotice')} /></View>
                : discussion.capabilities.postMessages
                    ? <SessionDiscussionComposer scope={props.scope} address={props.target.address} discussionId={props.target.discussionId} availability="available" value={{ text: draft.text, mentions: draft.mentions }} onChange={draft.setComposer} disabled={composerBlocked || mutationsDisabled} onSend={(content) => void send(content)} />
                    : <View style={styles.stateLine}><SurfaceStateCard testID="session-discussion-read-only" size="line" kind="denied" title={t('session.collaboration.discussion.locked')} /></View>}
        </View>
    </TranscriptMessageSelectionBoundary>;
}

/** The faces of the people in this conversation right now; the names are read from the line beside. */
const DiscussionPresenceFaces = React.memo((props: Readonly<{ viewers: readonly SessionHumanPresenceViewer[]; stale: boolean }>) => {
    if (props.viewers.length === 0) return null;
    return <View
        testID="session-discussion-presence-faces"
        accessible
        accessibilityLabel={formatSessionPresenceViewerNames(props.viewers, { stale: props.stale })}
        style={props.stale ? { opacity: STALE_PRESENCE_FACE_OPACITY } : undefined}
    >
        <AvatarStack size={20} entries={props.viewers.slice(0, PRESENCE_FACE_LIMIT).map((viewer) => ({
            key: viewer.account.accountId,
            content: <Avatar id={viewer.account.accountId} imageUrl={viewer.account.avatarUrl} size={20} />,
        }))} />
    </View>;
});

/**
 * One message in a conversation. A leaf with its own selection subscription, so selecting one row
 * re-renders that row alone.
 */
const DiscussionMessageRow = React.memo((props: Readonly<{
    message: SessionDiscussionOpenedMessageV1;
    startsGroup: boolean;
    selectable: boolean;
    resolveAccountLabel: (accountId: string) => string | null;
    authorLabel: string;
    footer: React.ReactNode;
}>) => {
    const { message } = props;
    const selection = useOptionalTranscriptSelectionRow(message.id);
    // The transcript's one row-action policy: on a fine pointer the select mark waits for hover, focus
    // or selection mode, so the conversation reads as messages rather than a column of checkboxes.
    const hover = useRowActionHoverHost();
    const selectRevealed = shouldShowTranscriptRowActions({
        platformOS: Platform.OS,
        isRowHovered: hover.isHovered,
        isActionHovered: false,
        coarsePrimaryPointer: readCoarsePrimaryPointer(),
        selectionModeActive: selection.isSelectionMode,
    });
    const actor = message.accountActor;
    const faceAccountId = actor !== null && actor.accountId === message.authorAccountId ? actor.accountId : message.authorAccountId;
    return <View
        testID={`session-discussion-message-group-${props.startsGroup ? 'start' : 'continuation'}-${message.id}`}
        style={[styles.message, !props.startsGroup ? styles.messageGroupContinuation : null, selection.isSelected ? styles.messageSelected : null]}
        {...(props.selectable ? hover.hoverProps : null)}
    >
        <View style={styles.messageFaceColumn}>
            {props.startsGroup && faceAccountId
                ? <Avatar id={faceAccountId} imageUrl={actor?.profile?.avatarUrl ?? null} size={28} />
                : null}
        </View>
        <View style={styles.messageBody}>
            {props.startsGroup ? <View style={styles.messageAttribution}>
                <Text testID={`session-discussion-message-actor-${message.id}`} style={styles.messageAuthor}>{props.authorLabel}</Text>
                {message.producerV1 ? <Text testID={`session-discussion-message-producer-${message.id}`} style={styles.meta}>{t('session.collaboration.discussion.viaAgent')}</Text> : null}
                {message.createdAt > 0 ? <Text testID={`session-discussion-message-timestamp-${message.id}`} accessibilityRole="text" accessibilityLabel={new Date(message.createdAt).toLocaleString()} style={styles.timestamp}>{formatShortRelativeTime(message.createdAt)}</Text> : null}
            </View> : null}
            <Text testID={`session-discussion-message-content-${message.id}`} style={styles.messageText}>{renderDiscussionMessageContent(message, props.resolveAccountLabel)}</Text>
            {props.footer}
        </View>
        {props.selectable ? <RowActionRevealSlot revealed={selectRevealed} style={styles.selectAffordance} testID={`session-discussion-select-slot-${message.id}`}>
            <SelectMessageButton messageId={message.id} enabled visible role="user" previewText={textOf(message.content, props.resolveAccountLabel)} testID={`session-discussion-select-${message.id}`} />
        </RowActionRevealSlot> : null}
    </View>;
});

/**
 * Exactly one exit per settled state: an unknown outcome or transient failure
 * retries the same identity; a definitive refusal is dismissed and the draft
 * stays for a fresh attempt.
 */
function MutationRecovery(props: Readonly<{ mutation: SessionDiscussionRepositoryMutation; onRetry: () => void; onDismiss: () => void }>) {
    const dismissable = props.mutation.status === 'failed' && props.mutation.recovery === 'dismiss';
    const retryable = props.mutation.status === 'outcome_unknown' || (props.mutation.status === 'failed' && !dismissable);
    if (dismissable) {
        return <Pressable testID="session-discussion-mutation-dismiss" style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.dismiss')} onPress={props.onDismiss}><Text style={styles.retryText}>{t('session.collaboration.discussion.dismiss')}</Text></Pressable>;
    }
    if (retryable) {
        return <Pressable testID="session-discussion-mutation-retry" style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.retry')} onPress={props.onRetry}><Text style={styles.retryText}>{t('session.collaboration.discussion.retry')}</Text></Pressable>;
    }
    return null;
}
