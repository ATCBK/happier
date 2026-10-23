import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { scheduleSessionRelationBroadcastAfterTx } from '@/app/session/relations/sessionRelationChanges';

/** Publication acquisition and invalidation consume the same retained review origins. */
export async function readAutomationSessionReviewProjectionIdsInTx(tx: Tx, automationIds: readonly string[]): Promise<string[]> {
    if (automationIds.length === 0) return [];
    const sessionIds = new Set<string>();
    // Trigger kind, three Events and the portable Prisma offset share the ID budget.
    for (const ids of portableQueryChunks({ values: [...new Set(automationIds)], bindingsPerValue: 1, fixedBindings: 5 })) {
        const origins = await tx.automationRun.findMany({
            where: { automationId: { in: [...ids] }, causeSourceSessionId: { not: null }, causeTriggerKind: 'sessionLifecycle',
                causeSessionLifecycleEvent: { in: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'] } },
            distinct: ['causeSourceSessionId'], select: { causeSourceSessionId: true },
        });
        for (const origin of origins) if (origin.causeSourceSessionId) sessionIds.add(origin.causeSourceSessionId);
    }
    return [...sessionIds].sort();
}

/** Run lifecycle changes release the review barrier through incumbent Session hints. */
export async function invalidateSessionReviewProjectionsForAutomationInTx(tx: Tx, automationId: string): Promise<void> {
    for (const causeSourceSessionId of await readAutomationSessionReviewProjectionIdsInTx(tx, [automationId])) {
        const recipients = await markSessionProjectionRecipientsChanged({ tx, sessionId: causeSourceSessionId });
        scheduleSessionRelationBroadcastAfterTx(tx, causeSourceSessionId, recipients.map(({ accountId }) => accountId));
    }
}
