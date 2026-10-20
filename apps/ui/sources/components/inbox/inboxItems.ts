import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import { classifyInboxSessionCandidate, type InboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { isOpenAccountNotice, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createInboxItemRoute, readInboxApprovalServerId, resolveInboxItemPageRoute, type InboxItemFocus } from './inboxItemFocus';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import type { SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { readApprovalQuickActions, type ApprovalQuickActions } from '@/components/approvals/approvalQuickActions';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { readDiscussionMessagePreview } from '@/components/discussions/discussionTimelineProjection';
import { readInboxSessionTitle } from './sessionAttention/inboxSessionPrivacy';
import { presentInboxWorkflowRun } from './inboxWorkflowRunPresentation';
import { admittedInboxDiscussionOccurrences, inboxItemView, type InboxDiscussionSource, type InboxItemView, type InboxItemType } from './inboxItemProjection';
export { inboxItemView, type InboxDiscussionSource, type InboxItemView, type InboxItemType } from './inboxItemProjection';
export const INBOX_ITEM_VIEWS = ['needs_you', 'updates', 'mentions'] as const satisfies readonly InboxItemView[];
export function getInboxNeedsYouItemTypes() {
    return ['approval', 'decision', 'blocked'] as const;
}
export type AccountNoticeInboxEntry = AccountNoticeArtifact;
export type InboxItem = Readonly<{
    key: string;
    producer: 'live' | 'notice';
    type: InboxItemType;
    view: InboxItemView;
    title: string;
    context: string | null;
    createdAt: number;
    read: boolean;
    focus: InboxItemFocus;
    pageRoute: string;
    /** Only the shared approval review owner can offer unchanged one-shot decisions. */
    approvalQuickActions?: ApprovalQuickActions;
    /** The owning record, never a mirrored Inbox lifecycle. */
    source: Readonly<{ kind: string; id: string; serverId: string; displayName?: string | null }>;
    /** Account byline or producing Session name; never inferred from the source owner. */
    author?: Readonly<{ name: string; isSelf?: boolean; avatar?: ReturnType<typeof resolveAccountActorPresentation>['avatar'] }> | null;
    excerpt?: string | null;
    question?: SessionQuestionContextV1 & Readonly<{
        requestId: string;
        currentHandler: Readonly<{ kind: 'person' }> | Readonly<{ kind: 'session'; address: SessionAddress }>;
    }>;
    discussion?: Readonly<{
        accountId: string;
        messageRef: DiscussionOpenedMessageV1['messageRef'];
        seq: number;
        anchor: DiscussionAnchorV1 | null;
        replyTarget?: DiscussionOpenedMessageV1['replyTarget'];
        proposalDisposition?: DiscussionOpenedMessageV1['docEditProposalDispositionV1'];
    }>;
}>;
export type InboxItemsInput = Readonly<{
    workGroups: readonly InboxWorkGroup[];
    sessionPresentation: InboxSessionPresentation;
    workflowServerId: string | null;
    accountServerId: string | null;
    notices: readonly AccountNoticeInboxEntry[];
    /** Already resolved package names from the app's Account-scoped plugin projection. */
    pluginDisplayNames?: ReadonlyMap<string, string>;
    /** Loaded exact-Home requester names, keyed by their owning approval Artifact. */
    approvalSourceDisplayNames?: ReadonlyMap<string, string | null>;
    discussions?: InboxDiscussionSource | null;
}>;


/** One transient row projection over live owners and private Account notice Artifacts. */
export function buildInboxItems(input: InboxItemsInput, previous: readonly InboxItem[] = []): readonly InboxItem[] {
    const rows: InboxItem[] = [];
    for (const group of input.workGroups) for (const item of group.items) {
        if (item.kind === 'session') {
            const candidate = item.entry.candidate;
            const serverId = candidate.address?.serverId ?? candidate.serverId;
            if (!serverId) continue;
            const question = item.entry.pendingUserActions[0];
            const { type } = classifyInboxSessionCandidate(candidate, question?.questionV1?.type);
            const focus = { kind: 'session', id: candidate.sessionId, serverId } as const;
            rows.push({ key: item.key, producer: 'live', type, view: inboxItemView(type), title: candidate.title,
                context: candidate.subtitle || null, createdAt: candidate.session.updatedAt, read: false, focus,
                ...(question?.questionV1 ? { question: { ...question.questionV1, requestId: question.id,
                    currentHandler: question.currentHandler?.kind === 'session'
                        ? { kind: 'session' as const, address: { serverId, sessionId: question.currentHandler.sessionId } }
                        : { kind: 'person' as const } } } : {}),
                pageRoute: resolveInboxItemPageRoute(focus), source: { kind: 'session', id: candidate.sessionId, serverId, displayName: candidate.title } });
        } else if (item.kind === 'workflow_run') {
            if (!input.workflowServerId) continue;
            const focus = { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId } as const;
            const { type, view } = presentInboxWorkflowRun(item.row.summary);
            rows.push({ key: item.key, producer: 'live', type, view,
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata)), context: item.heldStepLabel,
                createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'workflow_run', id: item.runId, serverId: input.workflowServerId,
                    displayName: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata)) } });
        } else if (item.kind === 'automation_run') {
            const run = item.row.automation;
            const serverId = group.root.kind === 'automation' ? group.root.serverId : null;
            if (!run || !serverId) continue;
            const focus = { kind: 'automation_run', id: run.id, automationId: run.automationId, serverId } as const;
            rows.push({ key: item.key, producer: 'live', type: 'update', view: 'updates', title: run.automationId,
                context: null, createdAt: item.row.updatedAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'automation_run', id: run.id, serverId, displayName: null } });
        } else if (item.kind === 'approval') {
            const focus = { kind: 'approval', id: item.artifact.id,
                serverId: readInboxApprovalServerId(item.artifact.header) || input.accountServerId || '' } as const;
            const approvalQuickActions = readApprovalQuickActions(item.artifact, focus.serverId);
            rows.push({ key: item.key, producer: 'live', type: 'approval', view: 'needs_you', title: item.artifact.title ?? '',
                context: null, createdAt: item.artifact.createdAt, read: false, focus, pageRoute: resolveInboxItemPageRoute(focus),
                ...(approvalQuickActions ? { approvalQuickActions } : {}),
                source: { kind: 'approval', id: item.artifact.id, serverId: focus.serverId,
                    displayName: input.approvalSourceDisplayNames?.get(item.artifact.id) ?? null } });
        } else {
            const serverId = item.session.serverId;
            if (!serverId) continue;
            const title = readInboxSessionTitle(item.session, serverId);
            const focus = { kind: 'session', id: item.session.id, serverId } as const;
            rows.push({ key: item.key, producer: 'live', type: 'update', view: 'updates',
                title, context: null, createdAt: item.session.updatedAt,
                read: true, focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'session', id: item.session.id, serverId, displayName: title } });
        }
    }
    for (const candidate of input.sessionPresentation.readySessions) {
        const serverId = candidate.address?.serverId ?? candidate.serverId;
        if (!serverId) continue;
        const focus = { kind: 'session', id: candidate.sessionId, serverId } as const;
        rows.push({ key: `session:${serverId}:${candidate.sessionId}`, producer: 'live', type: 'update', view: 'updates',
            title: candidate.title, context: candidate.subtitle || null, createdAt: candidate.lastTurnCompletedAt ?? candidate.session.updatedAt,
            read: false, focus, pageRoute: resolveInboxItemPageRoute(focus), source: { kind: 'session', id: candidate.sessionId, serverId, displayName: candidate.title } });
    }
    if (input.accountServerId) {
        for (const entry of input.notices) {
            if (!isOpenAccountNotice(entry.header)) continue;
            const focus = { kind: 'notice', id: entry.artifact.id, serverId: input.accountServerId } as const;
            rows.push({ key: `notice:${input.accountServerId}:${entry.artifact.id}`, producer: 'notice', type: entry.header.type,
                view: inboxItemView(entry.header.type), title: entry.header.title, context: entry.header.body ?? null,
                createdAt: entry.artifact.createdAt, read: entry.header.readAt !== undefined, focus,
                pageRoute: resolveInboxItemPageRoute(focus, { notice: entry.header }),
                author: null, excerpt: entry.header.body ?? entry.header.excerpt ?? null,
                source: { kind: 'account_notice', id: entry.artifact.id, serverId: input.accountServerId,
                    displayName: entry.header.source.kind === 'plugin'
                        ? input.pluginDisplayNames?.get(entry.header.source.pluginId) ?? null : null } });
        }
    }
    if (input.discussions) {
        const { scope } = input.discussions;
        for (const { discussion, message, type } of admittedInboxDiscussionOccurrences(input.discussions)) {
            const producerName = message.producerV1 ? input.discussions.sessionDisplayNames?.get(message.producerV1.sessionId) : null;
            const focus = { kind: 'discussion', serverId: scope.serverId, id: discussion.id, messageId: message.id } as const;
            rows.push({ key: `discussion:${scope.serverId}:${discussion.id}:${message.id}`, producer: 'live',
                type, view: inboxItemView(type), title: discussion.title ?? discussion.id, context: null,
                createdAt: message.createdAt, read: discussion.lastReadSeq !== null && message.seq <= discussion.lastReadSeq,
                focus, pageRoute: resolveInboxItemPageRoute(focus),
                source: { kind: 'discussion', id: discussion.id, serverId: scope.serverId, displayName: discussion.title },
                author: message.producerV1 ? producerName ? { name: producerName } : null
                    : message.accountActor && message.accountActor.accountId === message.authorAccountId
                        ? resolveAccountActorPresentation({ ...message.accountActor, serverId: scope.serverId }, scope) : null,
                excerpt: readDiscussionMessagePreview(message.content, {
                    account: accountId => {
                        const actor = discussion.participantAccounts?.find(candidate => candidate.accountId === accountId)
                            ?? (message.accountActor?.accountId === accountId ? message.accountActor : null);
                        return actor ? resolveAccountActorPresentation({ ...actor, serverId: scope.serverId }, scope).name : null;
                    },
                    session: sessionId => input.discussions?.sessionDisplayNames?.get(sessionId) ?? null,
                }),
                discussion: { accountId: scope.accountId, messageRef: message.messageRef, seq: message.seq, anchor: discussion.anchor,
                    ...(message.replyTarget ? { replyTarget: message.replyTarget } : {}),
                    ...(message.docEditProposalDispositionV1 ? { proposalDisposition: message.docEditProposalDispositionV1 } : {}) } });
        }
    }
    const old = new Map(previous.map(row => [row.key, row]));
    const reconciled = rows.map(row => {
        const before = old.get(row.key);
        return before && sameItem(before, row) ? before : row;
    });
    return previous.length === reconciled.length && reconciled.every((row, index) => row === previous[index]) ? previous : reconciled;
}

export function selectInboxItemsForView(items: readonly InboxItem[], view: InboxItemView): readonly InboxItem[] {
    const selected = items.filter(item => item.view === view);
    return view === 'needs_you'
        ? getInboxNeedsYouItemTypes().flatMap(type => selected.filter(item => item.type === type))
        : selected.sort((left, right) => right.createdAt - left.createdAt);
}

function sameItem(left: InboxItem, right: InboxItem): boolean {
    return left.producer === right.producer && left.type === right.type && left.view === right.view && left.title === right.title
        && left.context === right.context && left.createdAt === right.createdAt && left.read === right.read
        && left.pageRoute === right.pageRoute && createInboxItemRoute(left.focus).params.item === createInboxItemRoute(right.focus).params.item
        && left.source.kind === right.source.kind && left.source.id === right.source.id && left.source.serverId === right.source.serverId
        && left.source.displayName === right.source.displayName && left.excerpt === right.excerpt
        && JSON.stringify(left.author) === JSON.stringify(right.author)
        && JSON.stringify(left.question) === JSON.stringify(right.question)
        && JSON.stringify(left.approvalQuickActions) === JSON.stringify(right.approvalQuickActions)
        && JSON.stringify(left.discussion) === JSON.stringify(right.discussion);
}
