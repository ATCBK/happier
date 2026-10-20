import type { SessionPersonalEventEphemeralV1 } from "@happier-dev/protocol/updates";

import { eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { db } from '@/storage/db';
import { log } from '@/utils/logging/log';
import { isSessionFollowStalledOccurrenceCurrentV1, type SessionFollowStalledOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';

/** Recheck the original presence owner, not a later message or an alert receipt. */
export async function isSessionPersonalStalledOccurrenceCurrent(params: Readonly<{
    sessionId: string; stalledOccurrence?: SessionFollowStalledOccurrenceV1;
}>): Promise<boolean> {
    if (!params.stalledOccurrence) return true;
    const source = await db.session.findUnique({ where: { id: params.sessionId }, select: {
        active: true, latestTurnId: true, latestTurnStatus: true, archivedAt: true, lastActiveAt: true,
    } });
    return source !== null && isSessionFollowStalledOccurrenceCurrentV1(params.stalledOccurrence,
        { ...source, activeAt: source.lastActiveAt.getTime() });
}

/**
 * Publish a semantic mutation's live recipient fact only after commit. The
 * mutation owns the target; the existing router rechecks that socket's current
 * Session authority. This carries no history or remote-notification enrollment.
 */
export function scheduleSessionPersonalEvent(
    tx: Tx,
    recipientAccountId: string,
    event: SessionPersonalEventEphemeralV1,
): void {
    afterTx(tx, () => {
        const dispatch = async () => {
            if (event.event === 'source_unavailable' && event.stalledOccurrence
                && !await isSessionPersonalStalledOccurrenceCurrent({ sessionId: event.sessionId,
                    stalledOccurrence: event.stalledOccurrence })) return;
            await eventRouter.emitEphemeral({
                userId: recipientAccountId,
                payload: event,
                recipientFilter: { type: "all-interested-in-session", sessionId: event.sessionId },
            });
        };
        void dispatch().catch(error => {
            log({ module: 'session-personal-events', level: 'warn' }, 'failed to publish committed personal event', error);
        });
    });
}
