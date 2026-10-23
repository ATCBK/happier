import {
  DiscussionSelectionSourceV1Schema,
  isDiscussionDocEditProposalContentV1,
  readDiscussionMessagePartsV1,
} from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import {
  formatAccountDisplayName,
  resolveViewerAccountDisplayName,
} from '@/sync/domains/account/formatAccountDisplayName';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import type { InlineMessageReference } from '@/components/sessions/transcript/references/messageStructuredReferences';

type DiscussionMessageReference = InlineMessageReference &
  Readonly<{
    participant: Extract<
      ReturnType<typeof readDiscussionMessagePartsV1>[number],
      { t: 'mention' }
    >['participant'];
  }>;

/** Typed Discussion parts feed the same Markdown inline seam as Session references. */
export function projectDiscussionMessageReferences(
  content: NonNullable<DiscussionOpenedMessageV1['content']>,
  labels: Readonly<{
    account?: (id: string) => string | null;
    session?: (id: string) => string | null;
  }> = {},
  mode?: Parameters<typeof readDiscussionMessagePartsV1>[1],
): Readonly<{
  text: string;
  readableText: string;
  inline: ReadonlyMap<string, DiscussionMessageReference>;
  parts: readonly (string | DiscussionMessageReference)[];
}> {
  const inline = new Map<string, DiscussionMessageReference>();
  const parts = readDiscussionMessagePartsV1(content, mode).map(
    (part): string | DiscussionMessageReference => {
      if (part.t === 'text') return readableMessageText(part.text);
      const account = part.participant.kind === 'account';
      const id =
        part.participant.kind === 'account'
          ? part.participant.accountId
          : part.participant.sessionId;
      const label =
        (account ? labels.account?.(id) : labels.session?.(id)) ??
        t(
          account
            ? 'session.collaboration.discussion.collaborator'
            : 'session.collaboration.discussion.heldParticipant',
        );
      const reference: DiscussionMessageReference = {
        ref: buildMentionRefV1(account ? 'account' : 'session', id),
        kind: account ? 'happier.account' : 'happier.session',
        label,
        marker: `@${label}`,
        glyph: account ? 'assigned' : 'conversations',
        participant: part.participant,
        ...(!account ? { sessionId: id } : {}),
      };
      inline.set(reference.ref, reference);
      return reference;
    },
  );
  return {
    parts,
    inline,
    text: parts
      .map((part) =>
        typeof part === 'string' ? part : formatInlineReferenceTokenV1(part),
      )
      .join(''),
    readableText: parts
      .map((part) => (typeof part === 'string' ? part : part.marker))
      .join(''),
  };
}

/** Readable message content as one preview line; unknown mentions never expose raw ids. */
export function readDiscussionMessagePreview(
  content: DiscussionOpenedMessageV1['content'],
  labels: Readonly<{
    account?: (accountId: string) => string | null;
    session?: (sessionId: string) => string | null;
  }> = {},
): string | null {
  if (!content) return null;
  const text = projectDiscussionMessageReferences(content, labels, 'preview')
    .readableText.replace(/\s+/g, ' ')
    .trim();
  if (isDiscussionDocEditProposalContentV1(content)) {
    const title = t('artifacts.browser.proposal.title');
    return text ? `${title} · ${text}` : title;
  }
  return text || null;
}

/** Display-only: an unacknowledged own row borrows only the exact viewer's profile. */
export function resolveDiscussionMessageAuthorLabel(
  message: Pick<
    DiscussionOpenedMessageV1,
    'authorAccountId' | 'accountActor' | 'createdAt'
  >,
  viewer?: Readonly<{
    accountId: string;
    profile: Readonly<{
      name?: string | null;
      username?: string | null;
    }> | null;
  }>,
): string {
  const actor = message.accountActor;
  if (actor === null || actor.accountId !== message.authorAccountId) {
    if (
      actor === null &&
      message.createdAt === 0 &&
      viewer &&
      message.authorAccountId === viewer.accountId
    ) {
      return resolveViewerAccountDisplayName(
        viewer.profile ? formatAccountDisplayName(viewer.profile) : null,
      );
    }
    return t('session.collaboration.discussion.collaborator');
  }
  if (actor.profile === null) return t('message.accountActorFormerMember');
  return (
    formatAccountDisplayName(actor.profile) ??
    t('message.accountActorUnnamedMember')
  );
}

/**
 * A Bot reply's quiet byline (C7): who asked, from the cause the append owner stamped. The row's
 * speaker already names the Bot that answered, so the byline does not repeat it. The requester's
 * name comes only from the sanitized projection for that exact Account; an unprojected or mismatched requester stays "another person", never the Bot's owner or poster. No
 * person cause (autonomous or older replies) says nothing. "Using <account>" is not offered: the reply
 * custody carries no exact outward-operation actor.
 */
export function resolveDiscussionReplyAttributionLine(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'> &
    Partial<Pick<DiscussionOpenedMessageV1, 'requesterAccountActor'>>,
  viewer: Readonly<{ serverId: string; accountId: string }>,
): string | null {
  const producer = message.producerV1;
  const requester =
    producer?.kind === 'agent'
      ? producer.actionRequestAttributionV1?.requester
      : undefined;
  if (!requester) return null;
  const actor = message.requesterAccountActor;
  const name =
    requester.accountId === viewer.accountId &&
    areServerProfileIdentifiersEquivalent(requester.serverId, viewer.serverId)
      ? t('session.collaboration.discussion.attribution.you')
      : actor && actor.accountId === requester.accountId
        ? resolveAccountActorPresentation(
            { ...actor, serverId: requester.serverId },
            viewer,
          ).name
        : t('session.collaboration.discussion.attribution.anotherPerson');
  return t('session.collaboration.discussion.attribution.askedBy', {
    requester: name,
  });
}

/**
 * How an addressed participant answered (C3 U2), read only from the return the append owner stamped on its
 * reply. `failed` includes a turn that ended with no result: either way the person who asked got no answer.
 * A message an agent posted on its own, or a person's message, has no outcome.
 */
export type DiscussionReplyOutcome = 'answer' | 'pass' | 'failed' | 'cancelled';
type StampedReplyOutcome = Extract<
  NonNullable<DiscussionOpenedMessageV1['producerV1']>,
  { kind: 'workflow' }
>['outcome'];
function projectReplyOutcome(
  outcome: StampedReplyOutcome | undefined,
): DiscussionReplyOutcome | null {
  switch (outcome) {
    case 'answer':
      return 'answer';
    case 'pass':
      return 'pass';
    case 'failed':
    case 'terminal_no_result':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
export function resolveDiscussionReplyOutcome(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): DiscussionReplyOutcome | null {
  const producer = message.producerV1;
  return producer?.kind === 'agent'
    ? projectReplyOutcome(producer.replyReturn?.outcome)
    : null;
}

/**
 * A message published for a Workflow (C4): an Agent's protected reply return carries the exact
 * Workflow Run; its generic runId can identify an ordinary execution run. Producer kind still owns
 * speaker identity; the stamped outcome distinguishes a published answer from a pass, failure or stop.
 */
export function resolveDiscussionWorkflowAttribution(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): Readonly<{ runId: string; outcome: DiscussionReplyOutcome | null }> | null {
  const producer = message.producerV1;
  if (!producer) return null;
  const runId = producer.kind === 'workflow' ? producer.runId : producer.replyReturn?.workflow?.runId;
  if (!runId) return null;
  return {
    runId,
    outcome: projectReplyOutcome(
      producer.kind === 'workflow' ? producer.outcome : producer.replyReturn?.outcome,
    ),
  };
}

/**
 * How a message reads in the thread (C3 DISC-19). A reply that stopped but kept a partial answer is
 * still an answer worth reading, so it renders as a message marked stopped. Passed, failed and
 * bodiless stopped replies say nothing anyone has to read past: a compact notice under their byline.
 */
export type DiscussionReplyPresentation =
  | Readonly<{ kind: 'message'; stopped: boolean }>
  | Readonly<{
      kind: 'notice';
      outcome: Exclude<DiscussionReplyOutcome, 'answer'>;
    }>;
function readStampedOutcome(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): DiscussionReplyOutcome | null {
  return (
    resolveDiscussionReplyOutcome(message) ??
    resolveDiscussionWorkflowAttribution(message)?.outcome ??
    null
  );
}
export function resolveDiscussionReplyPresentation(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1' | 'content'>,
): DiscussionReplyPresentation {
  const outcome = readStampedOutcome(message);
  if (outcome === null || outcome === 'answer')
    return { kind: 'message', stopped: false };
  const hasBody =
    message.content !== null &&
    projectDiscussionMessageReferences(message.content).readableText.trim() !==
      '';
  return outcome === 'cancelled' && hasBody
    ? { kind: 'message', stopped: true }
    : { kind: 'notice', outcome };
}

function discussionMessageProducerClass(
  message: Pick<DiscussionOpenedMessageV1, 'producerV1'>,
): string {
  // Each producer speaks for itself: two Sessions or two Runs in a row never share one byline.
  const producer = message.producerV1;
  if (producer === null) return 'human';
  return producer.kind === 'agent'
    ? `agent:${producer.sessionId}`
    : `workflow:${producer.runId}`;
}

/**
 * Whether a message opens its own speaker group (byline and face). A reply with a stamped outcome
 * always does: it answers one question, and must never read as part of the message before it.
 */
export function startsDiscussionMessageGroup(
  message: Pick<DiscussionOpenedMessageV1, 'authorAccountId' | 'producerV1'>,
  previous:
    | Pick<DiscussionOpenedMessageV1, 'authorAccountId' | 'producerV1'>
    | undefined,
): boolean {
  return (
    !previous ||
    readStampedOutcome(message) !== null ||
    message.authorAccountId === null ||
    previous.authorAccountId === null ||
    previous.authorAccountId !== message.authorAccountId ||
    discussionMessageProducerClass(previous) !==
      discussionMessageProducerClass(message)
  );
}

/**
 * The typed value of a Workflow result, readable beside its summary. A value that only repeats the
 * summary adds nothing and is not shown again; structured values read as indented JSON.
 */
export function readDiscussionWorkflowResultDetail(
  content: DiscussionOpenedMessageV1['content'],
): string | null {
  if (!content || !('kind' in content) || content.kind !== 'workflow_result')
    return null;
  const { value, summary } = content;
  if (typeof value === 'string')
    return value.trim() === '' || value.trim() === summary.trim()
      ? null
      : value;
  return value !== null && typeof value === 'object'
    ? JSON.stringify(value, null, 2)
    : String(value);
}

/**
 * Where a shared Bot's requester-bound request reads in the thread (C7 "External write needs
 * confirmation"): under the Bot reply stamped with the same admitted cause, else under the message
 * that asked. A one-line outcome (passed, failed, stopped) is not a place for a card, so the ask keeps
 * it. A request whose anchor is not loaded here is not placed rather than guessed.
 */
export function placeDiscussionRequesterApprovals<
  T extends Readonly<{ requestRef: string; originMessageId: string }>,
>(
  messages: ReadonlyArray<Pick<DiscussionOpenedMessageV1, 'id' | 'producerV1'>>,
  approvals: ReadonlyArray<T>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const placed = new Map<string, T[]>();
  if (approvals.length === 0) return placed;
  const messageIds = new Set(messages.map((message) => message.id));
  const replyByRequestRef = new Map<string, string>();
  for (const message of messages) {
    const requestRef =
      message.producerV1?.kind === 'agent'
        ? message.producerV1.actionRequestAttributionV1?.requestRef
        : undefined;
    const outcome = resolveDiscussionReplyOutcome(message);
    if (requestRef && (outcome === null || outcome === 'answer'))
      replyByRequestRef.set(requestRef, message.id);
  }
  for (const approval of approvals) {
    const anchor =
      replyByRequestRef.get(approval.requestRef) ??
      (messageIds.has(approval.originMessageId)
        ? approval.originMessageId
        : null);
    if (!anchor) continue;
    placed.set(anchor, [...(placed.get(anchor) ?? []), approval]);
  }
  return placed;
}

export type DiscussionTimelineMessage = Pick<
  DiscussionOpenedMessageV1,
  'id' | 'seq'
>;

export type DiscussionTimelineItem<
  TMessage extends DiscussionTimelineMessage = DiscussionOpenedMessageV1,
> =
  | Readonly<{
      kind: 'human_message';
      message: TMessage;
    }>
  | Readonly<{
      kind: 'agent_activity_reference';
      anchorSeq: number;
      entry: AgentActivityEntry;
      subagent: SessionSubagent;
    }>
  | Readonly<{
      /** A managed Pattern run, shown right under the message that started it. */
      kind: 'workflow_run';
      run: WorkflowRunSummaryV1;
    }>;

type AgentActivityReference = Extract<
  DiscussionTimelineItem,
  { kind: 'agent_activity_reference' }
>;

function compareReferences(
  left: AgentActivityReference,
  right: AgentActivityReference,
): number {
  const leftStartedAt = left.entry.startedAtMs;
  const rightStartedAt = right.entry.startedAtMs;
  if (leftStartedAt !== rightStartedAt) {
    if (leftStartedAt === null) return 1;
    if (rightStartedAt === null) return -1;
    return leftStartedAt - rightStartedAt;
  }
  return (left.entry.runId ?? '').localeCompare(right.entry.runId ?? '');
}

/**
 * Joins already loaded Discussion rows to the canonical Session Agent roster.
 *
 * Launch provenance is display-only: every referenced message must already be present in this
 * exact Discussion page, and the exact Run must resolve through the canonical activity owner.
 * Missing data omits the card; this function never fetches or authorizes anything.
 */
export function buildDiscussionTimelineItems<
  TMessage extends DiscussionTimelineMessage,
>(
  params: Readonly<{
    serverId: string;
    discussionId: string;
    messages: readonly TMessage[];
    subagents: readonly SessionSubagent[];
    readExecutionRunEntry: (runId: string) => AgentActivityEntry | null;
    /** The authorized managed Run list for this Discussion; a Run whose starting message isn't loaded waits for it. */
    workflowRuns?: readonly WorkflowRunSummaryV1[];
  }>,
): readonly DiscussionTimelineItem<TMessage>[] {
  const messageById = new Map(
    params.messages.map((message) => [message.id, message]),
  );
  const referencesByAnchorSeq = new Map<number, AgentActivityReference[]>();

  for (const subagent of params.subagents) {
    if (subagent.kind !== 'execution_run') continue;
    const runId = subagent.runRef?.runId;
    if (!runId) continue;

    const sourceResult = DiscussionSelectionSourceV1Schema.safeParse(
      subagent.runRef?.launchOrigin,
    );
    if (!sourceResult.success) continue;
    const source = sourceResult.data;
    if (
      !areServerProfileIdentifiersEquivalent(
        source.serverId,
        params.serverId,
      ) ||
      source.discussionId !== params.discussionId
    )
      continue;

    let anchorSeq = -1;
    let sourceResolved = true;
    for (const messageId of source.messageIds) {
      const message = messageById.get(messageId);
      if (!message) {
        sourceResolved = false;
        break;
      }
      anchorSeq = Math.max(anchorSeq, message.seq);
    }
    if (!sourceResolved || anchorSeq < 0) continue;

    const entry = params.readExecutionRunEntry(runId);
    if (!entry || entry.kind !== 'execution_run' || entry.runId !== runId)
      continue;
    const reference: AgentActivityReference = {
      kind: 'agent_activity_reference',
      anchorSeq,
      entry,
      subagent,
    };
    const atAnchor = referencesByAnchorSeq.get(anchorSeq);
    if (atAnchor) atAnchor.push(reference);
    else referencesByAnchorSeq.set(anchorSeq, [reference]);
  }

  for (const references of referencesByAnchorSeq.values())
    references.sort(compareReferences);

  const workflowRunsByMessageId = new Map<string, WorkflowRunSummaryV1[]>();
  for (const run of params.workflowRuns ?? []) {
    const origin =
      run.origin.kind === 'direct' ? run.origin.discussion : undefined;
    if (
      !origin ||
      origin.discussion.discussionId !== params.discussionId ||
      !areServerProfileIdentifiersEquivalent(
        origin.discussion.serverId,
        params.serverId,
      )
    )
      continue;
    const atMessage = workflowRunsByMessageId.get(origin.messageId);
    if (atMessage) atMessage.push(run);
    else workflowRunsByMessageId.set(origin.messageId, [run]);
  }

  const items: DiscussionTimelineItem<TMessage>[] = [];
  for (const message of params.messages) {
    items.push({ kind: 'human_message', message });
    for (const run of workflowRunsByMessageId.get(message.id) ?? [])
      items.push({ kind: 'workflow_run', run });
    items.push(...(referencesByAnchorSeq.get(message.seq) ?? []));
  }
  return items;
}

/**
 * The canonical rows a reader has actually been shown as readable content.
 *
 * A visible row whose content the Discussion cipher could not open is an
 * unavailable placeholder, not something read. The private cursor is one
 * monotone sequence, so a later readable row must not carry it past an earlier
 * unread unreadable one: only rows before the first retained unreadable row
 * above the confirmed cursor qualify. An unreadable row the cursor already
 * covers was read before and blocks nothing. Optimistic or unknown rows are
 * never in `messages` and never qualify.
 */
export function resolveReadableVisibleDiscussionSeqs(
  input: Readonly<{
    messages: readonly Pick<
      DiscussionOpenedMessageV1,
      'id' | 'seq' | 'content'
    >[];
    visibleMessageIds: ReadonlySet<string>;
    /** The confirmed private read cursor, or null when this viewer has none. */
    lastReadSeq: number | null;
  }>,
): readonly number[] {
  const seqs: number[] = [];
  for (const message of input.messages) {
    if (message.content === null) {
      if (input.lastReadSeq !== null && message.seq <= input.lastReadSeq)
        continue;
      break;
    }
    if (input.visibleMessageIds.has(message.id)) seqs.push(message.seq);
  }
  return seqs;
}
