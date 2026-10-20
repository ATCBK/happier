import type { Tx } from "@/storage/inTx";
import { reseedRestoredSessionFollowEdgesInTx } from "./sessionFollowEdgeService";
import { resolveAccountVoiceSelection } from './accountFollowService';

/** Resumes retained interest at current context without changing a human read cursor. */
export async function applySessionArchiveTransitionToFollowsInTx(input: Readonly<{
    tx: Tx;
    sessionId: string;
    wasArchived: boolean;
    isArchived: boolean;
}>): Promise<void> {
    if (input.wasArchived === input.isArchived || input.isArchived) return;
    const follows = await input.tx.accountSessionFollow.findMany({
        where: { sessionId: input.sessionId, following: true,
            OR: [{ includeInVoice: true }, { followPolicy: { not: null } }] },
        select: { accountId: true, includeInVoice: true, followPolicy: true },
    });
    const accountIds = follows.filter(row => resolveAccountVoiceSelection(row) !== null).map(row => row.accountId);
    if (accountIds.length) await input.tx.accountSessionFollow.updateMany({
        where: { sessionId: input.sessionId, following: true, accountId: { in: accountIds } },
        data: { voiceDeliveredFrontier: null },
    });
    await reseedRestoredSessionFollowEdgesInTx(input.tx, {
        sessionId: input.sessionId,
        archived: false,
    });
}
