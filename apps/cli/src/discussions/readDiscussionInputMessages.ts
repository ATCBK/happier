import { DiscussionReadResultV1Schema, type DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { readCommittedDiscussionMessage } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

type DiscussionInputRead = Readonly<{
  serverId: string;
  addressing: DiscussionAddressingV1;
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>;
  signal: AbortSignal;
}>;

/** Read the exact original; the intake owns selection, and Pending owns dispatch authority. */
export async function readDiscussionInputQuestion(input: DiscussionInputRead): Promise<DiscussionOpenedMessageV1 | null> {
  const { addressing, serverId, signal, discussionAction } = input;
  const opened = DiscussionReadResultV1Schema.safeParse(await discussionAction({ actionId: 'discussion.read',
    input: { discussionId: addressing.discussionId, messageId: addressing.messageId, throughSeq: addressing.throughSeq },
    context: { surface: 'cli', authority: 'account_automation', serverId }, signal }));
  if (!opened.success || opened.data.incomplete || opened.data.serverId !== serverId
    || opened.data.discussionId !== addressing.discussionId) return null;
  const question = opened.data.messages.find(message => message.id === addressing.messageId && message.seq === addressing.throughSeq);
  return question?.content ? question : null;
}

/** The exact question and reply ancestry admitted to Discussion input, in conversation order. */
export async function readDiscussionInputMessages(input: DiscussionInputRead & Readonly<{
  /** Reuse the exact original already opened by this intake's policy check. */
  question?: DiscussionOpenedMessageV1;
}>): Promise<readonly DiscussionOpenedMessageV1[] | null> {
  const { addressing, serverId, signal, discussionAction } = input;
  const question = input.question ?? await readDiscussionInputQuestion(input);
  if (!question) return null;
  const messages = [question];
  const seen = new Set([question.id]);
  let root = question;
  while (root.replyTarget?.kind === 'message') {
    const messageId = root.replyTarget.messageId;
    if (seen.has(messageId)) return null;
    seen.add(messageId);
    const result = await readCommittedDiscussionMessage({ kind: 'discussion', discussion: {
      serverId, discussionId: addressing.discussionId }, messageId },
    { surface: 'cli', authority: 'account_automation', serverId, signal }, discussionAction,
    { throughSeq: addressing.throughSeq });
    if (!result.ok || !result.message.content) return null;
    root = result.message;
    messages.push(root);
  }
  return messages.reverse();
}
