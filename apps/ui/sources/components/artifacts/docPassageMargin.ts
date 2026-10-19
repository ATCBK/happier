import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import { locateDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { readDiscussionContentPassage } from '@/components/discussions/discussionComposerDocument';

type ArtifactRevisionV1 = DocPassageRefV1['revision'];

/** The message fields the Doc margin reads; a committed opened Discussion message satisfies it. */
export type DocPassageMarginMessage = Pick<
  DiscussionOpenedMessageV1,
  | 'id'
  | 'discussionId'
  | 'seq'
  | 'authorAccountId'
  | 'createdAt'
  | 'content'
  | 'replyTarget'
  | 'docEditProposalDispositionV1'
> &
  Partial<
    Pick<
      DiscussionOpenedMessageV1,
      'accountActor' | 'producerV1' | 'messageRef'
    >
  >;

export type DocPassageMarginLocation =
  | Readonly<{
      state: 'exact' | 'relocated' | 'revised';
      range: Readonly<{ start: number; end: number }>;
    }>
  | Readonly<{ state: 'detached' }>;

export type DocPassageMarginThread<
  M extends DocPassageMarginMessage = DocPassageMarginMessage,
> = Readonly<{
  discussionId: string;
  passage: DocPassageRefV1;
  location: DocPassageMarginLocation;
  root: M;
  /** Everything after the passage root, oldest first. */
  replies: readonly M[];
  /** The latest suggested edit in the thread: its card, or its receipt once decided. */
  proposal: M | null;
}>;

export type DocPassageMarginAccepted = Readonly<{
  deciderAccountId: string;
  proposerAccountId: string | null;
  atMs: number;
  revision: ArtifactRevisionV1;
}>;

/** The words a thread is about as read now: the revised text once its edit is in this version. */
export function readDocPassageThreadQuote(thread: DocPassageMarginThread): string {
  const content = thread.proposal?.content;
  return thread.location.state === 'revised' && content && 'kind' in content && content.kind === 'doc_edit_proposal'
    ? content.proposal.after
    : thread.passage.quote;
}

const sameRevision = (left: ArtifactRevisionV1, right: ArtifactRevisionV1) =>
  left.headerVersion === right.headerVersion &&
  left.bodyVersion === right.bodyVersion;

/**
 * Place each passage thread of a Doc against the revision being read.
 *
 * A passage is found by `locateDocPassageV1` (its stored source range at its own revision, an
 * unambiguous unchanged quote at another; never the first duplicate). A suggestion accepted into
 * the revision being read marks its revised text, checked at the same source offset. Anything else
 * is detached: the thread keeps its old quote and says the passage changed.
 */
export function buildDocPassageMargin<M extends DocPassageMarginMessage>(
  input: Readonly<{
    source: string;
    revision: ArtifactRevisionV1;
    threads: readonly Readonly<{
      discussionId: string;
      messages: readonly M[];
    }>[];
  }>,
): Readonly<{
  threads: readonly DocPassageMarginThread<M>[];
  accepted: DocPassageMarginAccepted | null;
  unreadable: number;
}> {
  const threads: DocPassageMarginThread<M>[] = [];
  let accepted: DocPassageMarginAccepted | null = null;
  let unreadable = 0;
  for (const thread of input.threads) {
    const ordered = [...thread.messages].sort(
      (left, right) => left.seq - right.seq,
    );
    const root = ordered.find(
      (message) => message.replyTarget?.kind === 'doc_passage',
    );
    const passage = root ? readDiscussionContentPassage(root.content) : null;
    if (!root || !passage) {
      unreadable += 1;
      continue;
    }
    const replies = ordered.filter((message) => message !== root);
    const proposal =
      [...ordered]
        .reverse()
        .find(
          (message) =>
            message.content !== null &&
            'kind' in message.content &&
            message.content.kind === 'doc_edit_proposal',
        ) ?? null;
    const disposition = proposal?.docEditProposalDispositionV1;
    let location: DocPassageMarginLocation = locateDocPassageV1({
      target: passage,
      source: input.source,
      revision: input.revision,
    });
    if (
      disposition?.state === 'accepted' &&
      sameRevision(disposition.acceptedRevision, input.revision) &&
      proposal?.content &&
      'kind' in proposal.content &&
      proposal.content.kind === 'doc_edit_proposal'
    ) {
      const { target, after } = proposal.content.proposal;
      const start = target.range.start;
      if (
        after.length > 0 &&
        input.source.slice(start, start + after.length) === after
      ) {
        location = {
          state: 'revised',
          range: { start, end: start + after.length },
        };
      }
      if (!accepted || disposition.decidedBy.atMs > accepted.atMs) {
        accepted = {
          deciderAccountId: disposition.decidedBy.accountId,
          proposerAccountId: proposal.authorAccountId,
          atMs: disposition.decidedBy.atMs,
          revision: disposition.acceptedRevision,
        };
      }
    }
    threads.push({
      discussionId: thread.discussionId,
      passage,
      location,
      root,
      replies,
      proposal,
    });
  }
  const position = (thread: DocPassageMarginThread<M>) =>
    thread.location.state === 'detached'
      ? Number.POSITIVE_INFINITY
      : thread.location.range.start;
  threads.sort((left, right) => position(left) - position(right));
  return { threads, accepted, unreadable };
}
