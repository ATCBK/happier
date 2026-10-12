import { afterTx, type Tx } from '@/storage/inTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import { acquireAccountChangePublicationLocksInTx, markAccountsChanged } from '@/app/changes/markAccountChanged';
import { eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';

/** Content-free relation changes use the same AccountChange and committed socket hint. */
export function scheduleSessionRelationBroadcastAfterTx(tx: Tx, sessionId: string, accountIds: readonly string[]): void {
    const recipients = [...new Set(accountIds)].sort();
    if (recipients.length === 0) return;
    const payload = { id: randomKeyNaked(12), createdAt: Date.now(), body: { t: 'session-changed' as const, sessionId } };
    afterTx(tx, () => {
        for (const userId of recipients) void eventRouter.emitSessionBroadcast({ userId, sessionId, payload });
    });
}

export async function invalidateSessionRelationProjectionsInTx(
    tx: Tx,
    sessionIds: Iterable<string>,
    resolvedRecipients?: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds)].sort();
    const recipientsBySession = resolvedRecipients
        ?? await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: uniqueSessionIds });
    await acquireAccountChangePublicationLocksInTx(tx, [...recipientsBySession.values()].flat());
    for (const [sessionId, accountIds] of recipientsBySession) {
        await markAccountsChanged(tx, { accountIds, kind: 'session', entityId: sessionId });
        scheduleSessionRelationBroadcastAfterTx(tx, sessionId, accountIds);
    }
}
