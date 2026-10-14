import { SESSION_DISCUSSION_CHANGE_HINT_V1 } from '@happier-dev/protocol/sessions/discussions';

import {
    refreshTrackedSessionAccountBadgePushes,
    scheduleAccountActivityBadgeRefresh,
} from "@/app/activity/refreshAccountActivityBadgePushes";
import { markAccountChangesForSessionAccounts } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { markCurrentSessionReadersChanged, type CurrentSessionReaderCursor } from "@/app/session/changeTracking/markCurrentSessionReadersChanged";
import { afterTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";

/**
 * Wakes every Account that currently reads the Session after a discussion write.
 *
 * The hint is content-free and coalescing-safe: `AccountChange` rows are keyed
 * per `(account, kind, entity)`, so a later Session mutation may replace it
 * entirely. Clients therefore treat any `session` change for a Session with a
 * mounted discussion surface as a reason to reread canonical state; the hint may
 * only let them skip work when it is present.
 */
export async function markSessionDiscussionReadersChangedInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): Promise<CurrentSessionReaderCursor[]> {
    return await markCurrentSessionReadersChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        hint: SESSION_DISCUSSION_CHANGE_HINT_V1,
    });
}

/**
 * A private read-cursor advance wakes only its own Account. No other reader
 * learns another Account's progress.
 */
export async function markSessionDiscussionPrivateReaderChangedInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    accountId: string;
}>): Promise<void> {
    await markAccountChangesForSessionAccounts({
        tx: params.tx,
        sessionId: params.sessionId,
        accountIds: [params.accountId],
        hint: SESSION_DISCUSSION_CHANGE_HINT_V1,
    });
}

/**
 * Recomputes the badges of the Accounts that personally track this Session after
 * a discussion write that can change their unread or mention pressure.
 *
 * Waking readers above and refreshing badges here are deliberately different
 * contracts (L09B-R6): the wake reaches every current reader so a mounted
 * surface rereads, while the badge follows Lane 09B's exact owner-or-active
 * Follow relation, so broad Team access never becomes push fanout. Without this
 * call the canonical count already includes discussion unread but nothing
 * recomputes it, so a closed app keeps a stale badge until an unrelated Session
 * mutation happens to refresh it.
 *
 * It runs after commit because the count is read outside this transaction.
 */
export function scheduleSessionDiscussionBadgeRefreshInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): void {
    const { sessionId } = params;
    afterTx(params.tx, () => {
        void refreshTrackedSessionAccountBadgePushes({ badgeAttentionChanged: true, sessionId })
            .catch((error) => {
                log({ module: "activity-badges", level: "warn" }, "failed to refresh discussion badges", error);
            });
    });
}

/**
 * Recomputes only the acting Account's badge after its own private discussion
 * cursor moves, mirroring what the transcript read owner already does for its
 * frontier. Read state is viewer-private, so no other Account is scheduled.
 */
export function scheduleSessionDiscussionReaderBadgeRefreshInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
}>): void {
    const { accountId } = params;
    afterTx(params.tx, () => {
        scheduleAccountActivityBadgeRefresh({ badgeAttentionChanged: true, accountIds: [accountId] });
    });
}
