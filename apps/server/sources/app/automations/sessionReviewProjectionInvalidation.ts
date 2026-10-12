import type { Tx } from '@/storage/inTx';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { scheduleSessionRelationBroadcastAfterTx } from '@/app/session/relations/sessionRelationChanges';

/** Publication acquisition and invalidation consume the same retained review origins. */
export async function readAutomationSessionReviewProjectionIdsInTx(tx: Tx, automationIds: readonly string[]): Promise<string[]> {
    if (automationIds.length === 0) return [];
    const origins = await tx.automationRun.findMany({
        where: { automationId: { in: [...automationIds] }, causeSourceSessionId: { not: null }, causeTriggerKind: 'sessionLifecycle',
            causeSessionLifecycleEvent: { in: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'] } },
        distinct: ['causeSourceSessionId'], select: { causeSourceSessionId: true },
    });
    return origins.flatMap(row => row.causeSourceSessionId ? [row.causeSourceSessionId] : []).sort();
}

/** Run lifecycle changes release the review barrier through incumbent Session hints. */
export async function invalidateSessionReviewProjectionsForAutomationInTx(tx: Tx, automationId: string): Promise<void> {
    for (const causeSourceSessionId of await readAutomationSessionReviewProjectionIdsInTx(tx, [automationId])) {
        const recipients = await markSessionProjectionRecipientsChanged({ tx, sessionId: causeSourceSessionId });
        scheduleSessionRelationBroadcastAfterTx(tx, causeSourceSessionId, recipients.map(({ accountId }) => accountId));
    }
}
