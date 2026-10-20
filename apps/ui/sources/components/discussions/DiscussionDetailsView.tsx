import * as React from 'react';
import { canonicalSessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { prepareDiscussionContentForPassage, readDiscussionContentPassage } from './discussionComposerDocument';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { Platform, Pressable, View, type ViewToken } from 'react-native';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierThreadMessage } from '@happier-dev/plugin-ui/components';
import {
    type DiscussionMessageContentV1,
    type DiscussionOpenedMessageV1,
    type DiscussionOpenedSummaryV1,
    type DiscussionDetailsResultV1,
} from '@happier-dev/protocol';
import { isDiscussionDocEditProposalContentV1, readDiscussionMentionedParticipantIdsV1, readDiscussionMessagePartsV1, type DiscussionMessagePartV1 } from '@happier-dev/protocol/discussions/content';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DiscussionDetailsTarget, DiscussionHomeAddress } from './discussionDetailsTarget';
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
import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { ArtifactPassageQuote } from '@/components/artifacts/ArtifactPassageQuote';
import { ArtifactEditProposal, type AdmittedDocRead } from '@/components/artifacts/ArtifactEditProposal';
import { createArtifactActionsClient, type ArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { buildDiscussionRouteHref } from './discussionRoutes';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { DetailsTabHeader, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { getStorage, useArtifact, useDiscussionRequesterApprovals } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { ApprovalRequesterThreadCard } from '@/components/approvals/ApprovalRequesterThreadCard';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SaveMemoryDecisionSheet, seedMemoryDecisionFromMessage } from '@/components/memory/SaveMemoryDecisionSheet';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { randomUUID } from '@/platform/randomUUID';
import { createDiscussionClient, type DiscussionClientOutcome, type DiscussionExecutableParticipantInviteOutcome } from '@/sync/api/discussions/discussionActions';
import { prepareDiscussionParticipantMentions } from './prepareDiscussionParticipantMentions';
import type { DiscussionComposerValue } from './DiscussionComposer';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionSurfaceVisible, useSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createDiscussionVisibleReadController } from '@/sync/domains/discussions/discussionVisibleReadController';
import { useDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { registerDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { useSetting } from '@/sync/domains/state/storage';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import type { DiscussionRepository, DiscussionRepositoryMutation } from '@/sync/ops/discussions/discussionRepository';
import { isDiscussionSourceContentRefusal } from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { formatSessionPresenceViewerNames } from '@/components/sessions/collaboration/sessionPresenceNames';
import { STALE_PRESENCE_OPACITY } from '@/components/sessions/collaboration/SessionViewerFacepile';
import { useOptionalTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import type { SessionHumanPresenceViewer } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';
import { useDeviceType } from '@/utils/platform/responsive';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { DiscussionAgentActivityReference } from '@/components/discussions/DiscussionAgentActivityReference';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useOpenSessionAgentConversation } from '@/components/sessions/conversations/useOpenSessionAgentConversation';
import { DiscussionWorkflowRunRow } from '@/components/discussions/DiscussionWorkflowRunRow';
import { useDiscussionManagedWorkflowRuns } from '@/components/discussions/useDiscussionManagedWorkflowRuns';
import { useDiscussionRunChips } from '@/components/discussions/useDiscussionRunChips';
import { buildDiscussionContent } from '@/components/discussions/discussionComposerDocument';
import { buildDiscussionTimelineItems, resolveReadableVisibleDiscussionSeqs, resolveDiscussionMessageAuthorLabel, resolveDiscussionReplyAttributionLine, resolveDiscussionReplyOutcome, type DiscussionTimelineItem, placeDiscussionRequesterApprovals } from '@/components/discussions/discussionTimelineProjection';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { useDiscussionParticipantProfiles } from './useDiscussionParticipantProfiles';
import { useDiscussionParticipantManagement } from './useDiscussionParticipantManagement';
import { isSelectableDiscussionMessage, prepareDiscussionSelectionHandoff } from '@/components/discussions/prepareDiscussionSelectionHandoff';
import { sendDiscussionSelectionToSession } from '@/components/discussions/sendDiscussionSelectionToSession';
import { DiscussionComposer } from '@/components/discussions/DiscussionComposer';
import { resolveDiscussionCreationTitle } from './discussionComposerDocument';
import { useDiscussionDraft } from './useDiscussionDraft';
import { formatDiscussionPresenceLine } from '@/components/discussions/discussionPresenceLine';
import { DiscussionParticipantsPopover, DiscussionRosterFaces, formatDiscussionRosterLine, summarizeDiscussionRoster } from '@/components/discussions/DiscussionParticipantsPopover';
import { DiscussionInviteButton } from '@/components/discussions/DiscussionInviteSheet';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { useDiscussionListRows } from '@/sync/ops/discussions/useDiscussionListRows';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base },
    input: { minHeight: 46, borderWidth: 1, borderColor: theme.colors.border.default, borderRadius: 14, paddingHorizontal: 14, paddingVertical: theme.space.s10, backgroundColor: theme.colors.surface.inset, color: theme.colors.text.primary, fontSize: 16, fontWeight: '600' },
    presenceRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: theme.space.s8, minWidth: 0 },
    loadingRows: { width: '100%', alignSelf: 'center', paddingHorizontal: theme.space.s16 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    headerMeta: {  flexShrink: 1, color: theme.colors.text.secondary, ...Typography.variant('body') },
    messages: { flex: 1, minHeight: 0 },
    messageAuthor: {  color: theme.colors.text.primary, ...Typography.variant('label', 'semiBold') },
    messageText: { ...Typography.default(), color: theme.colors.text.primary, fontSize: 15, lineHeight: 22 },
    mention: { ...Typography.default('semiBold'), color: theme.colors.state.active.foreground, backgroundColor: theme.colors.state.active.background, borderRadius: 4 },
    reference: { marginLeft: 46, marginRight: theme.space.s16, marginTop: theme.space.s6 },
    selectionToolbar: { position: 'absolute', left: 12, right: 12, bottom: 12 },
    meta: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
    timestamp: {  color: theme.colors.text.tertiary, ...Typography.variant('meta'), fontVariant: ['tabular-nums'] },
    selectAffordance: { alignSelf: 'center' },
    rowActions: { flexDirection: 'row', alignItems: 'center' },
    savedDecision: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    stateLine: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    deliveryStatus: { color: theme.colors.text.secondary, fontSize: 12 },
    error: { color: theme.colors.text.destructive, textAlign: 'center' },
    retry: { minHeight: minimumInteractiveTargetSize, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
    retryText: { color: theme.colors.accent.blue, fontWeight: '600' },
    fieldHint: { color: theme.colors.text.destructive },
    outcomeFailed: { color: theme.colors.text.destructive },
    // The new page's name field is the header's title, at the title's own step, with no field chrome.
    titleInput: { flex: 1, minWidth: 0, padding: 0, color: theme.colors.text.primary, ...Typography.variant('heading', 'semiBold') },
    // A phone header takes the large title step; the name field follows it.
    titleInputLarge: { ...pageTitleTypography() },
    newNotice: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s8, ...Typography.variant('meta') },
    newBody: { flex: 1, minHeight: 0, justifyContent: 'center' },
    draftPassage: { width: '100%', alignSelf: 'center', paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s8 },
    draftPassageRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    draftPassageQuote: { flex: 1, minWidth: 0 },
}));
const VIEWABILITY = Object.freeze({ itemVisiblePercentThreshold: 1 });
const NO_VIEWERS: readonly SessionHumanPresenceViewer[] = Object.freeze([]);
const PRESENCE_FACE_LIMIT = 3;
/** Retained last-known presence is quieter than live presence (the facepile's own de-emphasis). */
const STALE_PRESENCE_FACE_OPACITY = STALE_PRESENCE_OPACITY;
/** Pending rows render locally but have no committed message reference or selection authority. */
type DiscussionDisplayMessage = Omit<DiscussionOpenedMessageV1, 'messageRef'> & Readonly<{ messageRef?: DiscussionOpenedMessageV1['messageRef'] }>;

function isSameDocPassage(left: DocPassageRefV1, right: DocPassageRefV1): boolean {
    return left.ref.artifactId === right.ref.artifactId
        && left.revision.headerVersion === right.revision.headerVersion
        && left.revision.bodyVersion === right.revision.bodyVersion
        && left.range.start === right.range.start && left.range.end === right.range.end;
}

function isCommittedDisplayMessage(message: DiscussionDisplayMessage): message is DiscussionOpenedMessageV1 {
    return message.messageRef !== undefined;
}

/**
 * One presenter for the typed refusal vocabulary the repository already
 * classifies: the reason a person can act on, not a generic "Failed".
 */
function discussionFailureLabel(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'locked': return t('session.access.preparing');
        case 'discussion_post_denied': return t('session.collaboration.discussion.postDenied');
        case 'discussion_manage_denied': return t('errors.permissionDenied');
        case 'discussion_invalid_mention': return t('session.collaboration.discussion.invalidMention');
        case 'discussion_invalid_content': return t('session.collaboration.discussion.invalidContent');
        case 'discussion_archived': return t('session.collaboration.discussion.archivedNotice');
        case 'discussion_encryption_mode_mismatch': return t('session.collaboration.discussion.locked');
        case 'discussion_idempotency_conflict': return t('session.collaboration.discussion.idempotencyConflict');
        case 'discussions_unavailable': return t('session.collaboration.discussion.unavailable');
        default: return t('session.collaboration.discussion.sendFailed');
    }
}

function discussionLifecycleFailureLabel(
    outcome: Exclude<DiscussionClientOutcome<DiscussionDetailsResultV1> | DiscussionExecutableParticipantInviteOutcome, { kind: 'succeeded' }>,
    operation: 'rename' | 'archive' | 'restore' | 'invite',
): string {
    if (outcome.kind === 'approval_request_created') return t('approvals.status.open');
    if (outcome.kind === 'checking') return t(operation === 'invite'
        ? 'session.collaboration.discussion.manage.checking' : 'session.collaboration.discussion.deliveryUnknown');
    return outcome.kind === 'failed' && outcome.errorCode === 'outcome_unknown'
        ? t('session.collaboration.discussion.deliveryUnknown')
        : discussionFailureLabel(outcome.kind === 'failed' ? outcome.errorCode : undefined);
}

function mutationStatusLabel(mutation: Pick<DiscussionRepositoryMutation, 'status' | 'errorCode'>): string | null {
    if (mutation.status === 'observed_success') return null;
    if (mutation.status === 'outcome_unknown') return t('session.collaboration.discussion.deliveryUnknown');
    if (mutation.status === 'failed') return discussionFailureLabel(mutation.errorCode);
    if (mutation.status === 'approval_pending') return t('approvals.status.open');
    if (mutation.status === 'sending') return t('session.planOutput.sending');
    return t('session.collaboration.discussion.checking');
}

/** A dismissable refusal keeps its reason visible but no longer holds the composer. */
function mutationBlocksComposer(mutation: DiscussionRepositoryMutation | null): boolean {
    return mutation !== null && !(mutation.status === 'failed' && mutation.recovery === 'dismiss');
}

function textOf(
    content: DiscussionMessageContentV1 | null,
    resolveAccountLabel: (accountId: string) => string | null = () => null,
    resolveSessionLabel: (sessionId: string) => string | null = () => null,
): string {
    if (!content) return t('session.collaboration.discussion.contentUnavailable');
    return readDiscussionMessagePartsV1(content).map((part) => part.t === 'text'
        ? part.text
        : discussionMentionText(part, resolveAccountLabel, resolveSessionLabel)
    ).join('');
}

function discussionMentionText(part: Extract<DiscussionMessagePartV1, { t: 'mention' }>, resolveAccountLabel: (accountId: string) => string | null, resolveSessionLabel: (sessionId: string) => string | null): string {
    const sessionLabel = part.participant.kind === 'session' ? resolveSessionLabel(part.participant.sessionId) : null;
    return part.participant.kind === 'account'
        ? `@${resolveAccountLabel(part.participant.accountId) ?? t('session.collaboration.discussion.collaborator')}`
        // An unnamed Session is still a mention, worded as the list preview words it, never "Message unavailable".
        : `@${sessionLabel ?? t('session.collaboration.discussion.heldParticipant')}`;
}

/**
 * The message as the reader sees it: text as written, and each mention tinted and named. A message
 * without mentions stays one plain string.
 */
export function renderDiscussionMessageContent(
    message: DiscussionDisplayMessage,
    resolveAccountLabel: (accountId: string) => string | null,
    resolveSessionLabel: (sessionId: string) => string | null,
): React.ReactNode {
    const content = message.content;
    if (!content) return textOf(content, resolveAccountLabel, resolveSessionLabel);
    const parts = readDiscussionMessagePartsV1(content);
    if (!parts.some((part) => part.t !== 'text')) return textOf(content, resolveAccountLabel, resolveSessionLabel);
    return parts.map((part, index) => part.t === 'text'
        ? part.text
        : <Text
            key={index}
            testID={`session-discussion-mention-${message.id}-${index}`}
            style={styles.mention}
        >{discussionMentionText(part, resolveAccountLabel, resolveSessionLabel)}</Text>);
}

function discussionMessageProducerClass(message: DiscussionDisplayMessage): string {
    return message.producerV1 === null ? 'human' : `producer:${message.producerV1.kind}`;
}

function startsDiscussionMessageGroup(
    message: DiscussionDisplayMessage,
    previous: DiscussionDisplayMessage | undefined,
): boolean {
    return !previous
        || message.authorAccountId === null
        || previous.authorAccountId === null
        || previous.authorAccountId !== message.authorAccountId
        || discussionMessageProducerClass(previous) !== discussionMessageProducerClass(message);
}

function useRepository(
    scope: ServerAccountScope,
    address: DiscussionHomeAddress,
    accountLifetime: ServerCredentialAccountScopeBinding,
): readonly [DiscussionRepository, ReturnType<DiscussionRepository['getSnapshot']>] {
    const client = React.useMemo(() => createDiscussionClient({ scope, availability: 'available' }), [scope]);
    const repository = React.useMemo(() => getDiscussionRepository({
        scope,
        address,
        client,
        accountLifetime,
    }), [accountLifetime, address, client, scope]);
    const snapshot = useDiscussionRepositorySnapshot(repository);
    React.useEffect(() => repository.mount(), [repository]);
    return [repository, snapshot];
}

export function DiscussionDetailsView(props: Readonly<{
    target: DiscussionDetailsTarget;
    /** True only while this Details surface is the one actually on screen (active tab, focused route). */
    active: boolean;
    /**
     * The host is itself the visible surface (the standalone mobile Discussion route),
     * so `active` alone states visibility. A Session-hosted Details pane leaves this
     * unset: it is visible only while its Session surface is.
     */
    standaloneSurface?: boolean;
    /** Visibility belongs to the actual hosting Session pane, never the optional anchor. */
    hostSessionAddress?: SessionAddress;
    /** Leaves this conversation surface (the phone route goes back); Details closes its own tab. */
    onClose?: () => void;
    onCreated?: (discussion: DiscussionOpenedSummaryV1, passageRoot?: DiscussionMessageRefV1) => void;
    onOpened?: (discussion: DiscussionOpenedSummaryV1) => void;
}>): React.ReactElement {
    const requestedServerIds = React.useMemo(() => [props.target.address.serverId], [props.target.address.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const availability = useSessionCollaborationAvailability(props.target.address.serverId);
    const enabled = useFeatureEnabled('sessions.conversations', { scopeKind: 'spawn', serverId: props.target.address.serverId });
    const phoneChrome = useDiscussionPhoneChrome(props.standaloneSurface === true && props.target.kind === 'discussion');
    if (!enabled || availability !== 'available' || !binding) {
        return <DiscussionPhoneChrome enabled={phoneChrome} onBack={props.onClose}><SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="unavailable"
            title={t('sessionConversation.discussion.unavailableTitle')}
            reason={t('session.collaboration.discussion.unavailable')}
        /></DiscussionPhoneChrome>;
    }
    return props.target.kind === 'new'
        ? <NewDiscussion key={JSON.stringify([binding.scope.serverId, binding.scope.accountId, props.target.draftId ?? null])}
            target={props.target} scope={binding.scope} accountLifetime={binding} onCreated={props.onCreated} />
        : <Discussion target={props.target} scope={binding.scope} accountLifetime={binding} active={props.active} standaloneSurface={props.standaloneSurface === true} hostSessionAddress={props.hostSessionAddress} onClose={props.onClose} onOpened={props.onOpened} />;
}

function NewDiscussion(props: Readonly<{ target: Extract<DiscussionDetailsTarget, { kind: 'new' }>; scope: ServerAccountScope; accountLifetime: ServerCredentialAccountScopeBinding; onCreated?: (discussion: DiscussionOpenedSummaryV1, passageRoot?: DiscussionMessageRefV1) => void }>) {
    const { theme } = useUnistyles();
    const draftAddress = React.useMemo(() => ({ kind: 'newDiscussion' as const,
        ...(props.target.draftId === undefined ? {} : { draftId: props.target.draftId }) }), [props.target.draftId]);
    const draft = useDiscussionDraft({ scope: props.scope, address: draftAddress });
    const [repository, snapshot] = useRepository(props.scope, props.target.address, props.accountLifetime);
    const restoredAttempt = draft.pendingMutationAttempt?.kind === 'create' ? draft.pendingMutationAttempt : null;
    const ids = React.useRef({
        creationLocalId: restoredAttempt?.creationLocalId ?? randomUUID(),
        messageLocalId: restoredAttempt?.messageLocalId ?? randomUUID(),
    });
    const capture = React.useRef<ReturnType<typeof draft.captureSubmittedCurrentness> | null>(null);
    const completed = React.useRef(false);
    const [titleRequired, setTitleRequired] = React.useState(false);
    const phone = useSurfaceStateSize() === 'phone';
    const draftKey = canonicalSessionDraftAddressV2(draftAddress);
    const recoveredMutation = Object.values(snapshot.mutations).find((item) => item.kind === 'create'
        && (item.draftSubmission ? canonicalSessionDraftAddressV2(item.draftSubmission.address) === draftKey
            : props.target.draftId === undefined)) ?? null;
    const activeCreationLocalId = recoveredMutation?.localId ?? ids.current.creationLocalId;
    const mutation = snapshot.mutations[activeCreationLocalId] ?? null;
    const composerBlocked = mutationBlocksComposer(mutation);
    const accessRevoked = snapshot.lists.active.status === 'revoked' || snapshot.lists.archived.status === 'revoked';
    const sourceRefused = isDiscussionSourceContentRefusal(snapshot.lists.active.errorCode)
        || isDiscussionSourceContentRefusal(snapshot.lists.archived.errorCode);
    const draftUnavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict';
    const repositoryUnavailable = snapshot.lists.active.status === 'offline'
        || snapshot.lists.active.status === 'locked'
        || snapshot.lists.active.status === 'error';
    const createDisabled = composerBlocked || draftUnavailable || repositoryUnavailable;
    const createUnavailableLabel = draft.status === 'offline' || snapshot.lists.active.status === 'offline'
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
        if (sourceRefused) void draft.purgeSourcePresentation();
        else if (accessRevoked) void draft.purgePresentation();
    }, [accessRevoked, draft, sourceRefused]);
    const finish = React.useCallback(async (discussion: DiscussionOpenedSummaryV1) => {
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
        const root = repository.getSnapshot().threads[discussion.id]?.messages.find(message => message.replyTarget?.kind === 'doc_passage');
        props.onCreated?.(discussion, root?.messageRef);
    }, [activeCreationLocalId, draft, props, repository]);
    React.useEffect(() => {
        const found = [...snapshot.lists.active.items, ...snapshot.lists.archived.items].find((item) => item.creationLocalId === activeCreationLocalId);
        if (found) void finish(found);
    }, [activeCreationLocalId, finish, snapshot.lists.active.items, snapshot.lists.archived.items]);
    React.useEffect(() => {
        if (!restoredAttempt || snapshot.mutations[restoredAttempt.creationLocalId]) return;
        if (draft.submitted?.attemptLocalId !== restoredAttempt.creationLocalId) return;
        const content = draft.submitted.content;
        const title = draft.submitted.title;
        if (!title) return;
        repository.adoptPendingIntent({
            kind: 'create',
            creationLocalId: restoredAttempt.creationLocalId,
            messageLocalId: restoredAttempt.messageLocalId,
            title,
            content,
            ...readDiscussionMentionedParticipantIdsV1(content),
            ...(restoredAttempt.anchor ? { anchor: restoredAttempt.anchor } : {}),
            ...(restoredAttempt.participants ? { participants: restoredAttempt.participants } : {}),
            ...(restoredAttempt.replyTarget ? { replyTarget: restoredAttempt.replyTarget } : {}),
            draftSubmission: { scope: props.scope, address: draftAddress, currentness: restoredAttempt.currentness },
        });
    }, [draft.submitted, draftAddress, props.scope, repository, restoredAttempt, snapshot.mutations]);
    const dismissRefusal = React.useCallback(() => {
        if (mutation?.status !== 'failed') return;
        draft.releaseSubmittedAttempt();
        repository.dismissFailure(mutation.localId);
        // A refused identity is never reused: the retained draft goes out as a fresh attempt.
        ids.current = { creationLocalId: randomUUID(), messageLocalId: randomUUID() };
    }, [draft, mutation, repository]);
    const submit = React.useCallback(async (textContent: DiscussionMessageContentV1) => {
        if (composerBlocked) return;
        const content = prepareDiscussionContentForPassage({ content: textContent, passage: draft.passage });
        const title = resolveDiscussionCreationTitle({
            title: draft.title,
            text: readDiscussionMessagePartsV1(content).map((part) => part.t === 'text' ? part.text : '').join(''),
        });
        if (!title) {
            setTitleRequired(true);
            return;
        }
        setTitleRequired(false);
        if (mutation) dismissRefusal();
        if (draft.passage) ids.current = { ...ids.current, creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({
            ref: { ...draft.passage.ref, serverId: props.scope.serverId }, localId: ids.current.messageLocalId,
        }) };
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'create', ...ids.current, ...(props.target.anchor ? { anchor: props.target.anchor } : {}) }, { content, title });
        capture.current = draftSubmission;
        await repository.create({ ...ids.current, title, content, ...readDiscussionMentionedParticipantIdsV1(content), ...(props.target.anchor ? { anchor: props.target.anchor } : {}), draftSubmission });
    }, [composerBlocked, dismissRefusal, draft, mutation, props.scope.serverId, props.target.anchor, repository]);
    if (accessRevoked) {
        return <SurfaceStateCard
            testID="session-discussion-details-empty-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
        />;
    }
    // Lab T2-ST "New Discussion": the name is the header's own title, who is here and who reads it sit on its
    // line, the page says how addressing works, and the composer starts the conversation.
    const draftColumn = useLayoutMaxWidthStyle();
    return <View style={styles.root} testID="session-discussion-new-details">
        <DetailsTabHeader
            testID="session-discussion-new-header"
            title=""
            titleControl={<TextInput testID="session-discussion-title" style={[styles.titleInput, phone ? styles.titleInputLarge : null]} value={draft.title} onChangeText={(title) => { draft.setTitle(title); if (title.trim()) setTitleRequired(false); }} placeholder={t('session.collaboration.discussion.newPage.namePlaceholder')} accessibilityLabel={t('session.collaboration.discussion.titlePlaceholder')} aria-invalid={titleRequired} autoFocus />}
            meta={[
                { key: 'people', text: t('session.collaboration.discussion.participants.people', { count: 1 }) },
                { key: 'audience', text: t('session.collaboration.discussion.participants.invitedOnly'), icon: 'lock' },
            ]}
            notice={titleRequired ? <Text testID="session-discussion-title-required" accessibilityLiveRegion="polite" style={[styles.fieldHint, styles.newNotice]}>{t('session.collaboration.discussion.titleRequired')}</Text> : undefined}
        />
        <View style={styles.newBody}>
            {mutation?.content ? <HappierThreadMessage startsGroup space={theme.space} selectionColors={theme.colors.state.active}><Text testID={`session-discussion-message-content-${mutation.messageLocalId}`} style={styles.messageText}>{textOf(mutation.content)}</Text>{mutationStatusLabel(mutation) ? <Text testID={`session-discussion-message-status-${mutation.messageLocalId}`} accessibilityLiveRegion="polite" style={mutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(mutation)}</Text> : null}<MutationRecovery mutation={mutation} onRetry={() => void repository.retry(activeCreationLocalId)} onDismiss={dismissRefusal} /></HappierThreadMessage>
                : <EmptyState testID="session-discussion-new-empty" layout="centered" iconName="chats-circle" title={t('session.collaboration.discussion.newPage.emptyTitle')} subtitle={t('session.collaboration.discussion.newPage.emptyBody')} />}
        </View>
        {/* The passage being commented on heads the composer, in the thread's column (lab K1-S). */}
        {draft.passage || sourceRefused ? <View style={[styles.draftPassage, draftColumn]}>
            <ArtifactPassageQuote testID="discussion-draft-passage-quote" passage={sourceRefused ? null : draft.passage} />
        </View> : null}
        {draft.conflict ? <SessionDraftConflictResolution scope={props.scope} address={draftAddress} conflict={draft.conflict} /> : null}
        {createUnavailableLabel ? <View style={styles.stateLine}><SurfaceStateCard size="line" kind="warning" title={createUnavailableLabel} /></View> : null}
        <DiscussionComposer scope={props.scope} accountLifetime={props.accountLifetime} address={props.target.address} availability="available" value={{ text: draft.text, mentions: draft.mentions }} onChange={draft.setComposer} disabled={createDisabled} onSend={(content) => void submit(content)} />
    </View>;
}

type DiscussionProps = Readonly<{ target: Extract<DiscussionDetailsTarget, { kind: 'discussion' }>; scope: ServerAccountScope; accountLifetime: ServerCredentialAccountScopeBinding; active: boolean; standaloneSurface: boolean; hostSessionAddress?: SessionAddress; onClose?: () => void; onOpened?: (discussion: DiscussionOpenedSummaryV1) => void }>;
type DiscussionSource = Readonly<{
    scope: ServerAccountScope;
    address: SessionAddress;
    canLaunchExecutionRuns: boolean;
    canSendToSession: boolean;
    activity: Pick<ReturnType<typeof useSessionAgentActivityRoster>, 'subagents' | 'readExecutionRunEntry'>;
    agentConversation: ReturnType<typeof useOpenSessionAgentConversation>;
}>;
const NO_SOURCE_SUBAGENTS: ReturnType<typeof useSessionAgentActivityRoster>['subagents'] = Object.freeze([]);
const readNoSourceExecutionRunEntry: ReturnType<typeof useSessionAgentActivityRoster>['readExecutionRunEntry'] = () => null;
const LOADING_PROPOSAL_DOC: AdmittedDocRead = Object.freeze({ status: 'loading' });
type ProposalDocObservation = Readonly<{ client: ArtifactActionsClient; read: AdmittedDocRead }>;
type ReportProposalDocRead = (artifactId: string, client: ArtifactActionsClient, read: AdmittedDocRead | null) => void;

/** One admitted current Doc basis for the shown cards that refer to it, in this Discussion's Home. */
function DiscussionProposalDocRead(props: Readonly<{
    artifactId: string;
    client: ArtifactActionsClient;
    accountLifetime: ServerCredentialAccountScopeBinding;
    onRead: ReportProposalDocRead;
}>) {
    const { artifactId, client, accountLifetime, onRead } = props;
    const revisionKey = getStorage()(state => {
        if (!areServerAccountScopesEqual(state.profileScope, client.scope)) return '';
        const artifact = state.artifacts[artifactId];
        return artifact ? JSON.stringify([artifact.headerVersion, artifact.bodyVersion, artifact.seq,
            artifact.access, artifact.ownerAccountId, artifact.publicAudience]) : '';
    });
    const [wake, setWake] = React.useState<object | null>(null);
    React.useEffect(() => subscribeHomeAccountChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, client.scope.serverId)
            || (event.changeKinds && !event.changeKinds.includes('artifact'))
            || (event.entityIds && !event.entityIds.includes(artifactId))) return;
        setWake(event);
    }), [artifactId, client]);
    React.useEffect(() => {
        let current = true;
        onRead(artifactId, client, LOADING_PROPOSAL_DOC);
        const retirement = accountLifetime.onRetire(() => {
            current = false;
            onRead(artifactId, client, { status: 'unavailable' });
        });
        if (accountLifetime.isCurrent()) {
            void client.readDoc({ ref: { kind: 'doc', artifactId } }).then(outcome => {
                if (!current || !accountLifetime.isCurrent()) return;
                onRead(artifactId, client, outcome.ok ? { status: 'ready', value: outcome.value } : { status: 'unavailable' });
            });
        } else onRead(artifactId, client, { status: 'unavailable' });
        return () => { current = false; retirement.dispose(); };
    }, [accountLifetime, artifactId, client, onRead, revisionKey, wake]);
    React.useEffect(() => () => onRead(artifactId, client, null), [artifactId, client, onRead]);
    return null;
}

/**
 * Source-only subscriptions mount only when the resource actually has a Session anchor. A memoized leaf: it
 * renders for its own subscriptions, never because publishing its source re-rendered the parent (that loop
 * re-published a fresh source on every render of a Session-anchored Discussion).
 */
const DiscussionSourceObserver = React.memo(function DiscussionSourceObserver(props: Readonly<{ scope: ServerAccountScope; address: SessionAddress; onChange: (source: DiscussionSource | null) => void }>) {
    const session = useSessionViewShellSession(props.address.sessionId, props.address.serverId);
    const { canLaunchExecutionRuns } = useSessionExecutionRunLaunchability(props.address.sessionId, session, props.address.serverId);
    const { subagents, readExecutionRunEntry } = useSessionAgentActivityRoster({ sessionId: props.address.sessionId, serverId: props.address.serverId });
    const activity = React.useMemo(() => ({ subagents, readExecutionRunEntry }), [readExecutionRunEntry, subagents]);
    const agentConversation = useOpenSessionAgentConversation({ address: props.address });
    const canSendToSession = session != null && !isSessionWriteKnownDenied(session);
    React.useEffect(() => {
        props.onChange({ scope: props.scope, address: props.address, canLaunchExecutionRuns, canSendToSession, activity, agentConversation });
        return () => props.onChange(null);
    }, [activity, agentConversation, canLaunchExecutionRuns, canSendToSession, props.address, props.onChange, props.scope]);
    return null;
});

function Discussion(props: DiscussionProps) {
    const [repository, snapshot] = useRepository(props.scope, props.target.address, props.accountLifetime);
    const thread = snapshot.threads[props.target.discussionId];
    const anchor = thread?.status === 'revoked' ? null : thread?.summary?.anchor;
    const anchorSessionId = anchor?.kind === 'session' ? anchor.sessionId : null;
    const sourceAddress = React.useMemo(() => anchorSessionId
        ? { serverId: props.target.address.serverId, sessionId: anchorSessionId }
        : null, [anchorSessionId, props.target.address.serverId]);
    const [observedSource, setObservedSource] = React.useState<DiscussionSource | null>(null);
    const source = props.active && sourceAddress && observedSource?.scope.serverId === props.scope.serverId
        && observedSource.scope.accountId === props.scope.accountId && observedSource.address.serverId === sourceAddress.serverId
        && observedSource.address.sessionId === sourceAddress.sessionId ? observedSource : null;
    return <>
        {props.active && sourceAddress ? <DiscussionSourceObserver scope={props.scope} address={sourceAddress} onChange={setObservedSource} /> : null}
        <DiscussionContent {...props} repository={repository} snapshot={snapshot} source={source} />
    </>;
}

function DiscussionContent(props: DiscussionProps & Readonly<{
    repository: DiscussionRepository;
    snapshot: ReturnType<DiscussionRepository['getSnapshot']>;
    source: DiscussionSource | null;
}>) {
    const router = useRouter();
    const device = useDeviceType();
    const { theme } = useUnistyles();
    const { repository, snapshot } = props;
    const thread = snapshot.threads[props.target.discussionId];
    const discussion = thread?.summary ?? null;
    const accessRevoked = snapshot.lists.active.status === 'revoked'
        || snapshot.lists.archived.status === 'revoked'
        || thread?.status === 'revoked';
    const sourceRefused = isDiscussionSourceContentRefusal(thread?.errorCode)
        || isDiscussionSourceContentRefusal(snapshot.lists.active.errorCode)
        || isDiscussionSourceContentRefusal(snapshot.lists.archived.errorCode);
    const hostViewed = useHostActivelyViewed();
    const visibility = useSessionSurfaceVisibilitySnapshot();
    const surfaceVisible = React.useMemo(() => !props.hostSessionAddress || isSessionSurfaceVisible(props.hostSessionAddress.sessionId, props.hostSessionAddress.serverId), [props.hostSessionAddress, visibility]);
    const pane = useAppPaneScope(useDestinationPaneScopeId(props.source
        ? createSessionPaneScopeId(props.source.address.sessionId, props.source.address.serverId)
        : `discussion:${JSON.stringify([props.target.address.serverId, props.target.discussionId])}`));
    const presenceTarget = React.useMemo(() => ({ serverId: props.target.address.serverId, discussionId: props.target.discussionId }), [props.target.address.serverId, props.target.discussionId]);
    const presenceEligible = props.active && hostViewed && (props.standaloneSurface || surfaceVisible) && !accessRevoked;
    const presence = useDiscussionHumanPresence(presenceEligible ? presenceTarget : null, props.accountLifetime);
    React.useEffect(() => presenceEligible ? registerDiscussionHumanPresence(presenceTarget, props.accountLifetime) : undefined, [presenceEligible, presenceTarget, props.accountLifetime]);
    // The one presence-name owner, as in the facepile and Viewing now: a retained
    // last-known observation keeps its names, says so, and makes no typing claim.
    const presenceStale = presence.status === 'stale';
    const presentViewers = presence.viewers.length === 0 || (presence.status !== 'live' && !presenceStale)
        ? NO_VIEWERS
        : presence.viewers;
    const presenceLabel = React.useMemo(
        () => formatDiscussionPresenceLine(presentViewers, { stale: presenceStale }),
        [presenceStale, presentViewers],
    );
    const threadColumn = useLayoutMaxWidthStyle();
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const sendTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const draftAddress = React.useMemo(() => ({ kind: 'discussion' as const, discussionId: props.target.discussionId }), [props.target.discussionId]);
    const draft = useDiscussionDraft({ scope: props.scope, address: draftAddress });
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
    const messageById = React.useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
    const openQuotedMessage = React.useCallback((messageId: string) => {
        router.push(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId },
            discussionId: props.target.discussionId, messageId } }) as Href);
    }, [props.target.address.serverId, props.target.discussionId, router]);
    // A suggested edit is decided through the Doc Actions on this Discussion's own Home.
    const proposalClient = React.useMemo(() => createArtifactActionsClient(props.scope), [props.scope]);
    const participantManagement = useDiscussionParticipantManagement({ accountLifetime: props.accountLifetime,
        discussionId: props.target.discussionId, repository, summary: discussion,
        enabled: props.active && thread?.status !== 'revoked' });
    const refreshRoster = participantManagement.refresh;
    const participantProfiles = useDiscussionParticipantProfiles({ scope: props.scope, accountLifetime: props.accountLifetime,
        roster: participantManagement.roster,
        enabled: props.active && thread?.status !== 'revoked' });
    // The viewer's own unacknowledged message is authored with their scoped profile, not "Collaborator".
    const viewerProfile = useShareViewerProfile(props.scope);
    const viewer = React.useMemo(() => ({ accountId: props.scope.accountId, profile: viewerProfile }), [props.scope.accountId, viewerProfile]);
    const historicalActorLabels = React.useMemo(() => new Map(messages.flatMap((message) => {
        const actor = message.accountActor;
        if (actor === null || actor.accountId !== message.authorAccountId) return [];
        return [[actor.accountId, resolveDiscussionMessageAuthorLabel(message)] as const];
    })), [messages]);
    const resolveAccountLabel = React.useCallback((accountId: string): string | null => {
        const historicalLabel = historicalActorLabels.get(accountId);
        if (historicalLabel) return historicalLabel;
        const actor = participantProfiles.accounts.get(accountId);
        return actor ? resolveAccountActorPresentation(actor, props.scope).name : null;
    }, [historicalActorLabels, participantProfiles.accounts, props.scope]);
    // Mentions and receiver holds identify Sessions, but grant no Session read
    // authority. Only this Home's accessible title projection supplies labels.
    const mentionedSessionAddresses = React.useMemo(() => [...new Set(messages.flatMap((message) => [
        ...(message.content ? readDiscussionMentionedParticipantIdsV1(message.content).mentionedSessionIds : []),
        ...(message.participantDeliveryV1?.map((delivery) => delivery.participantSessionId) ?? []),
        // A Bot reply's byline names the Session that answered, through the same title projection.
        // A suggested edit's author is named too: its Ask to redo addresses that Session.
        ...(message.producerV1 && (message.producerV1.actionRequestAttributionV1?.requester
            || (message.content && isDiscussionDocEditProposalContentV1(message.content))) ? [message.producerV1.sessionId] : []),
    ]))]
        .map((sessionId) => ({ serverId: props.scope.serverId, sessionId })), [messages, props.scope.serverId]);
    const mentionedSessionTitles = useSessionDisplayTitles(mentionedSessionAddresses);
    // The Session this Discussion hangs off, named in the header (lab T2-A anchor); only this Home's
    // accessible title projection names it, as for mentions.
    const anchorSessionId = discussion?.anchor?.kind === 'session' ? discussion.anchor.sessionId : null;
    const anchorAddresses = React.useMemo(() => anchorSessionId ? [{ serverId: props.scope.serverId, sessionId: anchorSessionId }] : [], [anchorSessionId, props.scope.serverId]);
    const anchorTitle = useSessionDisplayTitles(anchorAddresses)[0] ?? null;
    const anchorDocId = discussion?.anchor?.kind === 'doc' ? discussion.anchor.doc.ref.artifactId : null;
    const anchorDoc = useArtifact(anchorDocId ?? '');
    // The way back to what this conversation hangs off (lab T2-A "PAY-212"): the Session or Doc opens where
    // it lives; a task names itself but has no open contract yet, so it stays a plain fact.
    const anchorFact = React.useMemo<DetailsTabHeaderMetaFact | null>(() => {
        const anchor = discussion?.anchor;
        if (!anchor) return null;
        if (anchor.kind === 'session') {
            if (!anchorTitle) return null;
            const href = buildScopedSessionRouteHref({ serverId: props.scope.serverId, sessionId: anchor.sessionId });
            return { key: 'anchor', text: anchorTitle, icon: 'chats-circle', testID: 'session-discussion-anchor',
                accessibilityLabel: t('session.collaboration.discussion.openAnchor', { name: anchorTitle }),
                onPress: () => router.push(href as Href) };
        }
        if (anchor.kind === 'doc') {
            const name = anchorDoc?.title || t('artifacts.browser.kindOne.document');
            return { key: 'anchor', text: name, icon: 'file-text', testID: 'session-discussion-anchor',
                accessibilityLabel: t('session.collaboration.discussion.openAnchor', { name }),
                onPress: () => router.push(artifactViewRoute(anchor.doc.ref.artifactId) as Href) };
        }
        return { key: 'anchor', text: anchor.entry.entryId, icon: 'check-square', testID: 'session-discussion-anchor' };
    }, [anchorDoc, anchorTitle, discussion?.anchor, props.scope.serverId, router]);
    // A private draft or request waiting on this viewer (lab T2-ST "Drafts for approval"): the same Inbox
    // approval owner the column's Needs you reads. Reviewing it (Post or Decline) stays that owner's page.
    const attentionItems = React.useMemo(() => discussion ? [discussion] : [], [discussion]);
    const attention = useDiscussionListRows(props.scope, attentionItems)[0] ?? null;
    const waitingApprovalId = attention?.attentionReason === 'draft_waiting' || attention?.attentionReason === 'approval_pending'
        ? attention.approvalArtifactIds[0] ?? null : null;
    const reviewWaiting = React.useCallback(() => {
        if (!waitingApprovalId) return;
        router.push(buildApprovalHref(waitingApprovalId, props.scope.serverId,
            buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId }, discussionId: props.target.discussionId } })) as Href);
    }, [props.scope.serverId, props.target.address.serverId, props.target.discussionId, router, waitingApprovalId]);
    const sessionLabels = React.useMemo(() => new Map(mentionedSessionAddresses.map((address, index) => [address.sessionId, mentionedSessionTitles[index] ?? null])), [mentionedSessionAddresses, mentionedSessionTitles]);
    const resolveSessionLabel = React.useCallback((sessionId: string) => sessionLabels.get(sessionId) ?? null, [sessionLabels]);
    const selectableMessages = React.useMemo<readonly TranscriptSelectionToolbarMessage[]>(() => messages
        .filter(isSelectableDiscussionMessage)
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
        .map((message) => ({ id: message.id, role: 'user' as const, text: textOf(message.content, resolveAccountLabel, resolveSessionLabel) })), [messages, resolveAccountLabel, resolveSessionLabel]);
    const prepareSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => prepareDiscussionSelectionHandoff({
        serverId: props.target.address.serverId,
        discussionId: props.target.discussionId,
        selectedMessageIds: selected.map((message) => message.id),
        messages,
        resolveAccountLabel,
        resolveSessionLabel,
        format: transcriptBulkCopyFormat,
        roleLabels: { user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') },
        agentAttributionLabel: t('session.collaboration.discussion.viaAgent'),
    }), [messages, props.target.address.serverId, props.target.discussionId, resolveAccountLabel, resolveSessionLabel, transcriptBulkCopyFormat]);
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
    const draftUnavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict';
    const threadUnavailable = thread?.status === 'offline' || thread?.status === 'locked' || thread?.status === 'error';
    const mutationsDisabled = draftUnavailable || threadUnavailable;
    React.useEffect(() => {
        if (sourceRefused) void draft.purgeSourcePresentation();
        else if (accessRevoked) void draft.purgePresentation();
    }, [accessRevoked, draft, sourceRefused]);
    const [rename, setRename] = React.useState<string | null>(null);
    const [lifecycleFailure, setLifecycleFailure] = React.useState<Readonly<{
        operation: 'rename' | 'archive' | 'restore' | 'invite';
        outcome: Exclude<DiscussionClientOutcome<DiscussionDetailsResultV1> | DiscussionExecutableParticipantInviteOutcome, { kind: 'succeeded' }>;
    }> | null>(null);
    const inviteExecutable = participantManagement.inviteExecutable;
    const prepareParticipantMentions = React.useCallback(async (document: DiscussionComposerValue, isCurrent: () => boolean) => {
        setLifecycleFailure(null);
        const result = await prepareDiscussionParticipantMentions({ document, discussionId: props.target.discussionId,
            repository, inviteExecutable, isCurrent: () => props.accountLifetime.isCurrent() && isCurrent() });
        if (result.kind === 'ready') return result.content;
        if (props.accountLifetime.isCurrent() && isCurrent()) setLifecycleFailure({ operation: 'invite', outcome: result.outcome });
        return null;
    }, [inviteExecutable, props.accountLifetime, props.target.discussionId, repository]);
    React.useEffect(() => {
        if (props.target.messageId) void repository.openMessage({ kind: 'discussion', discussion: {
            serverId: props.target.address.serverId, discussionId: props.target.discussionId,
        }, messageId: props.target.messageId });
        else void repository.refreshDiscussion(props.target.discussionId);
    }, [props.target.address.serverId, props.target.discussionId, props.target.messageId, repository]);
    const threadRoot = props.target.messageId ? messages.find(message => message.id === props.target.messageId) : null;
    const rootPassage = readDiscussionContentPassage(threadRoot?.content);
    React.useEffect(() => {
        if (!restoredPostAttempt || snapshot.mutations[restoredPostAttempt.localId]) return;
        if (draft.submitted?.attemptLocalId !== restoredPostAttempt.localId) return;
        const content = draft.submitted.content;
        repository.adoptPendingIntent({
            kind: 'post',
            discussionId: props.target.discussionId,
            localId: restoredPostAttempt.localId,
            content,
            ...readDiscussionMentionedParticipantIdsV1(content),
            ...(restoredPostAttempt.replyTarget ? { replyTarget: restoredPostAttempt.replyTarget } : {}),
            draftSubmission: { scope: props.scope, address: draftAddress, currentness: restoredPostAttempt.currentness },
        });
        setLocalId(restoredPostAttempt.localId);
    }, [draft.submitted, draftAddress, props.scope, props.target.discussionId, repository, restoredPostAttempt, snapshot.mutations]);
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
    const send = React.useCallback(async (textContent: DiscussionMessageContentV1) => {
        if (!discussion?.capabilities.postMessages || composerBlocked) return;
        if (props.target.messageId && !threadRoot) return;
        const content = prepareDiscussionContentForPassage({ content: textContent, passage: draft.passage ?? rootPassage });
        const replyTarget = props.target.messageId ? { kind: 'message' as const, messageId: props.target.messageId } : undefined;
        if (mutation) dismissRefusal();
        const id = randomUUID();
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'post', discussionId: props.target.discussionId, localId: id, ...(replyTarget ? { replyTarget } : {}) }, { content });
        setLocalId(id);
        await repository.post({ discussionId: props.target.discussionId, localId: id, content, ...readDiscussionMentionedParticipantIdsV1(content), ...(replyTarget ? { replyTarget } : {}), draftSubmission });
    }, [composerBlocked, discussion?.capabilities.postMessages, dismissRefusal, draft, mutation, props.target.discussionId, props.target.messageId, repository, rootPassage, threadRoot]);
    // Run… posts the reviewed question as an ordinary unaddressed message through the same post owner, and
    // hands the Pattern start only the message the Home actually committed.
    const prepareAddressingMessage = React.useCallback(async (request: Readonly<{ localId: string; submittedDraft: string }>) => {
        if (!discussion?.capabilities.postMessages || composerBlocked) throw new Error('discussion_post_unavailable');
        const content = buildDiscussionContent(request.submittedDraft, []);
        if (mutation && mutation.localId !== request.localId) dismissRefusal();
        const draftSubmission = draft.captureSubmittedCurrentness({ kind: 'post', discussionId: props.target.discussionId, localId: request.localId }, { content });
        setLocalId(request.localId);
        const outcome = await repository.post({ discussionId: props.target.discussionId, localId: request.localId, content, draftSubmission });
        if (outcome.kind === 'succeeded') return { messageId: outcome.value.message.id };
        if (outcome.kind === 'checking') return { messageId: await observeCommittedPost(repository, props.target.discussionId, request.localId) };
        throw new Error(outcome.kind === 'failed' ? outcome.errorCode : 'discussion_post_approval_pending');
    }, [composerBlocked, discussion?.capabilities.postMessages, dismissRefusal, draft, mutation, props.target.discussionId, repository]);
    // The Run… chip reads the current post owner and draft only when pressed, so the chip keeps one identity.
    const prepareAddressingMessageRef = React.useRef(prepareAddressingMessage);
    prepareAddressingMessageRef.current = prepareAddressingMessage;
    const prepareRunAddressingMessage = React.useCallback((request: Readonly<{ localId: string; submittedDraft: string }>) => prepareAddressingMessageRef.current(request), []);
    const discussionAddress = React.useMemo(() => ({ serverId: props.target.address.serverId, discussionId: props.target.discussionId }), [props.target.address.serverId, props.target.discussionId]);
    const managedRuns = useDiscussionManagedWorkflowRuns({ discussion: discussionAddress, accountLifetime: props.accountLifetime,
        enabled: props.active && !accessRevoked });
    const draftTextRef = React.useRef(draft.text);
    draftTextRef.current = draft.text;
    const readComposerDraft = React.useCallback(() => draftTextRef.current, []);
    const runChips = useDiscussionRunChips({ discussion: discussionAddress, accountLifetime: props.accountLifetime,
        readDraft: readComposerDraft, prepareAddressingMessage: prepareRunAddressingMessage, onStarted: managedRuns.retry,
        disabled: !discussion?.capabilities.postMessages || composerBlocked || mutationsDisabled || discussion?.archivedAt !== null });
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
    const displayMessages = React.useMemo<readonly DiscussionDisplayMessage[]>(() => {
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
    const sourceSubagents = props.source?.activity.subagents ?? NO_SOURCE_SUBAGENTS;
    const readSourceExecutionRunEntry = props.source?.activity.readExecutionRunEntry ?? readNoSourceExecutionRunEntry;
    const items = React.useMemo(() => buildDiscussionTimelineItems({ serverId: props.target.address.serverId, discussionId: props.target.discussionId, messages: displayMessages, subagents: sourceSubagents, readExecutionRunEntry: readSourceExecutionRunEntry, workflowRuns: managedRuns.runs }), [displayMessages, managedRuns.runs, props.target.address.serverId, props.target.discussionId, readSourceExecutionRunEntry, sourceSubagents]);
    // C7: a shared Bot's outward request waits in the thread that asked, under the Bot's reply to that
    // ask (or the ask itself while the Bot is blocked on it), joined by the request's admitted cause.
    const requesterApprovals = useDiscussionRequesterApprovals(discussionAddress, mentionedSessionAddresses);
    const requesterApprovalsByMessage = React.useMemo(() => placeDiscussionRequesterApprovals(displayMessages, requesterApprovals), [displayMessages, requesterApprovals]);
    // Rows render through the list's cell cache: a decided request must reach its mounted row (the
    // receipt replaces the card in place), so its placement and versions are the list's data version.
    const requesterApprovalsVersion = React.useMemo(() => [...requesterApprovalsByMessage].map(([messageId, approvals]) => `${messageId}:${approvals
        .map((approval) => `${approval.artifact.id}@${approval.artifact.bodyVersion ?? ''}:${approval.artifact.updatedAt}:${approval.parsed.request.status}`).join(',')}`).join(';'), [requesterApprovalsByMessage]);
    const discussionReturnHref = React.useMemo(() => buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: props.target.address.serverId }, discussionId: props.target.discussionId } }), [props.target.address.serverId, props.target.discussionId]);
    const messageGroupStarts = React.useMemo(() => new Set(items.flatMap((item, index) => {
        if (item.kind !== 'human_message') return [];
        const previous = items[index - 1];
        return previous?.kind !== 'human_message' || startsDiscussionMessageGroup(item.message, previous.message)
            ? [item.message.id]
            : [];
    })), [items]);
    // A passage is quoted where talk about it starts; replies and suggestions on the same passage don't repeat it.
    const repeatedPassages = React.useMemo(() => {
        const repeated = new Set<string>();
        let shown: DocPassageRefV1 | null = null;
        for (const item of items) {
            if (item.kind !== 'human_message') continue;
            const passage = readDiscussionContentPassage(item.message.content);
            if (passage && shown && isSameDocPassage(passage, shown)) repeated.add(item.message.id);
            shown = passage;
        }
        return repeated;
    }, [items]);
    const openRun = React.useCallback((item: Extract<DiscussionTimelineItem, { kind: 'agent_activity_reference' }>) => {
        const runId = item.entry.runId ?? item.subagent.runRef?.runId;
        if (runId) props.source?.agentConversation.openAgentConversation(runId, resolveSessionAgentActivityPresentation({ entry: item.entry, subagent: item.subagent }).title);
    }, [props.source]);
    const askAgentAboutSelection = React.useCallback((selected: ReadonlyArray<TranscriptSelectionToolbarMessage>) => {
        const prepared = prepareSelection(selected);
        if (!prepared || !props.source) return;
        const source = { ...prepared.source, draftCorrelationId: randomUUID() };
        if (device === 'phone') {
            const navigationIntent = publishInteractiveExecutionRunDraftNavigationIntent({
                address: props.source.address,
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
    }, [device, pane, prepareSelection, props.source, router]);
    type PreparedSelectionHandoff = NonNullable<ReturnType<typeof prepareSelection>>;
    const [selectionHandoffRetry, setSelectionHandoffRetry] = React.useState<PreparedSelectionHandoff | null>(null);
    const [selectionHandoffRetrying, setSelectionHandoffRetrying] = React.useState(false);
    const selectionHandoffInFlight = React.useRef<Promise<void> | null>(null);
    const performSelectionHandoff = React.useCallback(async (prepared: PreparedSelectionHandoff) => {
        const source = props.source;
        if (!source?.canSendToSession) return;
        if (selectionHandoffInFlight.current) {
            await selectionHandoffInFlight.current;
            return;
        }
        const operation = sendDiscussionSelectionToSession({
            sessionId: source.address.sessionId,
            serverId: source.address.serverId,
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
                ? () => router.replace(buildScopedSessionRouteHref(source.address) as Href)
                : pane.closeDetails,
            focusPrimaryComposer: () => requestRegisteredSessionComposerFocus(source.address),
        }).then(() => undefined);
        selectionHandoffInFlight.current = operation;
        try {
            await operation;
        } finally {
            if (selectionHandoffInFlight.current === operation) {
                selectionHandoffInFlight.current = null;
            }
        }
    }, [device, pane.closeDetails, props.source, router, sendTemplate]);
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
    const dataKey = React.useMemo(() => `discussion:${JSON.stringify([props.scope.serverId, props.scope.accountId, props.target.discussionId])}`, [props.scope.accountId, props.scope.serverId, props.target.discussionId]);
    const read = React.useMemo(() => createDiscussionVisibleReadController({
        writeCursor: (seq) => repository.setReadState(props.target.discussionId, seq),
    }), [props.target.discussionId, repository]);
    React.useEffect(() => read.updateEligibility({
        activeAndVisible: props.active && hostViewed && (props.standaloneSurface || surfaceVisible),
        lastReadSeq: discussion?.lastReadSeq ?? null,
    }), [discussion?.lastReadSeq, hostViewed, props.active, props.standaloneSurface, read, surfaceVisible, thread?.status]);
    // The rows the list last reported on screen. Readability can change while a row
    // stays visible (a locked placeholder opens once the Discussion key arrives), which
    // produces no new viewability callback, so admission is re-evaluated from here.
    const [visibleMessageIds, setVisibleMessageIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const onVisible = React.useCallback((info: Readonly<{ viewableItems: readonly ViewToken<DiscussionTimelineItem<DiscussionDisplayMessage>>[] }>) => {
        setVisibleMessageIds(new Set(info.viewableItems.flatMap((token) => (
            token.isViewable !== false && token.item?.kind === 'human_message' ? [token.item.message.id] : []
        ))));
    }, []);
    const shownProposalDocs = React.useMemo(() => props.active && hostViewed && (props.standaloneSurface || surfaceVisible)
        ? [...new Set(messages.flatMap(message => visibleMessageIds.has(message.id)
            && message.content && isDiscussionDocEditProposalContentV1(message.content)
            && (!message.docEditProposalDispositionV1 || message.docEditProposalDispositionV1.state === 'open')
                ? [message.content.proposal.target.ref.artifactId] : []))]
        : [], [hostViewed, messages, props.active, props.standaloneSurface, surfaceVisible, visibleMessageIds]);
    const [proposalDocReads, setProposalDocReads] = React.useState<Readonly<Record<string, ProposalDocObservation>>>({});
    const reportProposalDocRead = React.useCallback<ReportProposalDocRead>((artifactId, client, read) => {
        setProposalDocReads(previous => {
            if (read === null) {
                if (previous[artifactId]?.client !== client) return previous;
                const next = { ...previous };
                delete next[artifactId];
                return next;
            }
            if (previous[artifactId]?.client === client && previous[artifactId]?.read === read) return previous;
            return { ...previous, [artifactId]: { client, read } };
        });
    }, []);
    const readProposalDoc = (artifactId: string): AdmittedDocRead => {
        const entry = proposalDocReads[artifactId];
        return shownProposalDocs.includes(artifactId) && entry?.client === proposalClient ? entry.read : LOADING_PROPOSAL_DOC;
    };
    // Legend retains its renderItem through refs; currentness/refusal must reach its mounted cells.
    const rowsVersion = JSON.stringify([requesterApprovalsVersion, shownProposalDocs.map(artifactId => {
        const read = readProposalDoc(artifactId);
        return read.status === 'ready'
            ? [artifactId, read.status, read.value.artifact.revision, read.value.artifact.seq, read.value.artifact.access]
            : [artifactId, read.status];
    })]);
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
        pane.closeDetails();
    }, [pane, props.onClose, props.target]);
    const retryDiscussion = React.useCallback(() => repository.refreshDiscussion(props.target.discussionId), [props.target.discussionId, repository]);
    const roster = participantManagement.roster;
    const presentAccountIds = React.useMemo(() => new Set(presentViewers.map((viewer) => viewer.account.accountId)), [presentViewers]);
    const leaveDiscussion = React.useCallback(() => {
        void participantManagement.requestLeave().then((outcome) => { if (outcome?.kind === 'succeeded') closeSurface(); });
    }, [closeSurface, participantManagement.requestLeave]);
    const retryAction = React.useMemo(() => ({ label: t('session.collaboration.discussion.retry'), onPress: retryDiscussion }), [retryDiscussion]);
    const phoneChrome = useDiscussionPhoneChrome(props.standaloneSurface);
    const stateChrome = (node: React.ReactElement) => <DiscussionPhoneChrome enabled={phoneChrome} onBack={closeSurface}>{node}</DiscussionPhoneChrome>;
    if (accessRevoked) {
        return stateChrome(<SurfaceStateCard
            testID="session-discussion-details-state"
            kind="denied"
            title={t('sessionConversation.discussion.revokedTitle')}
            reason={t('sessionConversation.discussion.revokedReason')}
            action={{ label: t('sessionConversation.discussion.closeTab'), onPress: closeSurface }}
        />);
    }
    if (!thread || thread.status === 'idle' || (thread.status === 'loading' && !discussion)) {
        return stateChrome(<SurfaceStateCard testID="session-discussion-details-state" kind="loading" title={t('sessionConversation.discussion.loadingTitle')} />);
    }
    if (!discussion) {
        const status = thread.status;
        if (status === 'offline') {
            return stateChrome(<SurfaceStateCard
                testID="session-discussion-details-state"
                kind="unavailable"
                title={t('sessionConversation.discussion.offlineTitle')}
                reason={t('sessionConversation.discussion.offlineReason')}
                action={retryAction}
            />);
        }
        if (status === 'locked') {
            return stateChrome(<SurfaceStateCard
                testID="session-discussion-details-state"
                kind="error"
                title={t('sessionConversation.discussion.lockedTitle')}
                reason={t('sessionConversation.discussion.lockedReason')}
                action={retryAction}
                diagnosticCode={thread.errorCode ?? 'locked'}
            />);
        }
        return stateChrome(<SurfaceStateCard
            testID="session-discussion-details-state"
            kind="error"
            title={t('sessionConversation.discussion.errorTitle')}
            reason={discussionFailureLabel(thread.errorCode ?? undefined)}
            action={retryAction}
            diagnosticCode={thread.errorCode ?? null}
        />);
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
        ? discussionLifecycleFailureLabel(lifecycleFailure.outcome, lifecycleFailure.operation)
        : threadStaleLabel === null && draft.status === 'offline'
            ? t('session.collaboration.discussion.offline')
            : draft.status === 'unsupported'
                ? t('sessionDrafts.status.unsupported')
                : draft.status === 'error'
                    ? t('session.collaboration.discussion.loadError')
                    : null;
    const participantsPopover = (
        <DiscussionParticipantsPopover
            scope={props.scope}
            accountLifetime={props.accountLifetime}
            onChanged={refreshRoster}
            discussionId={props.target.discussionId}
            discussionTitle={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
            serverId={props.target.address.serverId}
            viewerAccountId={props.scope.accountId}
            roster={roster}
            accountActors={participantProfiles.accounts}
            presentAccountIds={presentAccountIds}
            resolveAccountLabel={resolveAccountLabel}
            onLeave={leaveDiscussion}
            management={participantManagement}
            canManage={discussion.capabilities.manageAccess && discussion.archivedAt === null}
            onLeft={closeSurface}
        />
    );
    const rosterLine = roster ? formatDiscussionRosterLine(summarizeDiscussionRoster(roster)) : null;
    // A phone folds the header into its one navigation band; the way back to the source moves into ⋯.
    const anchorOpen = anchorFact && anchorFact.kind !== 'diffStat' ? anchorFact.onPress : undefined;
    const phoneMenuActions: readonly PageHeaderMenuAction[] = anchorFact && anchorOpen
        ? [{ id: 'open-anchor', title: t('session.collaboration.discussion.openAnchor', { name: anchorFact.kind !== 'diffStat' ? anchorFact.text : '' }), onSelect: anchorOpen }, ...lifecycleActions]
        : lifecycleActions;
    const phoneHeader = phoneChrome && rename === null ? <ChatHeaderView
        title={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
        subtitle={[rosterLine, anchorFact && anchorFact.kind !== 'diffStat' ? anchorFact.text : null].filter(Boolean).join(' · ') || undefined}
        onBackPress={closeSurface}
        constrainWidth={false}
        rightElement={<View style={styles.headerActions}>
            {participantsPopover}
            {phoneMenuActions.length > 0 ? <PageHeaderMenu triggerTestID="session-discussion-actions-menu" actions={phoneMenuActions} /> : null}
        </View>}
    /> : null;
    return <TranscriptMessageSelectionBoundary sessionId={dataKey} eligibleMessageIdsInOrder={selectableMessages.map((message) => message.id)}>
        {shownProposalDocs.map(artifactId => <DiscussionProposalDocRead key={artifactId} artifactId={artifactId}
            client={proposalClient} accountLifetime={props.accountLifetime} onRead={reportProposalDocRead} />)}
        <View style={styles.root} testID="session-discussion-details">
            {phoneHeader ?? <DetailsTabHeader
                testID="session-discussion-header"
                title={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
                // Who is in it and who can read it (lab T2-A header line); live presence leads it.
                meta={roster ? (() => {
                    const facts = summarizeDiscussionRoster(roster);
                    return [
                        { key: 'roster', text: formatDiscussionRosterLine(facts), testID: 'session-discussion-roster' },
                        ...(anchorFact ? [anchorFact] : []),
                        { key: 'audience', text: facts.inherited ? t('session.collaboration.discussion.participants.teamCanRead') : t('session.collaboration.discussion.participants.invitedOnly'), icon: facts.inherited ? 'users' as const : 'lock' as const },
                    ];
                })() : undefined}
                actions={<View style={styles.headerActions}>
                {discussion.capabilities.manageAccess && discussion.archivedAt === null ? <DiscussionInviteButton
                    scope={props.scope}
                    accountLifetime={props.accountLifetime}
                    roster={roster}
                    management={participantManagement}
                    discussionId={props.target.discussionId}
                    discussionTitle={discussion.title ?? t('session.collaboration.discussion.encryptedTitle')}
                    onChanged={refreshRoster}
                /> : null}
                {participantsPopover}</View>}
                // Who is in it leads the line (lab T2-A); live presence follows the faces when someone is here.
                metaLeadingKind="mark"
                metaLeading={roster || presenceLabel ? <View style={styles.presenceRow}>
                            {roster ? <DiscussionRosterFaces roster={roster} accountActors={participantProfiles.accounts} viewerAccountId={props.scope.accountId} accessibilityLabel={formatDiscussionRosterLine(summarizeDiscussionRoster(roster))} /> : null}
                            {presenceLabel ? <>
                                <DiscussionPresenceFaces viewers={presentViewers} stale={presenceStale} />
                                <Text testID="session-discussion-presence" accessibilityLiveRegion="polite" style={styles.headerMeta} numberOfLines={1}>{presenceLabel}</Text>
                                {roster ? <Text style={styles.headerMeta}>·</Text> : null}
                            </> : null}
                </View> : null}
                controls={rename !== null ? <TextInput testID="session-discussion-rename-input" style={[styles.input, { flex: 1 }]} value={rename} onChangeText={setRename} accessibilityLabel={t('session.collaboration.discussion.rename')} autoFocus /> : undefined}
                buttons={rename !== null ? [{ label: t('common.save'), disabled: !rename.trim() || mutationsDisabled, onPress: () => void lifecycle('rename') }] : undefined}
                menu={rename === null && lifecycleActions.length > 0 ? <PageHeaderMenu triggerTestID="session-discussion-actions-menu" actions={lifecycleActions} /> : undefined}
            />}
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
                <TranscriptListShell<DiscussionTimelineItem<DiscussionDisplayMessage>>
                    key={dataKey}
                    dataKey={dataKey}
                    data={items}
                    extraData={rowsVersion}
                    frame={frame}
                    webDomObservation={observation}
                    keyExtractor={(item) => item.kind === 'human_message' ? `message:${item.message.localId ?? item.message.id}` : item.kind === 'workflow_run' ? `workflow:${item.run.id}` : `run:${item.entry.runId ?? item.subagent.id}`}
                    onViewableItemsChanged={onVisible}
                    viewabilityConfig={VIEWABILITY}
                    onStartReached={thread.hasMoreOlder ? () => void repository.loadOlderMessages(props.target.discussionId) : undefined}
                    onStartReachedThreshold={0.2}
                    header={thread.hasMoreOlder ? <Pressable style={styles.retry} accessibilityRole="button" accessibilityLabel={t('session.collaboration.discussion.loadOlder')} onPress={() => void repository.loadOlderMessages(props.target.discussionId)}><Text style={styles.retryText}>{t('session.collaboration.discussion.loadOlder')}</Text></Pressable> : null}
                    // While the messages are still on their way the header and composer stay and the thread shows
                    // its loading rows (lab T2-ST "Loading"), never an empty claim it hasn't checked.
                    footer={items.length === 0 ? thread.status === 'loading'
                        ? <View testID="session-discussion-loading" style={[styles.loadingRows, threadColumn]}><SkeletonRows rows={4} /></View>
                        : <SurfaceStateCard testID="session-discussion-empty" kind="empty" title={t('session.collaboration.discussion.emptyActive')} /> : null}
                    renderItem={({ item }) => {
                        if (item.kind === 'workflow_run') {
                            return <DiscussionWorkflowRunRow run={item.run} metadata={managedRuns.metadataByRunId?.[item.run.id]}
                                supportsAnotherRound={managedRuns.supportsAnotherRoundByRunId?.[item.run.id]}
                                canEdit={managedRuns.callerAccessByRunId?.[item.run.id]?.canEdit === true}
                                accountLifetime={props.accountLifetime} onStarted={managedRuns.retry} />;
                        }
                        if (item.kind === 'agent_activity_reference') {
                            return <View style={styles.reference}>
                                <DiscussionAgentActivityReference entry={item.entry} subagent={item.subagent} onPress={() => openRun(item)} />
                            </View>;
                        }
                        const pendingMutation = item.message.localId === mutation?.localId ? mutation : null;
                        const parentMessage = item.message.replyTarget?.kind === 'message'
                            ? messageById.get(item.message.replyTarget.messageId) : undefined;
                        return <DiscussionMessageRow
                            message={item.message}
                            parentMessage={parentMessage}
                            parentAuthorLabel={parentMessage ? resolveDiscussionMessageAuthorLabel(parentMessage, viewer) : null}
                            onOpenMessage={openQuotedMessage}
                            authorLabel={resolveDiscussionMessageAuthorLabel(item.message, viewer)}
                            agentLabel={item.message.producerV1 ? resolveSessionLabel(item.message.producerV1.sessionId) : null}
                            startsGroup={messageGroupStarts.has(item.message.id)}
                            repeatsPassage={repeatedPassages.has(item.message.id)}
                            selectable={isCommittedDisplayMessage(item.message) && isSelectableDiscussionMessage(item.message) && item.message.id !== mutation?.localId}
                            resolveAccountLabel={resolveAccountLabel}
                            resolveSessionLabel={resolveSessionLabel}
                            proposalClient={proposalClient}
                            proposalDocRead={item.message.content && isDiscussionDocEditProposalContentV1(item.message.content)
                                ? readProposalDoc(item.message.content.proposal.target.ref.artifactId) : LOADING_PROPOSAL_DOC}
                            viewerAccountId={props.scope.accountId}
                            attributionLine={resolveDiscussionReplyAttributionLine(item.message, props.scope,
                                item.message.producerV1 ? resolveSessionLabel(item.message.producerV1.sessionId) : null)}
                            footer={requesterApprovalsByMessage.has(item.message.id) || pendingMutation ? <>
                                {requesterApprovalsByMessage.get(item.message.id)?.map((approval) => <ApprovalRequesterThreadCard
                                    key={approval.artifact.id} approval={approval} serverId={props.scope.serverId} returnHref={discussionReturnHref} />)}
                                {pendingMutation && mutationStatusLabel(pendingMutation) ? <Text testID={`session-discussion-message-status-${item.message.localId}`} accessibilityLiveRegion="polite" style={pendingMutation.status === 'failed' ? styles.error : styles.deliveryStatus}>{mutationStatusLabel(pendingMutation)}</Text> : null}
                                {pendingMutation ? <MutationRecovery mutation={pendingMutation} onRetry={() => void repository.retry(pendingMutation.localId)} onDismiss={dismissRefusal} /> : null}
                            </> : null}
                        />;
                    }}
                />
                {/* The shared selection bar floats over the thread's foot (collab lab D1), so it never
                    reserves a band of its own while nothing is selected. */}
                <View pointerEvents="box-none" style={styles.selectionToolbar}>
                <TranscriptSelectionToolbar selectableMessagesInOrder={selectableMessages} bulkCopyFormat={transcriptBulkCopyFormat} roleLabels={{ user: t('session.collaboration.discussion.collaborator'), assistant: t('voiceActivity.format.assistant') }} sendToSessionEnabled={discussion.capabilities.sendToSession && props.source?.canSendToSession === true} onSendToSession={sendSelectionToComposer} formatSelection={(selected) => prepareSelection(selected)?.text ?? null} selectionUnavailableText={t('session.collaboration.discussion.contentUnavailable')} additionalAction={discussion.capabilities.askAgent && props.source?.canLaunchExecutionRuns ? { testID: 'session-discussion-selection-ask-agent', label: t('session.collaboration.discussion.selection.askAgent'), onPress: askAgentAboutSelection } : undefined} />
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
            {waitingApprovalId && attention ? <View style={styles.stateLine}><SurfaceStateCard
                testID="session-discussion-waiting-approval"
                size="line"
                kind="warning"
                accessibilitySemantics="status"
                title={attention.attentionReason === 'draft_waiting'
                    ? t('session.collaboration.discussion.home.draftWaiting')
                    : t('session.collaboration.discussion.home.approvalPending')}
                action={{ testID: 'session-discussion-waiting-approval-review', label: t('approvals.review'), onPress: reviewWaiting }}
            /></View> : null}
            {/* A thread re-attached from its Doc: the next comment is posted on this passage (lab K1-S's passage head). */}
            {draft.passage && discussion.archivedAt === null && discussion.capabilities.postMessages ? <View style={[styles.draftPassage, styles.draftPassageRow, threadColumn]}>
                <View style={styles.draftPassageQuote}><ArtifactPassageQuote testID="discussion-draft-passage-quote" passage={sourceRefused ? null : draft.passage} /></View>
                <IconButton testID="discussion-draft-passage-remove" size={28} variant="plain"
                    icon={<Icon name="x" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                    accessibilityLabel={t('common.cancel')} tooltip={t('common.cancel')}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    onPress={() => draft.setPassage(null)} />
            </View> : null}
            {discussion.archivedAt !== null
                ? <View style={styles.stateLine}><SurfaceStateCard testID="session-discussion-archived" size="line" kind="unavailable" iconName="archive" title={t('session.collaboration.discussion.archivedNotice')} /></View>
                : discussion.capabilities.postMessages
                    ? <DiscussionComposer scope={props.scope} accountLifetime={props.accountLifetime} address={props.target.address} discussionId={props.target.discussionId} availability="available" value={{ text: draft.text, mentions: draft.mentions }} onChange={draft.setComposer} disabled={composerBlocked || mutationsDisabled} onSend={(content) => void send(content)} prepareParticipantMentions={prepareParticipantMentions} extraActionChips={runChips} />
                    : <View style={styles.stateLine}><SurfaceStateCard testID="session-discussion-read-only" size="line" kind="denied" title={t('session.collaboration.discussion.locked')} /></View>}
        </View>
    </TranscriptMessageSelectionBoundary>;
}

/**
 * A phone shows a Discussion the way it shows a Session (lab T2-Ap): one navigation band with Back, the
 * name and its who-and-where line, and the band's few controls. The pushed route hides its own bar for
 * it, so every state of the page, loading and refused included, keeps Back.
 */
function useDiscussionPhoneChrome(standaloneDiscussion: boolean): boolean {
    return useSurfaceStateSize() === 'phone' && standaloneDiscussion;
}

function DiscussionPhoneChrome(props: Readonly<{
    enabled: boolean;
    title?: string;
    subtitle?: string;
    right?: React.ReactNode;
    onBack?: () => void;
    children: React.ReactNode;
}>) {
    if (!props.enabled) return <>{props.children}</>;
    return <View style={styles.root} testID="session-discussion-phone-chrome">
        <ChatHeaderView
            title={props.title ?? t('session.collaboration.discussion.title')}
            subtitle={props.subtitle}
            onBackPress={props.onBack}
            rightElement={props.right}
            constrainWidth={false}
        />
        {props.children}
    </View>;
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
    message: DiscussionDisplayMessage;
    parentMessage?: DiscussionDisplayMessage;
    parentAuthorLabel: string | null;
    onOpenMessage: (messageId: string) => void;
    startsGroup: boolean;
    repeatsPassage: boolean;
    selectable: boolean;
    resolveAccountLabel: (accountId: string) => string | null;
    resolveSessionLabel: (sessionId: string) => string | null;
    authorLabel: string;
    /** The Session that answered, named through this Home's title projection; null when not readable here. */
    agentLabel: string | null;
    proposalClient: ArtifactActionsClient;
    proposalDocRead: AdmittedDocRead;
    viewerAccountId: string;
    /** "Asked by … · answered by …" from the reply's stamped cause; null when no person asked. */
    attributionLine: string | null;
    footer: React.ReactNode;
}>) => {
    const { message } = props;
    const { theme } = useUnistyles();
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
    // Save as decision opens from this message's action, as on a Session answer; its state lives out here
    // because the revealed action slot hides as soon as the pointer leaves the row for the sheet.
    const decisionAnchorRef = React.useRef<View>(null);
    const [decisionOpen, setDecisionOpen] = React.useState(false);
    const [decisionSaved, setDecisionSaved] = React.useState(false);
    const decisionSource = props.selectable && message.messageRef && message.content
        && !isDiscussionDocEditProposalContentV1(message.content) ? message.messageRef : null;
    const contentWidth = useLayoutMaxWidthStyle();
    const actor = message.accountActor;
    const faceAccountId = actor !== null && actor.accountId === message.authorAccountId ? actor.accountId : message.authorAccountId;
    const passage = props.repeatsPassage ? null : readDiscussionContentPassage(message.content);
    const outcome = resolveDiscussionReplyOutcome(message);
    const speaker = message.producerV1 ? props.agentLabel ?? props.authorLabel : props.authorLabel;
    // A participant that passed, failed or stopped is one quiet attributed line in the thread (lab T2-A
    // "Release bot passed · nothing to add"), not a message: nobody has to read past it.
    if (outcome === 'pass' || outcome === 'failed' || outcome === 'cancelled') {
        const reason = message.content ? textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel).trim() : '';
        const said = t(outcome === 'pass' ? 'session.collaboration.discussion.reply.passed'
            : outcome === 'failed' ? 'session.collaboration.discussion.reply.failed'
                : 'session.collaboration.discussion.reply.cancelled', { name: speaker });
        return <HappierThreadMessage testID={`session-discussion-outcome-${outcome}-${message.id}`} startsGroup={false}
            space={theme.space} selectionColors={theme.colors.state.active} style={contentWidth}>
            <Text accessibilityLiveRegion="polite" style={[styles.meta, outcome === 'failed' ? styles.outcomeFailed : null]}>
                {reason ? `${said} · ${reason}` : said}
            </Text>
        </HappierThreadMessage>;
    }
    return <HappierThreadMessage
        testID={`session-discussion-message-group-${props.startsGroup ? 'start' : 'continuation'}-${message.id}`}
        startsGroup={props.startsGroup}
        selected={selection.isSelected}
        space={theme.space}
        selectionColors={theme.colors.state.active}
        style={contentWidth}
        {...(props.selectable ? hover.hoverProps : null)}
        face={props.startsGroup && faceAccountId
                ? <Avatar id={faceAccountId} imageUrl={actor?.profile?.avatarUrl ?? null} size={28} />
                : null}
        attribution={props.startsGroup ? <>
                <Text testID={`session-discussion-message-actor-${message.id}`} style={styles.messageAuthor}>{speaker}</Text>
                {message.producerV1 ? <Text testID={`session-discussion-message-producer-${message.id}`} style={styles.meta}>{t('session.collaboration.discussion.viaAgent')}</Text> : null}
                {message.createdAt > 0 ? <Text testID={`session-discussion-message-timestamp-${message.id}`} accessibilityRole="text" accessibilityLabel={new Date(message.createdAt).toLocaleString()} style={styles.timestamp}>{formatShortRelativeTime(message.createdAt)}</Text> : null}
        </> : null}
        trailing={props.selectable ? <RowActionRevealSlot revealed={selectRevealed || decisionOpen} style={styles.selectAffordance} testID={`session-discussion-select-slot-${message.id}`}>
            <View style={styles.rowActions}>
                {decisionSource && !selection.isSelectionMode ? decisionSaved
                    ? <View testID={`session-discussion-saved-decision-${message.id}`} style={styles.savedDecision} accessible
                        accessibilityRole="text" accessibilityLabel={t('memoryContext.memory.savedAsDecision')} accessibilityLiveRegion="polite">
                        <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                    </View>
                    : <View ref={decisionAnchorRef} collapsable={false}>
                        <IconButton testID={`session-discussion-save-decision-${message.id}`} size={28} variant="plain"
                            icon={<Icon name="check-circle" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                            accessibilityLabel={t('memoryContext.memory.saveAsDecision')} tooltip={t('memoryContext.memory.saveAsDecision')}
                            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                            onPress={() => setDecisionOpen(true)} />
                    </View> : null}
                <SelectMessageButton messageId={message.id} enabled visible role="user" previewText={textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel)} testID={`session-discussion-select-${message.id}`} />
            </View>
        </RowActionRevealSlot> : null}
    >
            {props.repeatsPassage ? null : passage || message.replyTarget?.kind === 'doc_passage'
                        ? <ArtifactPassageQuote testID={`discussion-reply-quote-${message.id}`} passage={passage} />
                        : message.replyTarget?.kind === 'message' ? <ReplyQuote testID={`discussion-reply-quote-${message.id}`} kind="message"
                            source={props.parentMessage?.content
                                ? { state: 'available', label: props.parentAuthorLabel ?? t('session.collaboration.discussion.quote.message'),
                                    text: textOf(props.parentMessage.content, props.resolveAccountLabel, props.resolveSessionLabel),
                                    onPress: () => props.onOpenMessage(props.parentMessage!.id) }
                                : { state: 'unavailable', label: t('session.collaboration.discussion.quote.message'),
                                    reason: t('session.collaboration.discussion.quote.unavailable') }} /> : null}
            {message.content && isDiscussionDocEditProposalContentV1(message.content)
                ? <ArtifactEditProposal testID={`discussion-proposal-${message.id}`} client={props.proposalClient}
                    docRead={props.proposalDocRead}
                    proposalRef={message.messageRef ?? null} proposal={message.content.proposal}
                    disposition={message.docEditProposalDispositionV1} viewerAccountId={props.viewerAccountId}
                    resolveAccountLabel={props.resolveAccountLabel}
                    proposer={message.producerV1 ? { label: speaker, mention: { sessionId: message.producerV1.sessionId } }
                        : message.authorAccountId ? { label: speaker, mention: { accountId: message.authorAccountId } } : null} />
                : <Text testID={`session-discussion-message-content-${message.id}`} style={styles.messageText}>{renderDiscussionMessageContent(message, props.resolveAccountLabel, props.resolveSessionLabel)}</Text>}
            {props.attributionLine ? <Text testID={`session-discussion-message-attribution-${message.id}`} style={styles.meta}>{props.attributionLine}</Text> : null}
            {/* An addressed answer read the conversation only up to the question that asked it (C3 cutoff). */}
            {outcome === 'answer' ? <Text testID={`session-discussion-message-cutoff-${message.id}`} style={styles.meta}>{t('session.collaboration.discussion.reply.readUpTo')}</Text> : null}
            {message.participantDeliveryV1?.map((delivery) => <Text
                key={delivery.participantSessionId}
                testID={`session-discussion-participant-held-${message.id}-${delivery.participantSessionId}`}
                accessibilityLiveRegion="polite"
                style={styles.meta}
            >{t('session.collaboration.discussion.participantHeld', {
                participant: props.resolveSessionLabel(delivery.participantSessionId) ?? t('session.collaboration.discussion.heldParticipant'),
            })}</Text>)}
            {props.footer}
            {decisionOpen && decisionSource ? <SaveMemoryDecisionSheet
                seed={seedMemoryDecisionFromMessage(decisionSource, textOf(message.content, props.resolveAccountLabel, props.resolveSessionLabel))}
                anchorRef={decisionAnchorRef} onClose={() => setDecisionOpen(false)}
                onSaved={() => { setDecisionOpen(false); setDecisionSaved(true); }} /> : null}
    </HappierThreadMessage>;
});

/**
 * Exactly one exit per settled state: an unknown outcome or transient failure
 * retries the same identity; a definitive refusal is dismissed and the draft
 * stays for a fresh attempt.
 */
/** Waits for the post owner's reconciliation to observe this exact local id as a committed message. */
function observeCommittedPost(repository: DiscussionRepository, discussionId: string, localId: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const check = (): boolean => {
            const snapshot = repository.getSnapshot();
            const committed = snapshot.threads[discussionId]?.messages.find((message) => message.localId === localId);
            if (committed) { resolve(committed.id); return true; }
            const status = snapshot.mutations[localId]?.status;
            if (status === 'failed' || status === 'approval_pending' || status === undefined) {
                reject(new Error(snapshot.mutations[localId]?.errorCode ?? 'discussion_post_unresolved'));
                return true;
            }
            return false;
        };
        if (check()) return;
        const unsubscribe = repository.subscribe(() => { if (check()) unsubscribe(); });
    });
}

function MutationRecovery(props: Readonly<{ mutation: DiscussionRepositoryMutation; onRetry: () => void; onDismiss: () => void }>) {
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
