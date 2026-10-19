import { acquireAccountChangePublicationLocksInTx, markAccountsChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";

export async function readHomeGovernanceChangeAccountIdsInTx(
    tx: Tx,
    options?: Readonly<{
        excludeAccountIds?: readonly string[];
        audience?: "administrators" | "all_active_accounts";
        accountIds?: readonly string[];
    }>,
): Promise<readonly string[]> {
    const excluded = new Set(options?.excludeAccountIds ?? []);
    const viewers = await tx.account.findMany({
        where: {
            status: "active",
            ...(options?.audience === "all_active_accounts"
                ? {}
                : { homeRole: { in: ["owner", "admin"] } }),
            ...(options?.accountIds ? { id: { in: [...options.accountIds] } } : {}),
        },
        select: { id: true },
    });
    return viewers.map(viewer => viewer.id).filter(accountId => !excluded.has(accountId));
}

/**
 * The stable coalescing identity for Home-governance invalidation. New clients
 * branch on this entity ID and refresh the exact Home's governance snapshot;
 * older clients keep their existing broad `account` refresh and still advance
 * their cursor safely, so no new `ChangeKind`, hint schema, or socket room is
 * introduced.
 */
/**
 * Wakes every Account that can currently see Home Administration after a
 * governance mutation.
 *
 * The audience is exactly the viewers whose projection the mutation can
 * invalidate: administration requires an active `owner`/`admin`, so a member,
 * a suspended admin, or a retired owner is deliberately not woken. A demoted or
 * suspended Account still refreshes through the `self` change its lifecycle
 * transition already published.
 *
 * `excludeAccountIds` exists because `markAccountChanged` allocates a cursor by
 * incrementing `Account.seq` once per call. An Account the same transaction has
 * already marked — typically the mutation's target — must not be incremented a
 * second time here, so callers pass the IDs they already published.
 *
 * The audience is the Home's administrator set, which is small by construction;
 * this is a bounded fanout over that set, not a broadcast to every Account.
 */
export async function publishHomeGovernanceChangedInTx(
    tx: Tx,
    options?: Readonly<{
        excludeAccountIds?: readonly string[];
        audience?: "administrators" | "all_active_accounts";
    }>,
): Promise<number> {
    const capturedAccountIds = await readHomeGovernanceChangeAccountIdsInTx(tx, options);
    if (capturedAccountIds.length === 0) return 0;
    // ReadCommitted callers may capture a viewer just before that Account is
    // retired, demoted or erased. Fence the captured audience and recheck its
    // current eligibility before the strict cursor allocator sees these IDs.
    await acquireAccountChangePublicationLocksInTx(tx, capturedAccountIds, { includeSingleAccount: true });
    const viewers = await readHomeGovernanceChangeAccountIdsInTx(tx, { ...options, accountIds: capturedAccountIds });

    return (await markAccountsChanged(tx, {
        accountIds: viewers,
        entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
    })).length;
}
