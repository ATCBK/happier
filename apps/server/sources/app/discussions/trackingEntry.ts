import type { Tx } from "@/storage/inTx";
import { filterAccountsWithCurrentDiscussionReadAccessInTx } from "./access";
import { initializeDiscussionReadBaselinesInTx } from "./readState";

/**
 * Establishes a private read baseline when the grant owner admits a new reader.
 * Session Follow transitions never enter this path: the Discussion's own grant
 * and sequence are the authority. Existing cursors survive invitation retries.
 */
export async function initializeDiscussionCursorsOnGrantEntryInTx(tx: Tx, params: Readonly<{
    discussionId: string;
    accountIds: readonly string[];
}>): Promise<number> {
    const accountIds = [...new Set(params.accountIds)];
    if (accountIds.length === 0) return 0;
    const discussion = await tx.discussion.findUnique({
        where: { id: params.discussionId },
        select: { messageSeq: true },
    });
    if (!discussion) return 0;
    const readable = await filterAccountsWithCurrentDiscussionReadAccessInTx(tx, params);
    const eligible = accountIds.filter(accountId => readable.has(accountId));
    if (eligible.length === 0) return 0;
    return await initializeDiscussionReadBaselinesInTx(tx, {
        discussionId: params.discussionId,
        accountIds: eligible,
        lastReadSeq: discussion.messageSeq,
    });
}
