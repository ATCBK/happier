import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, buildSessionFollowChangeHintV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { scheduleAccountActivityBadgeRefresh } from "@/app/activity/refreshAccountActivityBadgePushes";
import { afterTx, type Tx } from "@/storage/inTx";

/**
 * Set-form Follow invalidation for the exact affected Account set.
 *
 * Reuses the existing set-oriented AccountChange owner for cursors/wakes
 * (fixed statements regardless of set size) then replaces the hint-free rows
 * with the canonical Follow hint in one update. One badge schedule for the
 * whole set coalesces with per-Account schedules through the existing
 * coalescing owner, so closed devices converge without per-Account fanout.
 * The current consumer reloads the complete exact-Home Follow snapshot, so the
 * hint deliberately carries no per-Session or preference targeting vocabulary.
 */
export async function markSessionFollowsChangedForAccountsInTx(tx: Tx, accountIds: readonly string[]): Promise<void> {
    const unique = [...new Set(accountIds)].filter(accountId => typeof accountId === 'string' && accountId.length > 0);
    if (unique.length === 0) return;
    await markAccountsChanged(tx, {
        accountIds: unique,
        entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID,
        kind: 'account',
    });
    await tx.accountChange.updateMany({
        where: { accountId: { in: unique }, kind: 'account', entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID },
        data: { hint: buildSessionFollowChangeHintV1() },
    });
    // Connected clients reread the snapshot above. Closed devices consume the
    // existing badge transport, after the relation/read-baseline commit.
    afterTx(tx, () => scheduleAccountActivityBadgeRefresh({ badgeAttentionChanged: true, accountIds: unique }));
}

/**
 * Coalesced private invalidation for the authenticated Account's own Follow
 * configuration.
 *
 * Delegates to the set form so there is one decision/implementation; the
 * current consumer reloads the complete exact-Home Follow snapshot, so the
 * hint deliberately carries no per-Session or preference targeting vocabulary.
 */
export async function markSessionFollowsChangedInTx(tx: Tx, input: Readonly<{
    accountId: string;
}>): Promise<void> {
    await markSessionFollowsChangedForAccountsInTx(tx, [input.accountId]);
}
