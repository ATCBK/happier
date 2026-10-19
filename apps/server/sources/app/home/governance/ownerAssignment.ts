import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountSessionOwnerMetadataFencesInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { inTx, type Tx } from "@/storage/inTx";

import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { publishHomeGovernanceChangedInTx, readHomeGovernanceChangeAccountIdsInTx } from "./governanceChanges";
import { countActiveHomeOwnersInTx, readHomeGovernanceAccountInTx } from "./homeCapabilities";
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';

export { PERSONAL_HOME_RUNTIME_PURPOSE } from '@/app/runtime/personalHomeRuntimePurpose';

export type HomeOwnerClaimResult =
    | Readonly<{ status: "claimed"; ownerAccountId: string }>
    | Readonly<{ status: "already_owned"; activeOwnerCount: number }>
    | Readonly<{ status: "target_inactive" }>
    | Readonly<{ status: "target_not_found" }>;

/**
 * The one transition out of the zero-active-owner bootstrap state.
 *
 * Personal Home bootstrap, the deployment-local operator command (also run on
 * the hosting desktop by the `relay.runtime.personal_home.claim_owner.v1`
 * task) and the one-time claim code are the current production callers, and
 * each names an explicit, already existing, active Account. No supported managed-host Home/Account provisioner exists in
 * current repository source; an external producer must supply its immutable
 * trusted Account-creation contract before that path can call this transition.
 * The only HTTP entry is `home.governance.claim`, bound to a code minted by a
 * deployment-local command; there is no standing setup bearer and no "first
 * signup becomes owner" behavior anywhere in this path, and the
 * claim grants Home governance only — never Team membership, Session access,
 * or key material.
 */
export async function claimHomeOwnerInTx(
    tx: Tx,
    input: Readonly<{
        targetAccountId: string;
        /**
         * Who assigned the owner, for the audit trail. `claim_code` is the claiming Account itself,
         * holding a one-time code the deployment printed (`homeClaimCode.ts`).
         */
        via: "deployment_command" | "personal_home_bootstrap" | "claim_code";
    }>,
): Promise<HomeOwnerClaimResult> {
    await acquireAccountSessionOwnerMetadataFencesInTx(tx,
        [input.targetAccountId, ...await readHomeGovernanceChangeAccountIdsInTx(tx)], "exclusive");
    const target = await readHomeGovernanceAccountInTx(tx, input.targetAccountId);
    if (!target) return { status: "target_not_found" };
    if (!isActiveHomeAccountStatus(target.status)) return { status: "target_inactive" };

    const activeOwnerCount = await countActiveHomeOwnersInTx(tx);
    if (activeOwnerCount > 0) return { status: "already_owned", activeOwnerCount };

    await tx.account.update({
        where: { id: target.accountId },
        data: { homeRole: "owner" },
    });
    await recordHomeAdministrationEventInTx(tx, {
        actor: input.via === "claim_code" ? { kind: "account", accountId: target.accountId } : { kind: input.via },
        target: { kind: "account", id: target.accountId },
        detail: { action: "home.owner.claim", summary: input.via === "claim_code" ? { via: "claim_code" } : {} },
    });
    // A claim is an ordinary Home role update as far as every client is
    // concerned, so it publishes the same refresh through the same owners: the
    // new owner's own `self` change, then the Home administration audience.
    // Excluding the target keeps `Account.seq` advancing exactly once for it,
    // because the fanout would otherwise see the owner this transaction just
    // created and mark it a second time.
    await markAccountChanged(tx, { accountId: target.accountId, kind: "account", entityId: "self" });
    await publishHomeGovernanceChangedInTx(tx, { excludeAccountIds: [target.accountId] });
    return { status: "claimed", ownerAccountId: target.accountId };
}

/**
 * The deployment-local entry. Ordinary initial claim and lost-owner recovery
 * are the same mutation: both require zero active owners and an explicit active
 * target. The deployment-local wrapper is not a managed-host provisioning API;
 * that externally blocked path must eventually consume `claimHomeOwnerInTx`
 * inside its own trusted transaction.
 */
export async function claimHomeOwner(
    input: Readonly<{ targetAccountId: string }>,
): Promise<HomeOwnerClaimResult> {
    return await inTx(
        async (tx) => await claimHomeOwnerInTx(tx, { ...input, via: "deployment_command" }),
        { isolationLevel: "Serializable" },
    );
}

export type PersonalHomeOwnerReconciliationResult =
    | HomeOwnerClaimResult
    | Readonly<{ status: "not_personal_home" }>
    | Readonly<{ status: "setup_required"; accountCount: number }>;

/**
 * Assigns the initial owner of a managed Personal Home.
 *
 * Qualification is positive and narrow: the runtime purpose must be exactly
 * `personal-home`, the Home must hold exactly one active Account, and no active
 * owner may exist. Retired and suspended legacy rows cannot own the Home and do
 * not strand that sole eligible Account. Once invitations add a second active
 * Account this does nothing and an ownerless Home reports `setup_required` for
 * explicit operator recovery — an arbitrary Account is never promoted, and
 * this never runs as migration SQL.
 */
export async function reconcilePersonalHomeInitialOwnerInTx(
    tx: Tx,
    input: Readonly<{ runtimePurpose: string | null; accountId: string }>,
): Promise<PersonalHomeOwnerReconciliationResult> {
    if (!isPersonalHomeRuntimePurpose(input.runtimePurpose)) return { status: "not_personal_home" };

    const activeOwnerCount = await countActiveHomeOwnersInTx(tx);
    if (activeOwnerCount > 0) return { status: "already_owned", activeOwnerCount };

    const accountCount = await tx.account.count({ where: { status: "active" } });
    if (accountCount !== 1) return { status: "setup_required", accountCount };

    return await claimHomeOwnerInTx(tx, { targetAccountId: input.accountId, via: "personal_home_bootstrap" });
}

export type PersonalHomeBootstrapOwnerResolution =
    | Readonly<{ status: "ready"; ownerAccountId: string }>
    | Readonly<{ status: "not_personal_home" }>
    | Readonly<{ status: "setup_required" }>;

/**
 * Resolves the only unambiguous owner that a trusted Personal Home bootstrap
 * may use for owner-managed defaults.
 *
 * An existing single active owner is authoritative even after other Accounts
 * have joined. With no owner, only the original one-active-Account topology may
 * claim itself through the canonical owner transition. Empty, multi-Account,
 * and multi-owner states require explicit recovery; startup never elects among
 * them. Keeping this decision beside owner assignment prevents every startup
 * consumer from reconstructing a subtly different "first Account" rule.
 */
export async function resolvePersonalHomeBootstrapOwnerInTx(
    tx: Tx,
    input: Readonly<{ runtimePurpose: string | null }>,
): Promise<PersonalHomeBootstrapOwnerResolution> {
    if (!isPersonalHomeRuntimePurpose(input.runtimePurpose)) return { status: "not_personal_home" };

    const activeOwners = await tx.account.findMany({
        where: { status: "active", homeRole: "owner" },
        select: { id: true },
        take: 2,
    });
    if (activeOwners.length === 1) return { status: "ready", ownerAccountId: activeOwners[0]!.id };
    if (activeOwners.length > 1) return { status: "setup_required" };

    const activeAccounts = await tx.account.findMany({
        where: { status: "active" },
        select: { id: true },
        take: 2,
    });
    if (activeAccounts.length !== 1) return { status: "setup_required" };

    const reconciled = await reconcilePersonalHomeInitialOwnerInTx(tx, {
        runtimePurpose: input.runtimePurpose,
        accountId: activeAccounts[0]!.id,
    });
    if (reconciled.status === "claimed") {
        return { status: "ready", ownerAccountId: reconciled.ownerAccountId };
    }
    // Every other result means the topology changed or cannot safely identify
    // one owner. The enclosing serializable transaction may be retried by its
    // existing owner; bootstrap must not guess a different Account.
    return reconciled.status === "not_personal_home"
        ? { status: "not_personal_home" }
        : { status: "setup_required" };
}
